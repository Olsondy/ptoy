import unittest

import numpy as np

import audio


def tone(rate, ms, freq=220.0, amp=0.3):
    t = np.arange(rate * ms // 1000) / rate
    return amp * np.sin(2 * np.pi * freq * t)


class ProcessTest(unittest.TestCase):
    def test_trims_edges_and_outputs_48k_int16(self):
        rate = 22050
        silence = np.zeros(rate * 300 // 1000)
        raw = np.concatenate([silence, tone(rate, 500), silence])

        pcm = audio.process(raw, rate)

        self.assertEqual(pcm.dtype, np.int16)
        duration_ms = len(pcm) * 1000 / audio.TARGET_RATE
        self.assertAlmostEqual(duration_ms, 500 + audio.LEAD_PAD_MS + audio.TAIL_PAD_MS, delta=25)
        lead_ms, tail_ms = audio.edge_silence_ms(pcm, audio.TARGET_RATE)
        self.assertLessEqual(lead_ms, audio.LEAD_PAD_MS + audio.FRAME_MS)
        self.assertLessEqual(tail_ms, audio.TAIL_PAD_MS + audio.FRAME_MS)

    def test_normalizes_peak(self):
        pcm = audio.process(tone(48000, 300, amp=0.05), 48000)
        peak_dbfs = 20 * np.log10(np.max(np.abs(pcm)) / 32767)
        self.assertAlmostEqual(peak_dbfs, audio.PEAK_DBFS, delta=0.1)

    def test_stereo_is_downmixed(self):
        stereo = np.stack([tone(48000, 300), tone(48000, 300)], axis=1)
        self.assertEqual(audio.process(stereo, 48000).ndim, 1)

    def test_all_silence_raises(self):
        with self.assertRaises(ValueError):
            audio.process(np.zeros(48000), 48000)


if __name__ == "__main__":
    unittest.main()
