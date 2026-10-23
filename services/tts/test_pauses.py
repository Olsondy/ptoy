import unittest

import numpy as np

from pauses import PauseLimits, tighten

RATE = 1000  # 10 samples per 10 ms frame


def clip(*parts):
    """("s", ms) silence / ("v", ms) voice → int16 PCM."""
    return np.concatenate([
        np.zeros(ms, np.int16) if kind == "s" else np.full(ms, 8000, np.int16) for kind, ms in parts
    ])


class TightenTest(unittest.TestCase):
    limits = PauseLimits(lead_ms=30, trail_ms=250, max_pause_ms=400)

    def test_trims_edges_to_the_limits(self):
        out = tighten(clip(("s", 300), ("v", 500), ("s", 600)), RATE, self.limits)
        self.assertEqual(len(out), 30 + 500 + 250)
        self.assertEqual(int(np.argmax(out != 0)), 30)

    def test_keeps_short_edges_as_they_are(self):
        pcm = clip(("s", 20), ("v", 500), ("s", 100))
        np.testing.assert_array_equal(tighten(pcm, RATE, self.limits), pcm)

    def test_shortens_long_inner_pauses_only(self):
        out = tighten(clip(("v", 200), ("s", 900), ("v", 200), ("s", 300), ("v", 200)), RATE, self.limits)
        self.assertEqual(len(out), 200 + 400 + 200 + 300 + 200)

    def test_silent_clip_is_returned_unchanged(self):
        pcm = np.zeros(500, np.int16)
        np.testing.assert_array_equal(tighten(pcm, RATE, self.limits), pcm)


if __name__ == "__main__":
    unittest.main()
