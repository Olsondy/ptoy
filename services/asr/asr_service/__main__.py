"""Entry point: ``python -m asr_service``."""

from __future__ import annotations

import logging

import uvicorn

from .app import create_app
from .config import Settings
from .engine import SenseVoiceTranscriber


def main() -> None:
    settings = Settings.from_env()
    logging.basicConfig(
        level=settings.log_level.upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    app = create_app(settings, SenseVoiceTranscriber)
    uvicorn.run(app, host=settings.host, port=settings.port, log_level=settings.log_level)


if __name__ == "__main__":
    main()
