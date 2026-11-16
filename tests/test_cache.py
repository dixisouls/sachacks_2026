"""The disk cache. Run: venv/bin/python -m pytest tests -q

One rule, and it is the one that was broken: a key returns the same thing every
time, whether this process wrote it, has already read it, or is seeing it for
the first time since a restart. A cache that answers differently depending on
which call came first is worse than no cache, because the second shape only
appears in production after a redeploy.
"""

import importlib
import json

import pytest

from api import cache as cache_module


@pytest.fixture
def cache(tmp_path, monkeypatch):
    """A fresh cache module over an empty directory, with nothing remembered."""
    monkeypatch.setenv("CACHE_DIR", str(tmp_path))
    fresh = importlib.reload(cache_module)
    yield fresh
    importlib.reload(cache_module)  # leave the real module as it was


def test_cold_and_warm_reads_agree(cache):
    value = {"items": [1, 2, 3], "note": "something fetched"}
    cache.put("pubmed", "baclofen|rett syndrome", value)

    # Cold: nothing in memory, so this comes off the disk.
    cache._memory.clear()
    cold = cache.get("pubmed", "baclofen|rett syndrome")
    # Warm: the same call again, now served from memory.
    warm = cache.get("pubmed", "baclofen|rett syndrome")

    assert cold == warm == value
    assert type(cold) is type(warm)


def test_the_envelope_never_reaches_the_caller(cache):
    cache.put("design", "k", {"job_id": "x"})
    cache._memory.clear()
    got = cache.get("design", "k")
    assert "key" not in got and "value" not in got
    # It is still on the disk, so a cache directory can be read by a human.
    path = cache._path("design", "k")
    assert json.loads(path.read_text())["key"] == "k"


def test_a_value_shaped_like_an_envelope_survives_a_round_trip(cache):
    """The envelope is recognised by its key, not by having a `value` field."""
    value = {"key": "something else", "value": "mine"}
    cache.put("brief", "k", value)
    cache._memory.clear()
    assert cache.get("brief", "k") == value


def test_a_missing_key_is_none_not_an_error(cache):
    assert cache.get("pubmed", "never fetched") is None


def test_an_empty_string_is_a_cached_miss_not_an_absence(cache):
    """api/naming.py caches "" to mean "PubChem has no title", and must be able
    to tell that apart from never having asked."""
    cache.put("names", "INCHIKEY", "")
    cache._memory.clear()
    assert cache.get("names", "INCHIKEY") == ""
    assert cache.get("names", "INCHIKEY") is not None


def test_unreadable_json_is_a_miss_rather_than_a_crash(cache):
    path = cache._path("pubmed", "k")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{ truncated")
    assert cache.get("pubmed", "k") is None
