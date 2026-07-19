"""Boterdrop solver helpers (clearance + turnstile)."""
from __future__ import annotations

import time
from typing import Any

import requests as plain

from farm_env import BASE, SITEKEY, SOLVER
from hud import vlog


def solver_poll(task_id: str, timeout: float = 120) -> dict:
    t0 = time.time()
    while time.time() - t0 < timeout:
        r = plain.get(f"{SOLVER}/result", params={"id": task_id}, timeout=30)
        j = r.json() if "application/json" in (r.headers.get("content-type") or "") else {}
        st = j.get("status")
        if st == "success": return j
        if st == "error": raise RuntimeError(f"solver error: {j}")
        time.sleep(1.2)
    raise TimeoutError(f"solver timeout {task_id}")


def _wait_solver(kind: str, url: str, timeout: int = 90, proxy: str | None = None, **extra) -> dict:
    for attempt in range(40):
        params: dict[str, Any] = {"url": url, "timeout": timeout, **extra}
        if proxy: params["proxy"] = proxy
        r = plain.get(f"{SOLVER}/{kind}", params=params, timeout=30)
        j = r.json() if "application/json" in (r.headers.get("content-type") or "") else {}
        if j.get("task_id"): return solver_poll(j["task_id"], timeout=timeout + 30)
        vlog(f"[SOLVER] {kind} busy try={attempt + 1}")
        time.sleep(3)
    raise RuntimeError(f"solver {kind} unavailable")


def get_clearance(url: str = f"{BASE}/sign-up", proxy: str | None = None) -> dict:
    return _wait_solver("clearance", url, proxy=proxy)


def get_turnstile(url: str = f"{BASE}/sign-up", sitekey: str = SITEKEY, proxy: str | None = None) -> str:
    result = _wait_solver("turnstile", url, sitekey=sitekey, proxy=proxy)
    value = result.get("value") or result.get("token") or ""
    if not value: raise RuntimeError(f"turnstile no token: {result}")
    return value


# ── gRPC-Web protobuf ────────────────────────────────────────────────────────
