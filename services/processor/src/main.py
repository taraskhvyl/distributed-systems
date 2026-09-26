import json
import time

from confluent_kafka import Consumer, KafkaError, KafkaException, Message, Producer
from opentelemetry import propagate, trace
from opentelemetry.context import Context
from opentelemetry.trace import SpanKind

from config import load
from consumer import EventProcessingError, Processor
from db import FileStore
from log import get, setup
from s3 import Storage

logger = get("main")
tracer = trace.get_tracer("processor")


def _producer_trace_context(msg: Message) -> Context:
    """The trace the message was produced in, read from its `traceparent` header.

    The confluent-kafka instrumentation starts a NEW trace per poll and only links to the
    producer (a poll can return messages from many traces). We handle one message at a
    time, so we continue the producer's trace instead: upload -> processor is one trace.
    """
    headers = {key: value.decode() for key, value in (msg.headers() or []) if value is not None}
    return propagate.extract(headers)


def main() -> None:
    setup()
    cfg = load()

    store = FileStore(cfg)
    storage = Storage(cfg)
    producer = Producer({"bootstrap.servers": cfg.kafka_brokers})
    processor = Processor(cfg, store, storage, producer)

    consumer = Consumer({
        "bootstrap.servers": cfg.kafka_brokers,
        "group.id": "processor",
        "enable.auto.commit": False,
        "auto.offset.reset": "earliest",
        "session.timeout.ms": 30000,
    })
    consumer.subscribe([cfg.topic_main, cfg.topic_retry])
    logger.info(
        "processor started",
        extra={"ctx": {
            "groupId": "processor",
            "topics": [cfg.topic_main, cfg.topic_retry],
            "dlq": cfg.topic_dlq,
        }},
    )

    next_reap = 0.0
    try:
        while True:
            if time.monotonic() >= next_reap:
                try:
                    processor.reap_expired_claims()
                except Exception:
                    logger.exception("claim reaper failed, will retry next interval")
                next_reap = time.monotonic() + cfg.reap_interval_seconds

            msg = consumer.poll(1.0)
            if msg is None:
                continue
            if msg.error():
                code = msg.error().code()
                if code == KafkaError._PARTITION_EOF:
                    continue
                if code in (KafkaError._TRANSPORT, KafkaError._ALL_BROKERS_DOWN, KafkaError.UNKNOWN_TOPIC_OR_PART):
                    logger.warning("kafka transient issue, poll will retry", extra={"ctx": {"code": str(msg.error())}})
                    continue
                raise KafkaException(msg.error())
            if msg.value() is None:
                consumer.commit(message=msg, asynchronous=False)
                continue

            try:
                envelope = json.loads(msg.value())
            except (json.JSONDecodeError, UnicodeDecodeError):
                logger.error(
                    "poison message dropped",
                    extra={"ctx": {"topic": msg.topic(), "partition": msg.partition()}},
                )
                consumer.commit(message=msg, asynchronous=False)
                continue

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
                    logger.exception("unexpected handler error")

            consumer.commit(message=msg, asynchronous=False)
    except KeyboardInterrupt:
        logger.info("processor shutting down")
    finally:
        consumer.close()


if __name__ == "__main__":
    main()
