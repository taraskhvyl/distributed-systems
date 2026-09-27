from confluent_kafka import Consumer, Producer

import kafka_loop
from adapters.db import FileStore
from adapters.events import EventPublisher
from adapters.s3 import Storage
from config import load
from log import get, setup
from pipeline.handler import Processor

logger = get("main")

CONSUMER_GROUP = "processor"
SESSION_TIMEOUT_MS = 30_000


def main() -> None:
    """Composition root: builds the parts, connects them, runs the loop. No logic."""
    setup()
    cfg = load()

    events = EventPublisher(cfg, Producer({"bootstrap.servers": cfg.kafka_brokers}))
    processor = Processor(cfg, FileStore(cfg), Storage(cfg), events)

    consumer = Consumer({
        "bootstrap.servers": cfg.kafka_brokers,
        "group.id": CONSUMER_GROUP,
        "enable.auto.commit": False,  # we commit after handling: at-least-once
        "auto.offset.reset": "earliest",
        "session.timeout.ms": SESSION_TIMEOUT_MS,
    })
    consumer.subscribe(
        [cfg.topic_main, cfg.topic_retry],
        on_assign=kafka_loop.log_assignment,
        on_revoke=kafka_loop.log_revocation,
    )
    logger.info(
        "processor started",
        extra={"ctx": {
            "groupId": CONSUMER_GROUP,
            "topics": [cfg.topic_main, cfg.topic_retry],
            "dlq": cfg.topic_dlq,
        }},
    )

    try:
        kafka_loop.run(consumer, processor, cfg)
    except KeyboardInterrupt:
        logger.info("processor shutting down")
    finally:
        consumer.close()


if __name__ == "__main__":
    main()
