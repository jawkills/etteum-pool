import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# test_etteum_push.py
import json
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from etteum_push import (
    account_to_import_item,
    build_import_payload,
    push_enabled_from_env,
    parse_push_cli_flags,
    push_one_farm_result,
)

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"


class TestAccountToImportItem(unittest.TestCase):
    def test_nested_tokens_from_farm_result(self):
        result = {
            "email": "a@x.com",
            "password": "pw",
            "tokens": {
                "access_token": "at",
                "refresh_token": "rt",
                "id_token": "idt",
                "expires_at": "2026-07-17T12:00:00Z",
                "client_id": "b1a00492-073a-47ea-816f-4c329264a828",
            },
        }
        item = account_to_import_item(result)
        self.assertEqual(item["email"], "a@x.com")
        self.assertEqual(item["tokens"]["access_token"], "at")
        self.assertEqual(item["tokens"]["refresh_token"], "rt")
        # Password is forwarded so pool can reauth dead accounts later.
        self.assertEqual(item["password"], "pw")

    def test_flat_tokens_still_works(self):
        result = {
            "email": "b@x.com",
            "access_token": "at2",
            "refresh_token": "rt2",
        }
        item = account_to_import_item(result)
        self.assertEqual(item["access_token"], "at2")
        self.assertEqual(item["refresh_token"], "rt2")

    def test_fixture_nested_matches_shape(self):
        raw = json.loads((FIXTURES / "cpa_nested_tokens.json").read_text(encoding="utf-8"))
        item = account_to_import_item(raw)
        self.assertEqual(item["email"], "farm-nested@example.com")
        self.assertEqual(item["tokens"]["access_token"], "at-nested")
        self.assertEqual(item["password"], "secret-pw")

    def test_fixture_flat_matches_shape(self):
        raw = json.loads((FIXTURES / "cpa_flat_tokens.json").read_text(encoding="utf-8"))
        item = account_to_import_item(raw)
        self.assertEqual(item["email"], "farm-flat@example.com")
        self.assertEqual(item["access_token"], "at-flat")
        self.assertEqual(item["refresh_token"], "rt-flat")


class TestBuildPayload(unittest.TestCase):
    def test_wraps_list(self):
        items = [{"email": "a@x.com", "access_token": "a", "refresh_token": "r"}]
        body = build_import_payload(items)
        self.assertEqual(body["accounts"], items)


class TestFlags(unittest.TestCase):
    def test_default_push_on(self):
        self.assertTrue(push_enabled_from_env({}, no_push_flag=False))

    def test_env_false(self):
        self.assertFalse(push_enabled_from_env({"GROK_PUSH_ETTEUM": "false"}, no_push_flag=False))

    def test_cli_no_push_wins(self):
        self.assertFalse(push_enabled_from_env({"GROK_PUSH_ETTEUM": "true"}, no_push_flag=True))

    def test_parse_cli(self):
        rest, no_push = parse_push_cli_flags(["-n", "2", "--no-push", "-y"])
        self.assertTrue(no_push)
        self.assertEqual(rest, ["-n", "2", "-y"])


class TestPushOneImportedZero(unittest.TestCase):
    """Worker treats imported<1 as failure — ensure response shape is readable."""

    @patch("etteum_push.urllib.request.urlopen")
    def test_imported_zero_response(self, mock_urlopen):
        body = json.dumps({"imported": 0, "failed": 1, "results": []}).encode("utf-8")
        resp = MagicMock()
        resp.read.return_value = body
        resp.__enter__.return_value = resp
        resp.__exit__.return_value = False
        mock_urlopen.return_value = resp

        result = {
            "email": "z@x.com",
            "password": "pw",
            "tokens": {"access_token": "at", "refresh_token": "rt"},
        }
        data = push_one_farm_result(
            result,
            base_url="http://127.0.0.1:1930",
            api_key="test-key",
            retries=1,
        )
        self.assertEqual(int(data.get("imported") or 0), 0)


if __name__ == "__main__":
    unittest.main()
