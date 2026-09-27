import json
import logging
import sys
import time


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        ts = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created))
        payload = {
            "ts": f"{ts}.{int(record.msecs):03d}Z",
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        # Set by opentelemetry-instrumentation-logging (OTEL_PYTHON_LOG_CORRELATION);
        # "0" means the line was logged outside any span.
        trace_id = getattr(record, "otelTraceID", "0")
        if trace_id != "0":
            payload["trace_id"] = trace_id
        ctx = getattr(record, "ctx", None)
        if ctx:
            payload.update(ctx)
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload)


def setup() -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    # Replace only the plain stdout/stderr handlers. Keep OpenTelemetry's LoggingHandler
    # (not a StreamHandler): it ships every log record to Loki.
    root.handlers = [h for h in root.handlers if not isinstance(h, logging.StreamHandler)]
    root.addHandler(handler)
    root.setLevel(logging.INFO)


def get(name: str) -> logging.Logger:
    return logging.getLogger(name)
