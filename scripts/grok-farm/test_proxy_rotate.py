# test_proxy_rotate.py — pure rotation core (no network)
"""Unit tests for pick_proxy_from_pool round-robin."""
from __future__ import annotations

import unittest

from proxy import pick_proxy_from_pool


class TestPickProxyFromPool(unittest.TestCase):
    def test_empty_pool(self):
        p, idx = pick_proxy_from_pool([], 0)
        self.assertIsNone(p)
        self.assertEqual(idx, 0)

    def test_pinned_wins(self):
        pool = ["http://a:1", "http://b:2"]
        p, idx = pick_proxy_from_pool(pool, 0, pinned="http://pinned:9")
        self.assertEqual(p, "http://pinned:9")
        self.assertEqual(idx, 0)  # index not advanced when pinned

    def test_round_robin_order(self):
        pool = ["http://a:1", "http://b:2", "http://c:3"]
        idx = 0
        seen: list[str] = []
        for _ in range(6):
            p, idx = pick_proxy_from_pool(pool, idx)
            assert p is not None
            seen.append(p)
        self.assertEqual(
            seen,
            [
                "http://a:1",
                "http://b:2",
                "http://c:3",
                "http://a:1",
                "http://b:2",
                "http://c:3",
            ],
        )

    def test_exclude_skips_then_falls_back(self):
        pool = ["http://a:1", "http://b:2", "http://c:3"]
        p, idx = pick_proxy_from_pool(pool, 0, exclude={"http://a:1"})
        self.assertEqual(p, "http://b:2")
        self.assertEqual(idx, 2)

        # exclude all → still returns something (rotation continues)
        p2, idx2 = pick_proxy_from_pool(
            pool, 0, exclude={"http://a:1", "http://b:2", "http://c:3"}
        )
        self.assertIn(p2, pool)
        self.assertEqual(idx2, 1)

    def test_concurrent_style_divergence(self):
        """Simulates N workers each calling once — should not all get pool[0]."""
        pool = ["http://a:1", "http://b:2", "http://c:3"]
        idx = 0
        picks: list[str] = []
        for _ in range(3):
            p, idx = pick_proxy_from_pool(pool, idx)
            assert p is not None
            picks.append(p)
        self.assertEqual(len(set(picks)), 3)


if __name__ == "__main__":
    unittest.main()
