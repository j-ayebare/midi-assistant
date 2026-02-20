import music21
from music21 import environment
from pathlib import Path

BASE_DIR = Path(__file__).parent.parent
UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)

MAX_FILE_SIZE_MB = 10
ALLOWED_EXTENSIONS = {".mid", ".midi"}

# Suppress MuseScore prompts
us = environment.UserSettings()
try:
    us['musescoreDirectPNGPath']
except (KeyError, music21.environment.UserSettingsException):
    us['musescoreDirectPNGPath'] = None
    us['musicxmlPath'] = None
    us['midiPath'] = None

# Ollama / Qwen config
OLLAMA_BASE_URL = "http://localhost:11434"
QWEN_MODEL = "qwen2.5:14b"  # adjust to whatever you pulled in Ollama