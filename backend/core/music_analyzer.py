# backend/core/music_analyzer.py

import mido
from pathlib import Path
from typing import Optional

# ── Chord Templates ────────────────────────────────────────
# (quality_name, intervals_from_root, priority: lower = preferred)
CHORD_TEMPLATES = [
    ('',      [0, 4, 7],      1),   # major
    ('m',     [0, 3, 7],      1),   # minor
    ('7',     [0, 4, 7, 10],  2),   # dominant 7
    ('maj7',  [0, 4, 7, 11],  2),   # major 7
    ('m7',    [0, 3, 7, 10],  2),   # minor 7
    ('dim',   [0, 3, 6],      3),   # diminished
    ('aug',   [0, 4, 8],      3),   # augmented
    ('sus4',  [0, 5, 7],      3),   # sus4
    ('sus2',  [0, 2, 7],      3),   # sus2
    ('dim7',  [0, 3, 6, 9],   4),   # diminished 7
    ('m7b5',  [0, 3, 6, 10],  4),   # half-diminished 7
    ('add9',  [0, 2, 4, 7],   4),   # add9
    ('madd9', [0, 2, 3, 7],   4),   # minor add9
]


class MusicAnalyzer:
    """
    Hybrid analyzer: mido for reliable MIDI parsing,
    music21 for theory analysis, template matching for chords.
    """

    def __init__(self, midi_path: str):
        self.path = midi_path
        self._m21 = None
        self._score = None
        self._key = None
        self._raw_data = None

        self._parse_with_mido()

    # ── Lazy music21 import ────────────────────────────────

    @property
    def m21(self):
        if self._m21 is None:
            import music21
            try:
                us = music21.environment.UserSettings()
                us['musescoreDirectPNGPath'] = None
                us['musicxmlPath'] = None
                us['midiPath'] = None
            except Exception:
                pass
            self._m21 = music21
        return self._m21

    # ── Mido Parsing ───────────────────────────────────────

    def _parse_with_mido(self):
        mid = mido.MidiFile(self.path)
        self._raw_data = {
            'type': mid.type,
            'ticks_per_beat': mid.ticks_per_beat,
            'duration_seconds': mid.length,
            'tracks': len(mid.tracks),
            'bpm': 120,
            'tempo_changes': [],
            'channels': {},
        }

        tpb = mid.ticks_per_beat

        for track in mid.tracks:
            abs_tick = 0
            active = {}

            for msg in track:
                abs_tick += msg.time

                if msg.type == 'set_tempo':
                    bpm = mido.tempo2bpm(msg.tempo)
                    self._raw_data['tempo_changes'].append({
                        'tick': abs_tick,
                        'bpm': round(bpm, 1),
                    })

                elif msg.type == 'note_on' and msg.velocity > 0:
                    active[(msg.channel, msg.note)] = (abs_tick, msg.velocity)

                elif msg.type == 'note_off' or (msg.type == 'note_on' and msg.velocity == 0):
                    key = (msg.channel, msg.note)
                    if key in active:
                        start_tick, velocity = active.pop(key)
                        duration_ticks = abs_tick - start_tick

                        ch = msg.channel
                        if ch not in self._raw_data['channels']:
                            self._raw_data['channels'][ch] = []

                        self._raw_data['channels'][ch].append({
                            'midi_note': msg.note,
                            'velocity': velocity,
                            'start_tick': start_tick,
                            'duration_ticks': max(duration_ticks, 1),
                            'start_beats': start_tick / tpb,
                            'duration_beats': max(duration_ticks, 1) / tpb,
                        })

        # BPM from first tempo event
        if self._raw_data['tempo_changes']:
            self._raw_data['bpm'] = self._raw_data['tempo_changes'][0]['bpm']

        # Sort notes
        for ch in self._raw_data['channels']:
            self._raw_data['channels'][ch].sort(key=lambda n: n['start_tick'])

        # Total duration
        max_end = 0
        for ch, notes in self._raw_data['channels'].items():
            if notes:
                last = notes[-1]
                end = last['start_beats'] + last['duration_beats']
                if end > max_end:
                    max_end = end
        self._raw_data['total_beats'] = max_end
        self._raw_data['total_bars'] = max_end / 4

        total_notes = sum(len(n) for n in self._raw_data['channels'].values())
        print(f"[MusicAnalyzer] Parsed: {total_notes} notes, "
              f"{len(self._raw_data['channels'])} channels, "
              f"{self._raw_data['total_beats']:.1f} beats, "
              f"{self._raw_data['bpm']} BPM, "
              f"{self._raw_data['duration_seconds']:.1f}s")

    # ── Build music21 Score ────────────────────────────────

    @property
    def score(self):
        if self._score is None:
            self._score = self._build_m21_score()
        return self._score

    def _build_m21_score(self):
        m21 = self.m21
        s = m21.stream.Score()
        s.insert(0, m21.tempo.MetronomeMark(number=self._raw_data['bpm']))
        s.insert(0, m21.meter.TimeSignature('4/4'))

        for ch, notes in sorted(self._raw_data['channels'].items()):
            if ch == 9:  # skip drums only
                continue
            if not notes:
                continue

            part = m21.stream.Part()
            part.partName = f"Channel {ch}"

            for n_data in notes:
                n = m21.note.Note(n_data['midi_note'])
                n.quarterLength = max(n_data['duration_beats'], 0.25)
                n.volume.velocity = n_data['velocity']
                part.insert(n_data['start_beats'], n)

            if part.notes:
                s.insert(0, part)

        print(f"[MusicAnalyzer] Built music21 Score: {len(s.parts)} parts, "
              f"{s.duration.quarterLength:.1f} quarter notes")
        return s

    # ── Key Detection ──────────────────────────────────────

    @property
    def detected_key(self):
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
                           if p.octave == 4],
        }

    # ── Scale Membership ───────────────────────────────────

    def get_scale_membership(self) -> dict:
        m21 = self.m21
        k = self.detected_key
        scale_pitch_names = set(p.name for p in k.getScale().getPitches())

        in_scale = []
        out_of_scale = []

        for n in self.score.flatten().notes:  # fixed: .flat → .flatten()
            if isinstance(n, m21.note.Note):
                notes_to_check = [n]
            elif isinstance(n, m21.chord.Chord):
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
            "out_of_scale_notes": out_of_scale[:50],
        }

    # ── Template-Based Chord Matching ──────────────────────

    def _match_chord(self, pitch_classes: set, pc_weights: dict = None):
        """
        Match pitch classes against chord templates.
        Returns (root_pc, quality, intervals, score) or None.
        
        Uses velocity×duration weighting to prioritize prominent notes.
        """
        if len(pitch_classes) < 2:
            return None

        best = None
        best_score = -999

        for quality, intervals, priority in CHORD_TEMPLATES:
            for root in range(12):
                template_pcs = set((root + i) % 12 for i in intervals)

                matched = template_pcs & pitch_classes
                missing = template_pcs - pitch_classes
                extra = pitch_classes - template_pcs

                # Must match at least 2 template notes, miss at most 1
                if len(matched) < 2 or len(missing) > 1:
                    continue

                # Base score: how well does the template fit?
                match_ratio = len(matched) / len(intervals)

                # Velocity weighting: are the matched notes the loud ones?
                if pc_weights:
                    total_weight = sum(pc_weights.values())
                    if total_weight > 0:
                        matched_weight = sum(pc_weights.get(pc, 0) for pc in matched)
                        vel_bonus = matched_weight / total_weight
                    else:
                        vel_bonus = 0
                else:
                    vel_bonus = 0

                score = (
                    match_ratio * 10
                    - len(missing) * 3
                    - len(extra) * 0.5
                    - priority * 0.3
                    + vel_bonus * 3
                )

                if score > best_score:
                    best_score = score
                    best = (root, quality, intervals, score)

        # Only return if we got a reasonable match
        return best if best and best_score > 3 else None

    # ── Chord Progression (Template-Based) ─────────────────

    def get_simplified_progression(self, beats_per_chord: float = 4.0) -> list:
        """
        Window-based chord detection from raw note data.
        Uses template matching instead of music21 chordify.
        """
        m21 = self.m21
        k = self.detected_key

        # Collect all non-drum notes
        all_notes = []
        for ch, notes in self._raw_data['channels'].items():
            if ch == 9:
                continue
            all_notes.extend(notes)
        all_notes.sort(key=lambda n: n['start_beats'])

        max_beat = self._raw_data['total_beats']
        progression = []

        window_start = 0.0
        while window_start < max_beat:
            window_end = window_start + beats_per_chord

            # Get notes sounding in this window
            window_notes = [
                n for n in all_notes
                if n['start_beats'] < window_end and
                   n['start_beats'] + n['duration_beats'] > window_start
            ]

            if not window_notes:
                window_start = window_end
                continue

            # Build velocity×duration weighted pitch class profile
            pc_weights = {}
            for n in window_notes:
                pc = n['midi_note'] % 12
                weight = n['velocity'] * min(n['duration_beats'], beats_per_chord)
                pc_weights[pc] = pc_weights.get(pc, 0) + weight

            pitch_classes = set(pc_weights.keys())

            # Match against chord templates
            match = self._match_chord(pitch_classes, pc_weights)

            if match:
                root_pc, quality, intervals, score = match

                # Build in root position — no wrapping, no inversions
                root_midi = root_pc + 60
                pitches = [m21.pitch.Pitch(midi=root_midi + i)
                          for i in intervals]
                c = m21.chord.Chord(pitches)

                try:
                    rn = m21.roman.romanNumeralFromChord(c, k)
                    # Clean figure: strip figured bass numbers, keep quality
                    base = rn.romanNumeralAlone  # 'I', 'ii', 'IV', etc.
                    # Add quality suffix from our template
                    suffix = {
                        '': '', 'm': '',  # case already encodes major/minor
                        '7': '7', 'maj7': 'maj7', 'm7': '7',
                        'dim': '°', 'aug': '+',
                        'sus4': 'sus4', 'sus2': 'sus2',
                        'dim7': '°7', 'm7b5': 'ø7',
                        'add9': 'add9', 'madd9': 'add9',
                    }.get(quality, '')
                    figure = base + suffix
                except Exception:
                    figure = "?"

                chord_name = c.pitchedCommonName
                pitch_names = [p.nameWithOctave for p in pitches]
            else:
                # No good match — report pitch classes
                figure = "?"
                chord_name = "N/C"
                pitch_names = []

            progression.append({
                "bar_offset": window_start,
                "chord_name": chord_name,
                "roman_numeral": figure,
                "pitches": pitch_names,
            })

            window_start = window_end

        return progression

    # ── LLM Context Builder ────────────────────────────────

    def get_llm_context(self) -> dict:
        key_info = self.get_key_info()
        scale_info = self.get_scale_membership()
        progression = self.get_simplified_progression()

        roman_sequence = [c["roman_numeral"] for c in progression]

        return {
            "key": key_info,
            "scale": scale_info,
            "progression": progression,
            "progression_summary": " → ".join(roman_sequence),
            "total_bars": len(progression),
            "bpm": self._raw_data['bpm'],
            "duration_seconds": round(self._raw_data['duration_seconds'], 1),
            "channels": len(self._raw_data['channels']),
            "analysis_source": "mido+music21",
        }

    # ── MIDI Generation ────────────────────────────────────

    @staticmethod
    def realize_progression_to_midi(
        roman_numerals: list,
        key_str: str,
        output_path: str,
        beats_per_chord: float = 4.0,
        octave: int = 4,
    ) -> str:
        from music21 import key as m21key, roman, chord, stream
        from music21 import midi as m21midi

        k = m21key.Key(key_str)
        s = stream.Stream()

        for rn_str in roman_numerals:
            try:
                rn = roman.RomanNumeral(rn_str, k)
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