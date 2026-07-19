"""Proxy pool load + thread-safe round-robin rotation for http_farm."""
from __future__ import annotations

import random
import threading
from pathlib import Path


def normalize_proxy_url(raw: str) -> str | None:
    s = (raw or "").strip()
    if not s:
        return None
    if (s.startswith('"') and s.endswith('"')) or (s.startswith("'") and s.endswith("'")):
        s = s[1:-1].strip()
    if not s:
        return None
    if "://" in s:
        return s
    parts = s.split(":")
    if len(parts) >= 4 and parts[1].isdigit() and "@" not in parts[0]:
        host, port, user = parts[0], parts[1], parts[2]
        password = ":".join(parts[3:])
        if host and user:
            return f"http://{user}:{password}@{host}:{port}"
    if "@" in s:
        return f"http://{s}"
    if len(parts) == 2 and parts[1].isdigit():
        return f"http://{parts[0]}:{parts[1]}"
    return None


def load_proxy_pool(
    proxy_file: Path,
    *,
    shuffle: bool = False,
) -> tuple[list[str], str]:
    if not proxy_file.is_file():
        return [], "direct (no proxy file)"
    pool: list[str] = []
    for line in open(proxy_file, encoding="utf-8", errors="replace"):
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        u = normalize_proxy_url(s)
        if u:
            pool.append(u)
    desc = f"file:{proxy_file} ({len(pool)})"
    if pool and shuffle:
        random.shuffle(pool)
        desc += " shuffled"
    return pool, desc


def pick_proxy_from_pool(
    pool: list[str],
    idx: int,
    exclude: set[str] | None = None,
    pinned: str | None = None,
) -> tuple[str | None, int]:
    """Pure round-robin pick. Returns (proxy_or_none, next_idx).

    - pinned wins when set
    - empty pool → (None, idx)
    - exclude skips those URLs until pool exhausted, then falls back to full pool
    """
    if pinned:
        return pinned, idx
    if not pool:
        return None, idx
    exclude = exclude or set()
    n = len(pool)
    start = idx
    for step in range(n):
        i = (start + step) % n
        p = pool[i]
        if p not in exclude:
            return p, start + step + 1
    # All excluded — still rotate so concurrent workers diverge.
    i = start % n
    return pool[i], start + 1


class ProxyRotator:
    """Thread-safe rotating proxy selector over a fixed pool."""

    def __init__(self, pool: list[str], pinned: str | None = None) -> None:
        self.pool = list(pool)
        self.pinned = (pinned or "").strip() or None
        self._idx = 0
        self._lock = threading.Lock()

    def pick(self, exclude: set[str] | None = None) -> str | None:
        with self._lock:
            proxy, self._idx = pick_proxy_from_pool(
                self.pool, self._idx, exclude=exclude, pinned=self.pinned
            )
            return proxy
