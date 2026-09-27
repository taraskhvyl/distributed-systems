import json
import time

from confluent_kafka import Consumer, KafkaError, KafkaException, Message
from opentelemetry import propagate, trace
from opentelemetry.context import Context
from opentelemetry.trace import SpanKind

from config import Config
from log import get
from pipeline.handler import EventProcessingError, Processor

logger = get("kafka_loop")
tracer = trace.get_tracer("processor")

POLL_TIMEOUT_SECONDS = 1.0
TRANSIENT_ERRORS = (KafkaError._TRANSPORT, KafkaError._ALL_BROKERS_DOWN, KafkaError.UNKNOWN_TOPIC_OR_PART)


def run(consumer: Consumer, processor: Processor, cfg: Config) -> None:
    """Poll → handle → commit, one message at a time, forever.

    At-least-once: the offset is committed only after the message was handled (or sent to
    retry/DLQ). A crash in between redelivers it; the claim in the handler absorbs the
    duplicate. The claim reaper runs on the same thread between polls.
    """
    next_reap = 0.0
    while True:
        if time.monotonic() >= next_reap:
            _reap(processor)
            next_reap = time.monotonic() + cfg.reap_interval_seconds

        msg = consumer.poll(POLL_TIMEOUT_SECONDS)
        if msg is None:
            continue
        if msg.error():
            _raise_unless_transient(msg)
            continue
        _handle_message(msg, processor)
        consumer.commit(message=msg, asynchronous=False)


def _reap(processor: Processor) -> None:
    try:
        processor.reap_expired_claims()
    except Exception:
        logger.exception("claim reaper failed, will retry next interval")


def _raise_unless_transient(msg: Message) -> None:
    code = msg.error().code()
    if code == KafkaError._PARTITION_EOF:
        return
    if code in TRANSIENT_ERRORS:
        logger.warning("kafka transient issue, poll will retry", extra={"ctx": {"code": str(msg.error())}})
        return
    raise KafkaException(msg.error())


def _handle_message(msg: Message, processor: Processor) -> None:
    """Handles one message. Never raises: whatever happens, the caller commits the offset."""
    if msg.value() is None:
        return
    try:
        envelope = json.loads(msg.value())
    except (json.JSONDecodeError, UnicodeDecodeError):
        logger.error("poison message dropped", extra={"ctx": {"topic": msg.topic(), "partition": msg.partition()}})
        return

    # Retry/DLQ messages produced inside this span carry it on, so a retry
    # continues the same trace.
    with tracer.start_as_current_span(
        f"handle {envelope.get('eventType')}",
        context=_producer_trace_context(msg),
        kind=SpanKind.CONSUMER,
    ):
        try:
            result = processor.handle(envelope)
            logger.info(
                "event handled",
                extra={"ctx": {
                    "eventId": envelope.get("eventId"),
                    "eventType": envelope.get("eventType"),
                    "topic": msg.topic(),
                    "partition": msg.partition(),
                    "offset": msg.offset(),
                    "result": result,
                }},
            )
        except EventProcessingError as exc:
            processor.handle_failure(envelope, exc)
        except Exception:
            # ponytail: the offset is still committed, so this class of error is at-most-once
            # (roadmap Phase 4, "Poison pill").
            logger.exception("unexpected handler error")


def _producer_trace_context(msg: Message) -> Context:
    """The trace the message was produced in, read from its `traceparent` header.

    The confluent-kafka instrumentation starts a NEW trace per poll and only links to the
    producer (a poll can return messages from many traces). We handle one message at a
    time, so we continue the producer's trace instead: upload -> processor is one trace.
    """
    headers = {key: value.decode() for key, value in (msg.headers() or []) if value is not None}
    return propagate.extract(headers)
