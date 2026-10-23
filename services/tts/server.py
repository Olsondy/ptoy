"""Entry point: load IndexTTS2 once, then serve `app.create_app` with uvicorn.

Run inside the IndexTTS conda env, with the WebUI stopped (two model copies do not fit in VRAM):
  set INDEXTTS_DIR=D:\\index-tts
  set TTS_VOICES_DIR=D:\\voices        (one <voice>.wav per voice; or TTS_REF_AUDIO for a single one)
  set TTS_DEFAULT_VOICE=default-relaxing
  python services\\tts\\server.py
All settings are environment variables, see README.md.
"""

from __future__ import annotations

import logging
import os
import sys


def main() -> None:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    log = logging.getLogger("ptoy.tts")

    import uvicorn

    from app import create_app
    from pauses import PauseLimits
    from engine import EngineConfig, IndexTtsEngine

    try:
        cfg = EngineConfig.from_env()
    except ValueError as exc:
        log.error("%s", exc)
        sys.exit(2)
    host = os.environ.get("TTS_HOST", "0.0.0.0")
    port = int(os.environ.get("TTS_PORT", "8002"))
    log.info(
        "loading IndexTTS2 from %s (model dir %s, voices %s, default %s)",
        cfg.indextts_dir, cfg.model_dir, sorted(cfg.voices), cfg.default_voice,
    )
    engine = IndexTtsEngine(cfg)
    app = create_app(
        engine,
        default_emo_alpha=float(os.environ.get("TTS_EMO_ALPHA", "0.65")),
        max_text_chars=int(os.environ.get("TTS_MAX_TEXT_CHARS", "300")),
        max_queue=int(os.environ.get("TTS_MAX_QUEUE", "8")),
        pauses=None if os.environ.get("TTS_TIGHTEN_PAUSES", "1").lower() in ("0", "false") else PauseLimits(
            lead_ms=int(os.environ.get("TTS_LEAD_SILENCE_MS", "30")),
            trail_ms=int(os.environ.get("TTS_TRAIL_SILENCE_MS", "250")),
            max_pause_ms=int(os.environ.get("TTS_MAX_PAUSE_MS", "400")),
        ),
    )
    log.info("serving on http://%s:%d", host, port)
    uvicorn.run(app, host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()
