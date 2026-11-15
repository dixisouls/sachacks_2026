"""Locate (and if needed download) the OptimusKG parquet files.

Works on macOS, Linux and Windows. Search order:
  1. $OPTIMUSKG_DIR
  2. <repo>/data/
  3. the optimuskg package cache (macOS, Linux and Windows locations)
If nothing is found, downloads through the optimuskg client (with the
Harvard Dataverse User-Agent fix) and searches again.
"""

from __future__ import annotations

import os
from pathlib import Path

import polars as pl

ROOT = Path(__file__).resolve().parents[1]
NODES = "largest_connected_component_nodes.parquet"
EDGES = "largest_connected_component_edges.parquet"


def _candidate_dirs() -> list[Path]:
    dirs: list[Path] = []
    if os.environ.get("OPTIMUSKG_DIR"):
        dirs.append(Path(os.environ["OPTIMUSKG_DIR"]))
    dirs.append(ROOT / "data")

    home = Path.home()
    cache_roots = [
        home / "Library" / "Caches" / "optimuskg",  # macOS
        home / ".cache" / "optimuskg",  # Linux
    ]
    if os.environ.get("LOCALAPPDATA"):  # Windows
        local = Path(os.environ["LOCALAPPDATA"])
        cache_roots += [local / "optimuskg", local / "optimuskg" / "Cache"]
    for root in cache_roots:
        if root.exists():
            # newest version folder first
            found = sorted({p.parent for p in root.rglob(NODES)}, reverse=True)
            dirs.extend(found)
    return dirs


def find_files() -> tuple[Path, Path] | None:
    for d in _candidate_dirs():
        if (d / NODES).exists() and (d / EDGES).exists():
            return d / NODES, d / EDGES
    return None


def _patch_user_agent() -> None:
    import requests

    orig = requests.get

    def get_with_ua(*args, **kwargs):
        headers = kwargs.setdefault("headers", {})
        headers.setdefault("User-Agent", "Mozilla/5.0 repurposekg-hackathon")
        return orig(*args, **kwargs)

    requests.get = get_with_ua


def ensure_files() -> tuple[Path, Path]:
    found = find_files()
    if found:
        return found
    print("OptimusKG files not found locally, downloading (a few GB)...")
    _patch_user_agent()
    import optimuskg

    optimuskg.load_graph(lcc=True)
    found = find_files()
    if not found:
        raise SystemExit(
            "Downloaded, but could not locate the parquet files. Copy "
            f"{NODES} and {EDGES} into {ROOT / 'data'} or set OPTIMUSKG_DIR."
        )
    return found


def scan_graph() -> tuple[pl.LazyFrame, pl.LazyFrame]:
    nodes_path, edges_path = ensure_files()
    return pl.scan_parquet(nodes_path), pl.scan_parquet(edges_path)


if __name__ == "__main__":
    n, e = ensure_files()
    print("nodes:", n)
    print("edges:", e)
