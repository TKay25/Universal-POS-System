"""Tiny in-process TTL cache.

Reports and PDFs are expensive to build (many aggregate queries + layout) and
are requested repeatedly — once to look at, again to download. A short TTL
keeps repeat downloads instant without letting data get stale.

The cache is per-process, bounded, and safe to clear at any time.
"""

from __future__ import annotations

import threading
import time

_MAX_ENTRIES = 256
_store: dict[str, tuple[float, object]] = {}
_lock = threading.Lock()


def get(key: str):
    now = time.monotonic()
    with _lock:
        hit = _store.get(key)
        if hit is None:
            return None
        expires_at, value = hit
        if expires_at < now:
            _store.pop(key, None)
            return None
        return value


def set(key: str, value, ttl: float) -> None:  # noqa: A001 - mirrors dict API
    if ttl <= 0:
        return
    with _lock:
        if len(_store) >= _MAX_ENTRIES:
            # Drop the entries closest to expiring first.
            for stale in sorted(_store, key=lambda item: _store[item][0])[: _MAX_ENTRIES // 4]:
                _store.pop(stale, None)
        _store[key] = (time.monotonic() + ttl, value)


def get_or_set(key: str, ttl: float, factory):
    cached = get(key)
    if cached is not None:
        return cached
    value = factory()
    set(key, value, ttl)
    return value


def clear() -> None:
    with _lock:
        _store.clear()


def stats() -> dict:
    with _lock:
        return {"entries": len(_store), "max": _MAX_ENTRIES}
