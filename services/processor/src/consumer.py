import json
import uuid
from datetime import datetime, timezone

from confluent_kafka import Producer
from opentelemetry import trace

from config import Config
from db import FileStore
from log import get
from s3 import Storage
from scan import scan, sha256_hex
from thumbnail import make_thumbnail

logger = get("processor")
tracer = trace.get_tracer("processor")


class EventProcessingError(Exception):
    pass


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class Processor:
    def __init__(self, cfg: Config, store: FileStore, storage: Storage, producer: Producer):
        self._cfg = cfg
        self._store = store
        self._storage = storage
        self._producer = producer

    def handle(self, envelope: dict) -> dict:
        event_type = envelope.get("eventType")
        if event_type == "file.uploaded":
            return self._handle_uploaded(envelope)
        return {"outcome": "ignored", "eventType": event_type}

    def _handle_uploaded(self, envelope: dict) -> dict:
        payload = envelope["payload"]
        file_id = payload["fileId"]
        object_key = payload["objectKey"]
        content_type = payload["contentType"]
        owner_id = payload.get("ownerId")

        if not self._store.claim(file_id):
            logger.info(
                "duplicate or stale event skipped",
                extra={"ctx": {"fileId": file_id, "eventId": envelope.get("eventId")}},
            )
            return {"outcome": "skipped", "fileId": file_id}

        try:
            data = self._storage.get_upload(object_key)
            # Pure CPU work: no library span covers it, so time it by hand.
            with tracer.start_as_current_span("scan", attributes={"file.bytes": len(data)}) as span:
                verdict = scan(data)
                checksum = sha256_hex(data)
                span.set_attribute("scan.verdict", verdict)

            if verdict == "infected":
                self._storage.delete_upload(object_key)
                self._store.mark_infected(file_id)
                logger.warning(
                    "malware detected, object purged",
                    extra={"ctx": {"fileId": file_id}},
                )
                self._emit("file.rejected", file_id, {
                    "fileId": file_id,
                    "ownerId": owner_id,
                    "reason": "malware",
                })
                return {"outcome": "rejected", "fileId": file_id}

            thumbnail_key = None
            with tracer.start_as_current_span("thumbnail", attributes={"file.content_type": content_type}):
                thumb = make_thumbnail(data, content_type)
            if thumb is not None:
                thumbnail_key = f"{file_id}.webp"
                self._storage.put_thumbnail(thumbnail_key, thumb)

            self._store.mark_ready(file_id, thumbnail_key, checksum)
            logger.info(
                "file processed",
                extra={"ctx": {
                    "fileId": file_id,
                    "bytes": len(data),
                    "checksum": checksum,
                    "thumbnail": bool(thumb),
                }},
            )
            self._emit("file.ready", file_id, {
                "fileId": file_id,
                "ownerId": owner_id,
                "filename": payload.get("filename"),
                "thumbnailKey": thumbnail_key,
                "checksum": checksum,
            })
            return {"outcome": "ready", "fileId": file_id}
        except Exception as exc:
            self._store.release(file_id)
            raise EventProcessingError(str(exc)) from exc

    def handle_failure(self, envelope: dict, exc: Exception) -> None:
        attempt = int(envelope.get("attempt", 0)) + 1
        payload = envelope.get("payload", {})
        file_id = payload.get("fileId")
        aggregate_id = envelope.get("aggregateId", file_id)

        if attempt >= self._cfg.max_attempts:
            self._store.mark_failed(file_id)
            logger.error(
                "event moved to DLQ after max attempts",
                extra={"ctx": {"fileId": file_id, "attempt": attempt, "error": str(exc)}},
            )
            self._emit("file.failed", aggregate_id, {
                "fileId": file_id,
                "ownerId": payload.get("ownerId"),
                "error": str(exc),
            })
            dlq_message = {
                "eventId": str(uuid.uuid4()),
                "eventType": envelope.get("eventType"),
                "aggregateId": aggregate_id,
                "payload": payload,
                "attempt": attempt,
                "error": str(exc),
                "failedAt": _now_iso(),
            }
            self._producer.produce(
                self._cfg.topic_dlq,
                key=aggregate_id,
                value=json.dumps(dlq_message),
            )
            self._producer.flush(10)
        else:
            logger.warning(
                "event scheduled for retry",
                extra={"ctx": {"fileId": file_id, "attempt": attempt, "error": str(exc)}},
            )
            retry_envelope = dict(envelope)
            retry_envelope["attempt"] = attempt
            self._producer.produce(
                self._cfg.topic_retry,
                key=aggregate_id,
                value=json.dumps(retry_envelope),
            )
            self._producer.flush(10)

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
            self._producer.produce(
                self._cfg.topic_retry,
                key=file_id,
                value=json.dumps({
                    "eventId": str(uuid.uuid4()),
                    "eventType": "file.uploaded",
                    "aggregateId": file_id,
                    "occurredAt": _now_iso(),
                    "payload": {
                        "fileId": file_id,
                        "objectKey": row["object_key"],
                        "ownerId": row["owner_id"],
                        "filename": row["filename"],
                        "contentType": row["content_type"],
                        "sizeBytes": row["size_bytes"],
                    },
                }),
            )
        self._producer.flush(10)

    def _emit(self, event_type: str, aggregate_id: str, payload: dict) -> None:
        envelope = {
            "eventId": str(uuid.uuid4()),
            "eventType": event_type,
            "aggregateId": aggregate_id,
            "occurredAt": _now_iso(),
            "payload": payload,
        }
        self._producer.produce(
            self._cfg.topic_main,
            key=aggregate_id,
            value=json.dumps(envelope),
        )
        self._producer.flush(10)
