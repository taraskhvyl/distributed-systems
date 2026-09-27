import boto3
from botocore.config import Config as BotoConfig

from config import Config as AppConfig


class Storage:
    def __init__(self, cfg: AppConfig):
        self._uploads_bucket = cfg.s3_uploads_bucket
        self._thumbnails_bucket = cfg.s3_thumbnails_bucket
        self._client = boto3.client(
            "s3",
            endpoint_url=cfg.s3_endpoint,
            aws_access_key_id=cfg.s3_access_key,
            aws_secret_access_key=cfg.s3_secret_key,
            region_name="us-east-1",
            config=BotoConfig(
                s3={"addressing_style": "path"},
                retries={"max_attempts": 3, "mode": "standard"},
            ),
        )

    def get_upload(self, key: str) -> bytes:
        obj = self._client.get_object(Bucket=self._uploads_bucket, Key=key)
        return obj["Body"].read()

    def put_thumbnail(self, key: str, data: bytes) -> None:
        self._client.put_object(
            Bucket=self._thumbnails_bucket,
            Key=key,
            Body=data,
            ContentType="image/webp",
        )

    def delete_upload(self, key: str) -> None:
        self._client.delete_object(Bucket=self._uploads_bucket, Key=key)
