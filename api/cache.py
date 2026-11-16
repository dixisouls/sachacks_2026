"""Disk cache for external lookups.

Judging is live, so the demo must not depend on PubMed or ClinicalTrials.gov
answering quickly on the night. Everything fetched is written to cache/ as JSON
and reused forever (no expiry during the event); scripts/prewarm.py fills it in
advance for the demo diseases.

Keys are hashed, so a drug or disease name never becomes a filename.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
from pathlib import Path
from typing import Any

log = logging.getLogger("repurposekg.cache")

ROOT = Path(__file__).resolve().parents[1]
CACHE_DIR = Path(os.environ.get("CACHE_DIR", ROOT / "cache"))

_memory: dict[str, Any] = {}
_lock = threading.Lock()


def _path(source: str, key: str) -> Path:
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:20]
    return CACHE_DIR / source / f"{digest}.json"


def get(source: str, key: str) -> Any | None:
    """The cached value, or None if nothing is cached under this key.

    The same key returns the same thing whether or not this process has already
    read it. That is worth stating because it was not true: the envelope written
    to disk was handed back unopened on a cold read and put into memory as well,
    so a caller saw the value or the envelope depending only on which call came
    first. The envelope is an on-disk detail -- it carries the un-hashed key
    beside the hashed filename, so a cache directory can be read by a human --
    and it is opened here, once, where it is written.
    """
    slot = f"{source}:{key}"
    with _lock:
        if slot in _memory:
            return _memory[slot]
    path = _path(source, key)
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError) as exc:
        log.warning("cache read failed for %s, ignoring: %s", path.name, exc)
        return None
    value = payload["value"] if _is_envelope(payload, key) else payload
    with _lock:
        _memory[slot] = value
    return value


def _is_envelope(payload: Any, key: str) -> bool:
    """Whether this is a file put() wrote, rather than a value that looks like one.

    A cached value may itself be a dict with a `value` field, so the shape alone
    is not enough: the envelope is recognised by carrying back the exact key it
    was asked for.
    """
    return isinstance(payload, dict) and payload.get("key") == key and "value" in payload


def put(source: str, key: str, value: Any) -> None:
    with _lock:
        _memory[f"{source}:{key}"] = value
    path = _path(source, key)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"key": key, "value": value}, indent=1))
        tmp.replace(path)
    except OSError as exc:  # a read-only disk must not break a request
        log.warning("cache write failed for %s: %s", path.name, exc)


def stats() -> dict:
    counts = {}
    if CACHE_DIR.exists():
        for sub in CACHE_DIR.iterdir():
            if sub.is_dir():
                counts[sub.name] = len(list(sub.glob("*.json")))
    return {"dir": str(CACHE_DIR), "entries_on_disk": counts, "entries_in_memory": len(_memory)}
