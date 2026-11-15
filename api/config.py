"""Settings, loaded from the environment with a .env file as a fallback.

.env is gitignored. Copy .env.example to .env and fill it in; see §11.3 of
architecture.md for what each variable does.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

log = logging.getLogger("repurposekg.config")

ROOT = Path(__file__).resolve().parents[1]
ENV_FILE = ROOT / ".env"


def load_env(path: Path = ENV_FILE) -> None:
    """Read KEY=value lines into the environment without overwriting what is already set.

    A real environment variable always wins, so hosting platforms keep control.
    """
    if not path.exists():
        return
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, raw_value = line.partition("=")
        key, value = key.strip(), raw_value.strip()

        # Drop an inline comment before anything else. .env.example ships lines like
        #     NCBI_API_KEY=            # raises the rate limit
        # and someone copying it to .env would otherwise send that comment to NCBI
        # as their API key, which is exactly what happened.
        if value.startswith("#"):
            value = ""
        elif " #" in value:
            value = value.split(" #")[0].strip()

        value = value.strip('"').strip("'").strip()
        if value and key not in os.environ:
            os.environ[key] = value


load_env()

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-pro")
ARTIFACT_DIR = Path(os.environ.get("ARTIFACT_DIR", ROOT / "artifacts"))
CACHE_DIR = Path(os.environ.get("CACHE_DIR", ROOT / "cache"))


def have_llm() -> bool:
    return bool(GEMINI_API_KEY)
