from psycopg import connect
from psycopg.rows import dict_row

from config import Config


class FileStore:
    def __init__(self, cfg: Config):
        self._conn = connect(cfg.database_url, autocommit=True, row_factory=dict_row)

    def claim(self, file_id: str) -> bool:
        with self._conn.cursor() as cur:
            cur.execute(
                "UPDATE files SET status = 'processing', updated_at = now() "
                "WHERE id = %s AND status = 'uploaded'",
                (file_id,),
            )
            return cur.rowcount == 1

    def release(self, file_id: str) -> None:
        with self._conn.cursor() as cur:
            cur.execute(
                "UPDATE files SET status = 'uploaded', updated_at = now() "
                "WHERE id = %s AND status = 'processing'",
                (file_id,),
            )

    def mark_ready(self, file_id: str, thumbnail_key: str | None, checksum: str) -> None:
        with self._conn.cursor() as cur:
            cur.execute(
                "UPDATE files SET status = 'ready', thumbnail_key = %s, checksum = %s, "
                "updated_at = now() WHERE id = %s",
                (thumbnail_key, checksum, file_id),
            )

    def mark_infected(self, file_id: str) -> None:
        with self._conn.cursor() as cur:
            cur.execute(
                "UPDATE files SET status = 'infected', updated_at = now() WHERE id = %s",
                (file_id,),
            )

    def mark_failed(self, file_id: str) -> None:
        with self._conn.cursor() as cur:
            cur.execute(
                "UPDATE files SET status = 'failed', updated_at = now() "
                "WHERE id = %s AND status IN ('uploaded', 'processing')",
                (file_id,),
            )
