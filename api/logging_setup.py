"""Logging for the backend.

Every log line carries a short request id so one judge's click can be followed
end to end, and every request logs how long it took and what work it did
(how many candidates, which paths, whether a cache was hit).

Set LOG_LEVEL=DEBUG for the per-step detail, LOG_FORMAT=json for machine-readable
output when hosted.
"""

from __future__ import annotations

import contextvars
import json
import logging
import os
import sys
import time
import uuid
from contextlib import contextmanager

request_id: contextvars.ContextVar[str] = contextvars.ContextVar("request_id", default="-")


class RequestIdFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = request_id.get()
        return True


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(record.created)),
            "level": record.levelname,
            "logger": record.name,
            "request_id": getattr(record, "request_id", "-"),
            "message": record.getMessage(),
        }
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        for key, value in getattr(record, "extra_fields", {}).items():
            payload[key] = value
        return json.dumps(payload)


def setup_logging() -> None:
    level = os.environ.get("LOG_LEVEL", "INFO").upper()
    handler = logging.StreamHandler(sys.stdout)
    handler.addFilter(RequestIdFilter())
    if os.environ.get("LOG_FORMAT", "").lower() == "json":
        handler.setFormatter(JsonFormatter())
    else:
        handler.setFormatter(logging.Formatter(
            "%(asctime)s %(levelname)-5s [%(request_id)s] %(name)s: %(message)s",
            datefmt="%H:%M:%S"))

    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level)
    # uvicorn's own access log duplicates our request line, so turn it off
    logging.getLogger("uvicorn.access").disabled = True
    logging.getLogger("uvicorn.error").setLevel(logging.WARNING)


def new_request_id() -> str:
    return uuid.uuid4().hex[:8]


@contextmanager
def timed(logger: logging.Logger, what: str, level: int = logging.DEBUG, **fields):
    """Log how long a step took, and anything the step wants to report.

        with timed(log, "score disease", disease=disease_id) as step:
            ...
            step["candidates"] = 42
    """
    started = time.perf_counter()
    reported: dict = dict(fields)
    try:
        yield reported
    finally:
        ms = (time.perf_counter() - started) * 1000
        reported["ms"] = round(ms, 1)
        detail = " ".join(f"{k}={v}" for k, v in reported.items())
        logger.log(level, f"{what}: {detail}", extra={"extra_fields": reported})
