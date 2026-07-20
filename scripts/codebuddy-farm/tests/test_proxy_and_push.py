"""Unit tests — no network."""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

# Ensure DI env for sticky builder
os.environ.setdefault("DI_LOGIN", "testlogin")
os.environ.setdefault("DI_PASSWORD", "testpass")
os.environ.setdefault("DI_HOST", "gw.dataimpulse.com:823")
os.environ.setdefault("DI_SESSTTL", "15")


class TestProxy(unittest.TestCase):
    def test_sticky_format(self):
        from proxy_di import build_sticky_proxy

        p = build_sticky_proxy(country="sg", sessid="cbtest12345")
        self.assertTrue(p["sticky"])
        self.assertIn("testlogin__cr.sg;sessid.cbtest12345;sessttl.15", p["url"])
        self.assertIn("testpass", p["url"])
        self.assertEqual(p["country"], "sg")


class TestPushMap(unittest.TestCase):
    def test_result_to_import_item(self):
        from etteum_push import result_to_import_item

        item = result_to_import_item(
            {
                "email": "a@privaterelay.appleid.com",
                "api_key": "ck_abc.def",
                "github_username": "user1",
                "password": "Secret1!",
                "mode": "pure_http_sticky",
                "proxy_country": "sg",
                "github_account_id": 42,
            }
        )
        self.assertEqual(item["api_key"], "ck_abc.def")
        self.assertEqual(item["email"], "a@privaterelay.appleid.com")
        self.assertEqual(item["github_username"], "user1")
        self.assertEqual(item["password"], "Secret1!")
        self.assertEqual(item["github_account_id"], 42)

    def test_result_to_github_item(self):
        from etteum_push import result_to_github_item

        item = result_to_github_item(
            {
                "email": "a@privaterelay.appleid.com",
                "password": "Secret1!",
                "github_username": "user1",
                "proxy_country": "sg",
                "proxy_sessid": "cbsess",
                "batch_id": "b1",
            }
        )
        self.assertEqual(item["email"], "a@privaterelay.appleid.com")
        self.assertEqual(item["username"], "user1")
        self.assertEqual(item["proxy_sessid"], "cbsess")
        self.assertEqual(item["source"], "codebuddy-farm")

    def test_rejects_non_ck(self):
        from etteum_push import result_to_import_item

        with self.assertRaises(ValueError):
            result_to_import_item({"api_key": "nope", "email": "x@y.z"})


class TestLogParserTsParity(unittest.TestCase):
    """Python-side smoke that human log lines match expected regexes used by TS."""

    def test_ok_line_shape(self):
        import re

        line = "12:00:00  [OK]  #1  a@b.com  imported"
        m = re.search(r"\[OK\]\s*#(\d+)(?:\s+(\S+@\S+))?(?:\s+(.+))?$", line)
        self.assertIsNotNone(m)
        assert m
        self.assertEqual(m.group(1), "1")
        self.assertEqual(m.group(2), "a@b.com")


if __name__ == "__main__":
    unittest.main()
