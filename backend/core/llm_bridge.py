# backend/core/llm_bridge.py

import httpx
import json
import re
from typing import Optional


class QwenBridge:
    """
    Sends music theory context to Qwen via Ollama and parses responses.
    """

    def __init__(
        self,
        base_url: str = "http://localhost:11434",
        model: str = "qwen2.5:14b",
    ):
        self.base_url = base_url
        self.model = model


    async def _query(self, prompt: str, system: str = "") -> str:
        """Ollama API call — uses /api/chat endpoint."""
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
            "stream": False,
            "options": {
                "temperature": 0.7,
                "num_predict": 2048,
            },
        }

        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(
                f"{self.base_url}/api/chat",
                json=payload,
            )
            response.raise_for_status()
            return response.json()["message"]["content"]

    def _build_system_prompt(self) -> str:
        return """You are an expert music theory analyst and composer assistant. 
You work with symbolic music data (MIDI) and communicate using standard music theory terminology.

RULES:
- Always use Roman numeral notation (i, iv, V, VII, etc.) for chord progressions
- Specify major (uppercase) and minor (lowercase) correctly  
- When suggesting chords, output them as a JSON array of Roman numeral strings
- When suggesting melodies, output as a JSON array of objects with "pitch" (e.g. "C4") and "duration" (in beats)
- Keep explanations concise but musically insightful
- Reference specific bars/beats when discussing the input
- Always respond with valid JSON in the "data" field of your response

RESPONSE FORMAT (always):
{
    "commentary": "Your musical analysis or explanation here",
    "data": { ... mode-specific structured data ... }
}"""

    # ── ANALYZE MODE ───────────────────────────────────────────

    async def analyze(self, analysis_context: dict) -> dict:
        system = self._build_system_prompt()

        prompt = f"""ANALYZE this MIDI file's musical content:

KEY: {analysis_context['key']['key']} (confidence: {analysis_context['key']['confidence']})
RELATIVE KEY: {analysis_context['key']['relative']}
SCALE NOTES: {', '.join(analysis_context['key']['scale_notes'])}
OUT-OF-SCALE NOTES: {analysis_context['scale']['out_of_scale_count']} out of {analysis_context['scale']['total_notes']}
CHORD PROGRESSION ({analysis_context['total_bars']} bars):
{analysis_context['progression_summary']}

Provide:
1. Analysis of the harmonic movement and cadences
2. Comment on any chromatic notes and their likely function (passing tones, borrowed chords, etc.)
3. Identify the style/genre this progression is common in
4. Rate the harmonic complexity (simple/moderate/complex)
5. Note any interesting voice leading or harmonic choices

Respond in the JSON format specified in your instructions.
"data" should contain: {{"cadences": [...], "style_hints": [...], "complexity": "...", "notable_features": [...]}}"""

        raw = await self._query(prompt, system)
        return self._parse_response(raw)

    # ── CREATE MODE ────────────────────────────────────────────

    async def create(
        self,
        analysis_context: dict,
        request_type: str,  # "bridge" | "chord_progression" | "melody"
        user_prompt: str = "",
    ) -> dict:
        system = self._build_system_prompt()

        type_instructions = {
            "bridge": """Suggest 3 bridge progressions (each 4-8 bars) that:
- Provide harmonic contrast to the main progression
- Create tension that resolves back to the original key
- Consider modulation to the relative key or subdominant

"data" must contain: {"suggestions": [{"name": "...", "roman_numerals": ["III", "iv", ...], "explanation": "..."}]}""",

            "chord_progression": """Suggest 3 alternative/complementary chord progressions that:
- Stay in or closely related to the detected key
- Offer different harmonic flavor while remaining compatible
- Could work as a verse alternative, pre-chorus, or counter-section

"data" must contain: {"suggestions": [{"name": "...", "roman_numerals": ["i", "VI", ...], "explanation": "...", "feel": "..."}]}""",

            "melody": """Suggest a top-line melody (8-16 notes) that:
- Fits over the existing chord progression
- Emphasizes chord tones on strong beats
- Uses stepwise motion with occasional leaps for interest
- Stays within the detected scale (with optional passing tones marked)

"data" must contain: {"melody": [{"pitch": "C4", "duration": 1.0, "beat": 1.0}], "explanation": "..."}""",
        }

        instruction = type_instructions.get(request_type, type_instructions["chord_progression"])
        user_context = f"\nUSER REQUEST: {user_prompt}" if user_prompt else ""

        prompt = f"""CREATE new musical content based on this analysis:

KEY: {analysis_context['key']['key']}
SCALE: {', '.join(analysis_context['key']['scale_notes'])}
EXISTING PROGRESSION ({analysis_context['total_bars']} bars):
{analysis_context['progression_summary']}
{user_context}

{instruction}

Respond in the JSON format specified in your instructions."""

        raw = await self._query(prompt, system)
        return self._parse_response(raw)

    # ── EXTEND MODE ────────────────────────────────────────────

    async def extend(
        self,
        analysis_context: dict,
        bars: int = 4,
        user_prompt: str = "",
    ) -> dict:
        system = self._build_system_prompt()
        user_context = f"\nUSER DIRECTION: {user_prompt}" if user_prompt else ""

        prompt = f"""EXTEND this chord progression by {bars} bars:

KEY: {analysis_context['key']['key']}
SCALE: {', '.join(analysis_context['key']['scale_notes'])}
EXISTING PROGRESSION:
{analysis_context['progression_summary']}
{user_context}

Continue the progression naturally for {bars} more bars. Consider:
- Maintaining or developing the harmonic rhythm
- Creating a sense of forward motion
- Setting up a satisfying cadence at the end if this is meant to conclude
- Or leaving it open if it's meant to loop

"data" must contain: {{"extended_numerals": ["V", "vi", ...], "full_sequence": ["original + new"], "explanation": "..."}}

Respond in the JSON format specified in your instructions."""

        raw = await self._query(prompt, system)
        return self._parse_response(raw)

    # ── Response Parser ────────────────────────────────────────

    @staticmethod
    def _parse_response(raw: str) -> dict:
        """
        Attempt to extract JSON from the LLM response.
        Falls back gracefully if the model doesn't perfectly comply.
        """
        # Try direct JSON parse
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            pass

        # Try to find JSON block in markdown code fences
        json_match = re.search(r'```(?:json)?\s*(\{.*?\})\s*```', raw, re.DOTALL)
        if json_match:
            try:
                return json.loads(json_match.group(1))
            except json.JSONDecodeError:
                pass

        # Try to find any JSON object
        json_match = re.search(r'\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}', raw, re.DOTALL)
        if json_match:
            try:
                return json.loads(json_match.group(0))
            except json.JSONDecodeError:
                pass

        # Give up — return raw text wrapped in our format
        return {
            "commentary": raw,
            "data": None,
            "parse_warning": "LLM response was not valid JSON — raw text returned",
        }