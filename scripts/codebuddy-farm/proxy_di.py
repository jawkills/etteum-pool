"""DataImpulse sticky residential proxy helpers."""
from __future__ import annotations

import random
import string
from typing import Any
from urllib.parse import unquote, urlparse

from farm_env import DI_COUNTRIES, DI_HOST, DI_LOGIN, DI_PASSWORD, DI_SESSTTL, GH_PROXY


def _parse_proxy_url(url: str) -> dict[str, Any]:
    u = urlparse(url)
    return {
        "user": unquote(u.username or ""),
        "password": unquote(u.password or ""),
        "host": u.hostname or "",
        "port": u.port or 823,
        "scheme": u.scheme or "http",
    }


def build_sticky_proxy(
    country: str | None = None,
    sessid: str | None = None,
    base: str | None = None,
) -> dict[str, Any]:
    """Return {url, country, sessid, host, sticky} for one sticky session.

    Format (proven):
      http://{login}__cr.{cc};sessid.{sid};sessttl.{ttl}:{password}@gw.dataimpulse.com:823
    """
    country = (country or random.choice(DI_COUNTRIES or ["sg"])).lower()
    sessid = sessid or (
        "cb" + "".join(random.choices(string.ascii_lowercase + string.digits, k=10))
    )
    base = (base if base is not None else GH_PROXY) or ""

    login = DI_LOGIN
    password = DI_PASSWORD
    hostport = DI_HOST

    if base and "://" in base:
        parts = _parse_proxy_url(base)
        password = password or parts["password"]
        if parts["host"]:
            hostport = f"{parts['host']}:{parts['port']}"
        raw_user = parts["user"]
        if "__cr." in raw_user:
            login = raw_user.split("__cr.")[0]
        elif raw_user:
            login = raw_user.split(";")[0].split("_session-")[0]
        if not login and DI_LOGIN:
            login = DI_LOGIN

    if not login or not password:
        if base:
            return {
                "url": base,
                "country": country,
                "sessid": sessid,
                "host": hostport,
                "sticky": False,
            }
        return {
            "url": "",
            "country": country,
            "sessid": sessid,
            "host": hostport,
            "sticky": False,
        }

    user = f"{login}__cr.{country};sessid.{sessid};sessttl.{DI_SESSTTL}"
    url = f"http://{user}:{password}@{hostport}"
    return {
        "url": url,
        "country": country,
        "sessid": sessid,
        "host": hostport,
        "sticky": True,
        "user": user,
    }


def probe_proxy_ip(proxy_url: str, timeout: float = 20) -> str:
    if not proxy_url:
        return ""
    try:
        from curl_cffi import requests as creq

        s = creq.Session(impersonate="chrome131")
        s.proxies = {"http": proxy_url, "https": proxy_url}
        for url in (
            "https://api.ipify.org?format=json",
            "https://httpbin.org/ip",
        ):
            try:
                r = s.get(url, timeout=timeout)
                data = r.json()
                return str(data.get("ip") or data.get("origin") or "").split(",")[0].strip()
            except Exception:
                continue
    except Exception:
        return ""
    return ""
