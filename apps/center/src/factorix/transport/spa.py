"""Static SPA helpers (gzip cache). Moved verbatim from ``factorix.transport.app`` (R2-E B2, move-only)."""

from __future__ import annotations

import functools
import gzip
from pathlib import Path


_GZIP_SUFFIXES = {".js", ".mjs", ".css", ".svg", ".json", ".map", ".txt"}


@functools.lru_cache(maxsize=64)
def _gzipped(path: str, mtime_ns: int) -> bytes | None:
    """Gzip a static text asset once per (path, mtime); None for tiny files not worth compressing."""
    del mtime_ns  # part of the cache key only
    data = Path(path).read_bytes()
    if len(data) < 1024:
        return None
    return gzip.compress(data, compresslevel=6)
