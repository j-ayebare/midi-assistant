# backend/core/music_analyzer.py

from music21 import converter, analysis, key, roman, chord, note, stream, scale
from music21 import midi as m21midi
from pathlib import Path
from typing import Optional
import json


class MusicAnalyzer:
    """
    Wraps music21 to extract theory data from MIDI files.
    All outputs are plain dicts/lists — JSON-serializable for the API.
    """

    def __init__(self, midi_path: str):
        self.path = midi_path
        self.score = converter.parse(midi_path)
        self._key: Optional[key.Key] = None
        self._chordified = None

    # ── Key Detection ──────────────────────────────────────────

    @property
    def detected_key(self) -> key.Key:
        if self._key is None:
            self._key = self.score.analyze('key')
        return self._key

    def get_key_info(self) -> dict:
        k = self.detected_key
        rel = k.relative
        parallel = k.parallel
        return {
            "key": str(k),
            "mode": k.mode,
            "relative": str(rel),
            "relative_mode": rel.mode,
            "parallel": str(parallel),
            "parallel_mode": parallel.mode,
            "confidence": round(k.correlationCoefficient, 3),
            "scale_notes": [p.name for p in k.getScale().getPitches('C2', 'C7')
                           if p.octave == 4],  # just one octave of names
        }

    # ── Scale Membership ───────────────────────────────────────

    def get_scale_membership(self) -> dict:
        k = self.detected_key
        scale_pitch_names = set(p.name for p in k.getScale().getPitches())
        
        in_scale = []
        out_of_scale = []

        for n in self.score.flat.notes:
            if isinstance(n, note.Note):
                notes_to_check = [n]
            elif isinstance(n, chord.Chord):
                notes_to_check = list(n.notes)
            else:
                continue

            for single_note in notes_to_check:
                entry = {
                    "pitch": single_note.nameWithOctave,
                    "name": single_note.name,
                    "offset_beats": float(single_note.offset),
                    "duration_beats": float(single_note.quarterLength),
                }
                if single_note.name in scale_pitch_names:
                    in_scale.append(entry)
                else:
                    out_of_scale.append(entry)

        return {
            "scale": str(k.getScale()),
            "scale_notes": sorted(scale_pitch_names),
            "total_notes": len(in_scale) + len(out_of_scale),
            "in_scale_count": len(in_scale),
            "out_of_scale_count": len(out_of_scale),
            "out_of_scale_notes": out_of_scale[:50],  # cap for response size
        }

    # ── Chord Detection ────────────────────────────────────────

    @property
    def chordified(self):
        if self._chordified is None:
            self._chordified = self.score.chordify()
        return self._chordified

    def get_chord_progression(self) -> list[dict]:
        k = self.detected_key
        progression = []

        for c in self.chordified.recurse().getElementsByClass('Chord'):
            try:
                rn = roman.romanNumeralFromChord(c, k)
                figure = rn.figure
            except Exception:
                figure = "?"

            progression.append({
                "offset_beats": float(c.offset),
                "duration_beats": float(c.quarterLength),
                "chord_name": c.pitchedCommonName,
                "pitches": [p.nameWithOctave for p in c.pitches],
                "roman_numeral": figure,
            })

        return progression

    def get_simplified_progression(self, beats_per_chord: float = 4.0) -> list[dict]:
        """
        Quantize chords to bar boundaries for cleaner analysis.
        Groups notes within each window and picks the most common chord.
        """
        raw = self.get_chord_progression()
        if not raw:
            return []

        max_offset = max(c["offset_beats"] + c["duration_beats"] for c in raw)
        simplified = []

        window_start = 0.0
        while window_start < max_offset:
            window_end = window_start + beats_per_chord
            window_chords = [
                c for c in raw
                if c["offset_beats"] >= window_start and c["offset_beats"] < window_end
            ]

            if window_chords:
                # Pick the longest chord in the window
                dominant = max(window_chords, key=lambda c: c["duration_beats"])
                simplified.append({
                    "bar_offset": window_start,
                    "chord_name": dominant["chord_name"],
                    "roman_numeral": dominant["roman_numeral"],
                    "pitches": dominant["pitches"],
                })

            window_start = window_end

        return simplified

    # ── Structure Summary (for LLM context) ───────────────────

    def get_llm_context(self) -> dict:
        """
        Builds the complete analysis payload.
        This is what gets sent to Qwen.
        """
        key_info = self.get_key_info()
        scale_info = self.get_scale_membership()
        progression = self.get_simplified_progression()
        
        # Build a readable progression string
        roman_sequence = [c["roman_numeral"] for c in progression]
        
        return {
            "key": key_info,
            "scale": scale_info,
            "progression": progression,
            "progression_summary": " → ".join(roman_sequence),
            "total_bars": len(progression),
            "analysis_source": "music21",
        }

    # ── MIDI Generation ────────────────────────────────────────

    @staticmethod
    def realize_progression_to_midi(
        roman_numerals: list[str],
        key_str: str,
        output_path: str,
        beats_per_chord: float = 4.0,
        octave: int = 4,
    ) -> str:
        """
        Takes Roman numerals + key → writes a MIDI file.
        Returns the output path.
        """
        k = key.Key(key_str)
        s = stream.Stream()

        for rn_str in roman_numerals:
            try:
                rn = roman.RomanNumeral(rn_str, k)
                # Normalize to target octave
                for p in rn.pitches:
                    p.octave = octave
                c = chord.Chord(rn.pitches, quarterLength=beats_per_chord)
                s.append(c)
            except Exception as e:
                print(f"Skipping invalid Roman numeral '{rn_str}': {e}")
                continue

        mf = m21midi.translate.streamToMidiFile(s)
        mf.open(output_path, 'wb')
        mf.write()
        mf.close()
        return output_path