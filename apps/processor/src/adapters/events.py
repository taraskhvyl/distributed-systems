import json
import uuid
from datetime import datetime, timezone

from confluent_kafka import Producer

from config import Config

FLUSH_TIMEOUT_SECONDS = 10


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_envelope(event_type: str, aggregate_id: str, payload: dict) -> dict:
    """The event format every service reads (see the notifier's events.ts)."""
    return {
        "eventId": str(uuid.uuid4()),
        "eventType": event_type,
        "aggregateId": aggregate_id,
        "occurredAt": now_iso(),
        "payload": payload,
    }


class EventPublisher:
    """Adapter around the Kafka producer: every message the processor writes goes through here.

    Messages are produced inside the caller's span, so the confluent-kafka instrumentation
    puts that trace in the headers: a retry or DLQ message continues the same trace.
    Sends are synchronous (flush): the offset is committed only after they succeed.
    """

    def __init__(self, cfg: Config, producer: Producer):
        self._cfg = cfg
        self._producer = producer

    def emit(self, event_type: str, aggregate_id: str, payload: dict) -> None:
        """A new domain event (file.ready, file.rejected, ...) for the other services."""
        self._send(self._cfg.topic_main, aggregate_id, new_envelope(event_type, aggregate_id, payload))

    def send_to_retry(self, aggregate_id: str, envelope: dict) -> None:
        self._send(self._cfg.topic_retry, aggregate_id, envelope)

    def send_to_dlq(self, aggregate_id: str, message: dict) -> None:
        self._send(self._cfg.topic_dlq, aggregate_id, message)

    def _send(self, topic: str, key: str, message: dict) -> None:
        # The key is the file id, so all events of one file stay in one partition, in order.
        self._producer.produce(topic, key=key, value=json.dumps(message))
        self._producer.flush(FLUSH_TIMEOUT_SECONDS)
