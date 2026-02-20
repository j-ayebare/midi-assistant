# backend/routers/analysis.py

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import Optional
from pathlib import Path
import uuid

from backend.core.music_analyzer import MusicAnalyzer
from backend.core.llm_bridge import QwenBridge
from backend.config import OLLAMA_BASE_URL, QWEN_MODEL

router = APIRouter(prefix="/api/analysis", tags=["analysis"])

# Cache analyzers to avoid re-parsing
_analyzer_cache: dict[str, MusicAnalyzer] = {}
_analysis_cache: dict[str, dict] = {}

UPLOAD_DIR = Path("uploads")
GENERATED_DIR = Path("generated")
GENERATED_DIR.mkdir(exist_ok=True)

qwen = QwenBridge(base_url=OLLAMA_BASE_URL, model=QWEN_MODEL)


def _get_analyzer(file_id: str) -> MusicAnalyzer:
    if file_id not in _analyzer_cache:
        # Find the file in uploads
        matches = list(UPLOAD_DIR.glob(f"{file_id}*"))
        if not matches:
            raise HTTPException(status_code=404, detail=f"File {file_id} not found")
        _analyzer_cache[file_id] = MusicAnalyzer(str(matches[0]))
    return _analyzer_cache[file_id]


def _get_analysis(file_id: str) -> dict:
    if file_id not in _analysis_cache:
        analyzer = _get_analyzer(file_id)
        _analysis_cache[file_id] = analyzer.get_llm_context()
    return _analysis_cache[file_id]


# ── Pure Analysis (no LLM) ────────────────────────────────────

@router.get("/theory/{file_id}")
async def get_theory_analysis(file_id: str):
    """Returns music21 analysis — key, scale, chords. No LLM involved."""
    try:
        context = _get_analysis(file_id)
        return {"status": "ok", "analysis": context}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── Analyze Mode (LLM commentary) ─────────────────────────────

@router.get("/analyze/{file_id}")
async def analyze_mode(file_id: str):
    """music21 analysis + Qwen commentary on the musical content."""
    context = _get_analysis(file_id)
    llm_response = await qwen.analyze(context)
    return {
        "status": "ok",
        "theory": context,
        "llm": llm_response,
    }


# ── Create Mode ───────────────────────────────────────────────

class CreateRequest(BaseModel):
    request_type: str  # "bridge" | "chord_progression" | "melody"
    user_prompt: Optional[str] = ""

@router.post("/create/{file_id}")
async def create_mode(file_id: str, req: CreateRequest):
    """Generate new musical content based on the analysis."""
    if req.request_type not in ("bridge", "chord_progression", "melody"):
        raise HTTPException(400, "request_type must be: bridge, chord_progression, or melody")

    context = _get_analysis(file_id)
    llm_response = await qwen.create(context, req.request_type, req.user_prompt or "")
    return {
        "status": "ok",
        "theory": context,
        "llm": llm_response,
    }


# ── Extend Mode ───────────────────────────────────────────────

class ExtendRequest(BaseModel):
    bars: Optional[int] = 4
    user_prompt: Optional[str] = ""

@router.post("/extend/{file_id}")
async def extend_mode(file_id: str, req: ExtendRequest):
    """Extend the existing progression by N bars."""
    bars = max(2, min(req.bars or 4, 16))  # clamp 2-16
    context = _get_analysis(file_id)
    llm_response = await qwen.extend(context, bars, req.user_prompt or "")
    return {
        "status": "ok",
        "theory": context,
        "llm": llm_response,
    }


# ── Realize to MIDI ───────────────────────────────────────────

class RealizeRequest(BaseModel):
    roman_numerals: list[str]
    key: Optional[str] = None  # defaults to detected key

@router.post("/realize/{file_id}")
async def realize_to_midi(file_id: str, req: RealizeRequest):
    """Convert Roman numerals to a downloadable MIDI file."""
    context = _get_analysis(file_id)
    key_str = req.key or context["key"]["key"]

    output_name = f"{uuid.uuid4().hex[:8]}.mid"
    output_path = str(GENERATED_DIR / output_name)

    try:
        MusicAnalyzer.realize_progression_to_midi(
            roman_numerals=req.roman_numerals,
            key_str=key_str,
            output_path=output_path,
        )
    except Exception as e:
        raise HTTPException(500, f"MIDI generation failed: {e}")

    return FileResponse(
        output_path,
        media_type="audio/midi",
        filename=f"suggestion_{output_name}",
    )