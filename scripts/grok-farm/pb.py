"""Minimal protobuf / gRPC-Web helpers for xAI auth RPCs."""
from __future__ import annotations

import re
from typing import Any


def _varint(n: int) -> bytes:
    out = bytearray()
    while n > 0x7F:
        out.append((n & 0x7F) | 0x80)
        n >>= 7
    out.append(n & 0x7F)
    return bytes(out)


def _key(field: int, wire: int) -> bytes:
    return _varint((field << 3) | wire)


def pb_str(field: int, value: str) -> bytes:
    b = value.encode("utf-8")
    return _key(field, 2) + _varint(len(b)) + b


def pb_msg(field: int, value: bytes) -> bytes:
    return _key(field, 2) + _varint(len(value)) + value


def pb_varint(field: int, value: int) -> bytes:
    return _key(field, 0) + _varint(value)


def grpc_web_frame(msg: bytes) -> bytes:
    return b"\x00" + len(msg).to_bytes(4, "big") + msg


def parse_grpc_web(data: bytes) -> dict[str, Any]:
    out: dict[str, Any] = {"frames": [], "trailers": {}, "raw": data}
    i = 0
    while i + 5 <= len(data):
        flags = data[i]
        ln = int.from_bytes(data[i + 1: i + 5], "big")
        i += 5
        payload = data[i: i + ln]
        i += ln
        if flags & 0x80:
            for line in payload.decode("utf-8", "replace").split("\r\n"):
                if ":" in line:
                    k, _, v = line.partition(":")
                    out["trailers"][k.strip()] = v.strip()
        else:
            out["frames"].append(payload)
    return out


def parse_pb_fields(data: bytes) -> list[tuple]:
    i = 0
    out = []
    while i < len(data):
        key = 0; shift = 0
        while i < len(data):
            b = data[i]; i += 1
            key |= (b & 0x7F) << shift
            if not (b & 0x80): break
            shift += 7
        if i >= len(data): break
        fn, wt = key >> 3, key & 7
        if wt == 0:
            val = 0; shift = 0
            while i < len(data):
                b_ = data[i]; i += 1
                val |= (b_ & 0x7F) << shift
                if not (b_ & 0x80): break
                shift += 7
            out.append((fn, "varint", val))
        elif wt == 2:
            ln = 0; shift = 0
            while i < len(data):
                b_ = data[i]; i += 1
                ln |= (b_ & 0x7F) << shift
                if not (b_ & 0x80): break
                shift += 7
            if i + ln > len(data): break
            val = data[i: i + ln]; i += ln
            try: out.append((fn, "str", val.decode("utf-8")))
            except Exception: out.append((fn, "bytes", val))
        else: break
    return out


def msg_anti_abuse(turnstile_token: str) -> bytes:
    return pb_str(1, turnstile_token)


def msg_create_user_and_session(email: str, given: str, family: str, password: str, code: str, turnstile: str) -> bytes:
    user = pb_str(1, given) + pb_str(2, family) + pb_str(3, email) + pb_str(5, password) + pb_varint(6, 1)
    return pb_msg(1, user) + pb_msg(6, msg_anti_abuse(turnstile)) + pb_str(9, code)


def msg_create_session_email_password(email: str, password: str, turnstile: str = "") -> bytes:
    ep = pb_str(1, email) + pb_str(2, password)
    cred = pb_msg(1, ep)
    parts = [pb_msg(1, cred)]
    if turnstile: parts.append(pb_msg(4, msg_anti_abuse(turnstile)))
    return b"".join(parts)


def extract_session_cookie(parsed: dict) -> str | None:
    for fr in parsed.get("frames") or []:
        for fn, typ, val in parse_pb_fields(fr):
            if fn == 2 and typ == "str" and str(val).startswith("eyJ"): return str(val)
            if typ == "bytes" and isinstance(val, (bytes, bytearray)):
                try: nested = parse_pb_fields(bytes(val))
                except Exception: nested = []
                for nfn, ntyp, nval in nested:
                    if nfn == 2 and ntyp == "str" and str(nval).startswith("eyJ"): return str(nval)
        if b"eyJ" in fr:
            try:
                s = fr.decode("utf-8", "ignore")
                m = re.search(r"eyJ[A-Za-z0-9_\-]+=*\.[A-Za-z0-9_\-]+=*\.[A-Za-z0-9_\-]+", s)
                if m: return m.group(0)
            except Exception: pass
    return None
