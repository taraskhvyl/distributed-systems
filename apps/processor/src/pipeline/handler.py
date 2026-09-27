import uuid

from opentelemetry import trace

from adapters.db import FileStore
from adapters.events import EventPublisher, new_envelope, now_iso
from adapters.s3 import Storage
from config import Config
from log import get
from pipeline.scan import scan, sha256_hex
from pipeline.thumbnail import make_thumbnail

logger = get("processor")
tracer = trace.get_tracer("processor")


class EventProcessingError(Exception):
    """Processing failed in a way a retry may fix (storage down, bad bytes, ...)."""


class Processor:
    """What happens to one event. Knows nothing about polling or offsets (kafka_loop.py)."""

    def __init__(self, cfg: Config, store: FileStore, storage: Storage, events: EventPublisher):
        self._cfg = cfg
        self._store = store
        self._storage = storage
        self._events = events

    def handle(self, envelope: dict) -> dict:
        event_type = envelope.get("eventType")
        if event_type == "file.uploaded":
            return self._handle_uploaded(envelope)
        return {"outcome": "ignored", "eventType": event_type}

    def _handle_uploaded(self, envelope: dict) -> dict:
        payload = envelope["payload"]
        file_id = payload["fileId"]

        # The claim is the idempotency guard: a duplicate delivery finds the file already
        # claimed (or done) and is skipped, so a file is never processed twice at once.
        if not self._store.claim(file_id):
            logger.info(
                "duplicate or stale event skipped",
                extra={"ctx": {"fileId": file_id, "eventId": envelope.get("eventId")}},
            )
            return {"outcome": "skipped", "fileId": file_id}

        try:
            return self._process(payload)
        except Exception as exc:
            self._store.release(file_id)
            raise EventProcessingError(str(exc)) from exc

    def _process(self, payload: dict) -> dict:
        file_id = payload["fileId"]
        object_key = payload["objectKey"]
        owner_id = payload.get("ownerId")

        data = self._storage.get_upload(object_key)
        # Pure CPU work: no library span covers it, so time it by hand.
        with tracer.start_as_current_span("scan", attributes={"file.bytes": len(data)}) as span:
            verdict = scan(data)
            checksum = sha256_hex(data)
            span.set_attribute("scan.verdict", verdict)

        if verdict == "infected":
            self._reject_infected(file_id, object_key, owner_id)
            return {"outcome": "rejected", "fileId": file_id}

        thumbnail_key = self._store_thumbnail(file_id, data, payload["contentType"])
        self._store.mark_ready(file_id, thumbnail_key, checksum)
        logger.info(
            "file processed",
            extra={"ctx": {
                "fileId": file_id,
                "bytes": len(data),
                "checksum": checksum,
                "thumbnail": thumbnail_key is not None,
            }},
        )
        self._events.emit("file.ready", file_id, {
            "fileId": file_id,
            "ownerId": owner_id,
            "filename": payload.get("filename"),
            "thumbnailKey": thumbnail_key,
            "checksum": checksum,
        })
        return {"outcome": "ready", "fileId": file_id}

    def _reject_infected(self, file_id: str, object_key: str, owner_id: str | None) -> None:
        self._storage.delete_upload(object_key)
        self._store.mark_infected(file_id)
        logger.warning("malware detected, object purged", extra={"ctx": {"fileId": file_id}})
        self._events.emit("file.rejected", file_id, {
            "fileId": file_id,
            "ownerId": owner_id,
            "reason": "malware",
        })

    def _store_thumbnail(self, file_id: str, data: bytes, content_type: str) -> str | None:
        """The thumbnail's key, or None for types that have no thumbnail (pdf, text)."""
        with tracer.start_as_current_span("thumbnail", attributes={"file.content_type": content_type}):
            thumb = make_thumbnail(data, content_type)
        if thumb is None:
            return None
        thumbnail_key = f"{file_id}.webp"
        self._storage.put_thumbnail(thumbnail_key, thumb)
        return thumbnail_key

    def handle_failure(self, envelope: dict, exc: Exception) -> None:
        """Retry topic until max_attempts, then DLQ + `failed`. Retries have no delay yet
        (roadmap Phase 4, "Retry backoff")."""
        attempt = int(envelope.get("attempt", 0)) + 1
        payload = envelope.get("payload", {})
        file_id = payload.get("fileId")
        aggregate_id = envelope.get("aggregateId", file_id)

        if attempt < self._cfg.max_attempts:
            logger.warning(
                "event scheduled for retry",
                extra={"ctx": {"fileId": file_id, "attempt": attempt, "error": str(exc)}},
            )
            self._events.send_to_retry(aggregate_id, {**envelope, "attempt": attempt})
            return

        self._store.mark_failed(file_id)
        logger.error(
            "event moved to DLQ after max attempts",
            extra={"ctx": {"fileId": file_id, "attempt": attempt, "error": str(exc)}},
        )
        self._events.emit("file.failed", aggregate_id, {
            "fileId": file_id,
            "ownerId": payload.get("ownerId"),
            "error": str(exc),
        })
        self._events.send_to_dlq(aggregate_id, {
            "eventId": str(uuid.uuid4()),
            "eventType": envelope.get("eventType"),
            "aggregateId": aggregate_id,
            "payload": payload,
            "attempt": attempt,
            "error": str(exc),
            "failedAt": now_iso(),
        })

    def reap_expired_claims(self) -> None:
        # Kafka redelivery alone can't recover a crashed claim: the redelivered event
        # arrives while the lease is still live, gets skipped, and its offset is committed.
        # So once the lease expires we re-enqueue the work ourselves, on the retry topic
        # (processor-only; the notifier never sees a duplicate file.uploaded).
        # ponytail: a file that crashes the worker every time is re-queued forever;
        # add an attempts column and route to the DLQ if that shows up.
        for row in self._store.reap_expired(self._cfg.claim_lease_seconds):
            file_id = str(row["id"])
            logger.warning("expired claim reaped, re-enqueued", extra={"ctx": {"fileId": file_id}})
            self._events.send_to_retry(file_id, new_envelope("file.uploaded", file_id, {
                "fileId": file_id,
                "objectKey": row["object_key"],
                "ownerId": row["owner_id"],
                "filename": row["filename"],
                "contentType": row["content_type"],
                "sizeBytes": row["size_bytes"],
            }))
