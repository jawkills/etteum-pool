# test_etteum_push.py
import unittest
from etteum_push import (
    account_to_import_item,
    build_import_payload,
    push_enabled_from_env,
    parse_push_cli_flags,
)


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


if __name__ == "__main__":
    unittest.main()
