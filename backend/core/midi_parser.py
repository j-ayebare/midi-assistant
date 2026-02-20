from mido import MidiFile
from pathlib import Path
from typing import Optional

# MIDI note number to name mapping
NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

def note_to_name(note_number: int) -> str:
    """Convert MIDI note number to name (e.g., 60 → C4)."""
    octave = (note_number // 12) - 1
    note = NOTE_NAMES[note_number % 12]
    return f"{note}{octave}"

def parse_midi(filepath: Path) -> dict:
    """
    Parse a MIDI file and extract musical information.
    
    Returns structured data about tracks, notes, tempo, etc.
    """
    mid = MidiFile(filepath)
    
    # Basic info
    ticks_per_beat = mid.ticks_per_beat
    
    # Find tempo (microseconds per beat, default 500000 = 120 BPM)
    tempo = 500000
    time_signature = (4, 4)
    
    # Collect all tracks with their notes
    tracks = []
    
    for i, track in enumerate(mid.tracks):
        track_data = {
            "index": i,
            "name": track.name or f"Track {i}",
            "notes": [],
            "note_count": 0
        }
        
        current_time = 0  # In ticks
        active_notes = {}  # note_number → start_time
        
        for msg in track:
            current_time += msg.time
            
            # Extract tempo
            if msg.type == 'set_tempo':
                tempo = msg.tempo
            
            # Extract time signature
            if msg.type == 'time_signature':
                time_signature = (msg.numerator, msg.denominator)
            
            # Track note on/off
            if msg.type == 'note_on' and msg.velocity > 0:
                active_notes[msg.note] = {
                    "start_ticks": current_time,
                    "velocity": msg.velocity,
                    "channel": msg.channel
                }
            
            elif msg.type == 'note_off' or (msg.type == 'note_on' and msg.velocity == 0):
                if msg.note in active_notes:
                    note_data = active_notes.pop(msg.note)
                    
                    track_data["notes"].append({
                        "pitch": msg.note,
                        "name": note_to_name(msg.note),
                        "start_ticks": note_data["start_ticks"],
                        "end_ticks": current_time,
                        "duration_ticks": current_time - note_data["start_ticks"],
                        "velocity": note_data["velocity"],
                        "channel": note_data["channel"]
                    })
        
        track_data["note_count"] = len(track_data["notes"])
        
        # Only include tracks that have notes
        if track_data["note_count"] > 0:
            tracks.append(track_data)
    
    # Calculate BPM from tempo
    bpm = round(60_000_000 / tempo)
    
    # Calculate duration
    total_ticks = max(
        (note["end_ticks"] for track in tracks for note in track["notes"]),
        default=0
    )
    duration_seconds = ticks_to_seconds(total_ticks, ticks_per_beat, tempo)
    
    # Find pitch range across all tracks
    all_pitches = [note["pitch"] for track in tracks for note in track["notes"]]
    min_pitch = min(all_pitches) if all_pitches else 0
    max_pitch = max(all_pitches) if all_pitches else 127
    
    return {
        "ticks_per_beat": ticks_per_beat,
        "tempo_bpm": bpm,
        "time_signature": f"{time_signature[0]}/{time_signature[1]}",
        "duration_seconds": round(duration_seconds, 2),
        "total_ticks": total_ticks,
        "track_count": len(tracks),
        "total_notes": sum(t["note_count"] for t in tracks),
        "pitch_range": {"min": min_pitch, "max": max_pitch},
        "tracks": tracks
    }

def ticks_to_seconds(ticks: int, ticks_per_beat: int, tempo: int) -> float:
    """Convert MIDI ticks to seconds."""
    beats = ticks / ticks_per_beat
    seconds_per_beat = tempo / 1_000_000
    return beats * seconds_per_beat

