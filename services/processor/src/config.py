import os
from dataclasses import dataclass


def _required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


@dataclass(frozen=True)
class Config:
    database_url: str
    kafka_brokers: str
    s3_endpoint: str
    s3_access_key: str
    s3_secret_key: str
    s3_uploads_bucket: str
    s3_thumbnails_bucket: str
    topic_main: str
    topic_retry: str
    topic_dlq: str
    max_attempts: int = 3
    # Must exceed the slowest legitimate job, or a live worker's claim gets reaped.
    claim_lease_seconds: int = 120
    reap_interval_seconds: int = 30


def load() -> Config:
    return Config(
        database_url=_required("DATABASE_URL"),
        kafka_brokers=_required("KAFKA_BROKERS"),
        s3_endpoint=_required("S3_ENDPOINT"),
        s3_access_key=_required("S3_ACCESS_KEY"),
        s3_secret_key=_required("S3_SECRET_KEY"),
        s3_uploads_bucket=os.environ.get("S3_UPLOADS_BUCKET", "media-uploads"),
        s3_thumbnails_bucket=os.environ.get("S3_THUMBNAILS_BUCKET", "media-thumbnails"),
        topic_main=os.environ.get("TOPIC_MAIN", "file-events"),
        topic_retry=os.environ.get("TOPIC_RETRY", "file-events-retry"),
        topic_dlq=os.environ.get("TOPIC_DLQ", "file-events-dlq"),
    )
