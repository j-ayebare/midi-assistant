// src/components/MidiPlayer.jsx
/**
 * MIDI Player — Tone.js-powered playback engine
 * ===============================================
 * Replaces html-midi-player entirely. Handles:
 *   - Loading parsed MIDI notes into Tone.js sampler
 *   - Play / pause / stop
 *   - Seek (via click on PianoRoll)
 *   - Tempo / speed control
 *   - Current time tracking → passed to PianoRoll as prop
 *
 * Architecture:
 *   MidiPlayer owns playback state and renders PianoRoll as a child.
 *   This keeps the time source (Tone.Transport) close to the consumer.
 *
 * Props:
 *   parsedMidi — output from backend parse_midi()
 *   filename   — used to show which file is playing (display only)
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import * as Tone from 'tone'
import PianoRoll from './PianoRoll'

// ═══════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════

// Speed presets — maps to Tone.Transport.playbackRate
const SPEED_OPTIONS = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0]

// We use Tone's built-in PolySynth for zero-config sound.
// Swap this for a Sampler + soundfont if you want realistic instruments.
// To change: replace _createSynth() internals, everything else stays the same.
const DEFAULT_SYNTH_CONFIG = {
  maxPolyphony: 64,
  voice: Tone.Synth,
  options: {
    oscillator: { type: 'triangle8' },  // Warm, piano-ish tone
    envelope: {
      attack: 0.02,
      decay: 0.3,
      sustain: 0.4,
      release: 0.8,
    },
    volume: -8,  // Prevent clipping with many simultaneous notes
  },
}

// ═══════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════

/**
 * Convert MIDI note number to Tone.js note string.
 * Tone uses format like "C4", "F#3", etc.
 * This is similar to the backend's note_to_name but Tone
 * needs it client-side for scheduling.
 */
function midiToToneName(noteNum) {
  const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']
  const octave = Math.floor(noteNum / 12) - 1
  return `${names[noteNum % 12]}${octave}`
}

/**
 * Format seconds as mm:ss display.
 */
function formatTime(seconds) {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}


// ═══════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════

function MidiPlayer({ parsedMidi, filename }) {

  // ── Playback state ──
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [speed, setSpeed] = useState(1.0)
  const [isLoaded, setIsLoaded] = useState(false)

  // ── Refs (mutable across renders without triggering re-render) ──
  const synthRef = useRef(null)         // Tone.PolySynth instance
  const scheduledRef = useRef([])       // Array of scheduled Tone event IDs
  const rafRef = useRef(null)           // requestAnimationFrame ID for time tracking
  const startOffsetRef = useRef(0)      // Where we started (for seek support)
  const durationRef = useRef(0)         // Total song duration

  // ═══════════════════════════════════════════
  // SYNTH LIFECYCLE
  // ═══════════════════════════════════════════

  /** Create the synth once on mount, dispose on unmount */
  useEffect(() => {
    synthRef.current = new Tone.PolySynth(DEFAULT_SYNTH_CONFIG).toDestination()

    return () => {
      // Clean up on unmount
      _stopAll()
      if (synthRef.current) {
        synthRef.current.dispose()
        synthRef.current = null
      }
    }
  }, [])

  // ═══════════════════════════════════════════
  // SCHEDULE NOTES — rebuilds when MIDI data changes
  // ═══════════════════════════════════════════

  useEffect(() => {
    if (!parsedMidi) {
      setIsLoaded(false)
      return
    }

    // Stop anything currently playing
    _stopAll()

    const duration = parsedMidi.duration_seconds || 0
    durationRef.current = duration
    const tpb = parsedMidi.ticks_per_beat || 480
    const bpm = parsedMidi.tempo_bpm || 120
    const spb = 60 / bpm // seconds per beat

    // Set Tone.Transport BPM so speed control works correctly
    Tone.getTransport().bpm.value = bpm

    // ── Schedule every note on Tone.Transport ──
    // We schedule ALL notes ahead of time. Transport.start()/stop()
    // controls when they fire. This is how Tone.js recommends doing it.
    const events = []

    ;(parsedMidi.tracks || []).forEach(track => {
      if (track.is_drum) return // Skip drums for now
      // TODO: Add drum support with Tone.NoiseSynth or drum sampler

      ;(track.notes || []).forEach(note => {
        // Calculate times — support both old parser (ticks only) and new (seconds)
        const startSec = note.start_seconds
          ?? (note.start_ticks / tpb) * spb
        const endSec = note.end_seconds
          ?? (note.end_ticks / tpb) * spb
        const durSec = Math.max(0.01, endSec - startSec)

        // Schedule the note on Transport timeline
        // Tone.Transport.schedule returns an event ID we can cancel later
        const eventId = Tone.getTransport().schedule((time) => {
          // `time` is the audio-context time when this fires.
          // We use it (not Date.now) for sample-accurate timing.
          if (synthRef.current) {
            try {
              synthRef.current.triggerAttackRelease(
                midiToToneName(note.pitch),
                durSec,
                time,
                note.velocity / 127  // velocity as gain 0-1
              )
            } catch (e) {
              // Swallow errors from notes outside playable range
              // (e.g., MIDI note 0 = C-1 which some synths reject)
            }
          }
        }, startSec)

        events.push(eventId)
      })
    })

    scheduledRef.current = events

    // ── Schedule an auto-stop at the end of the song ──
    const stopEvent = Tone.getTransport().schedule(() => {
      // Use setTimeout to avoid modifying Transport inside its own callback
      setTimeout(() => handleStop(), 50)
    }, duration + 0.1) // Small buffer past the last note
    events.push(stopEvent)

    setIsLoaded(true)
    setCurrentTime(0)
    startOffsetRef.current = 0

  }, [parsedMidi])

  // ═══════════════════════════════════════════
  // TIME TRACKING — animation frame loop
  // ═══════════════════════════════════════════

  /**
   * While playing, poll Tone.Transport.seconds at 60fps
   * and push it into React state for the PianoRoll playhead.
   *
   * Why RAF instead of Tone's built-in events?
   * - We need ~60fps updates for smooth playhead animation
   * - Tone events are for audio scheduling, not UI updates
   * - RAF naturally syncs with the browser's paint cycle
   */
  const startTimeTracking = useCallback(() => {
    const tick = () => {
      const pos = Tone.getTransport().seconds
      setCurrentTime(pos)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [])

  const stopTimeTracking = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [])

  // ═══════════════════════════════════════════
  // PLAYBACK CONTROLS
  // ═══════════════════════════════════════════

  const handlePlay = useCallback(async () => {
    if (!isLoaded) return

    // Tone.js requires a user gesture to start AudioContext.
    // This is a browser security requirement — not a Tone limitation.
    await Tone.start()

    Tone.getTransport().start()
    setIsPlaying(true)
    startTimeTracking()
  }, [isLoaded, startTimeTracking])

  const handlePause = useCallback(() => {
    Tone.getTransport().pause()
    setIsPlaying(false)
    stopTimeTracking()
  }, [stopTimeTracking])

  const handleStop = useCallback(() => {
    Tone.getTransport().stop()
    Tone.getTransport().seconds = 0
    setIsPlaying(false)
    setCurrentTime(0)
    stopTimeTracking()

    // Release any stuck notes
    if (synthRef.current) {
      synthRef.current.releaseAll()
    }
  }, [stopTimeTracking])

  /** Toggle play/pause — convenient for a single button */
  const handlePlayPause = useCallback(() => {
    if (isPlaying) {
      handlePause()
    } else {
      handlePlay()
    }
  }, [isPlaying, handlePlay, handlePause])

  // ═══════════════════════════════════════════
  // SEEK — called when user clicks the piano roll
  // ═══════════════════════════════════════════

  const handleSeek = useCallback((timeInSeconds) => {
    const wasPlaying = isPlaying

    // Stop current playback and release notes
    Tone.getTransport().pause()
    if (synthRef.current) synthRef.current.releaseAll()

    // Move transport to new position
    Tone.getTransport().seconds = timeInSeconds
    setCurrentTime(timeInSeconds)

    // Resume if we were playing
    if (wasPlaying) {
      Tone.getTransport().start()
      startTimeTracking()
    }
  }, [isPlaying, startTimeTracking])

  // ═══════════════════════════════════════════
  // SEEK BAR — click on the progress bar
  // ═══════════════════════════════════════════

  const handleSeekBarClick = useCallback((e) => {
    const bar = e.currentTarget
    const rect = bar.getBoundingClientRect()
    const fraction = (e.clientX - rect.left) / rect.width
    const time = fraction * durationRef.current
    handleSeek(Math.max(0, Math.min(durationRef.current, time)))
  }, [handleSeek])

  // ═══════════════════════════════════════════
  // SPEED CONTROL
  // ═══════════════════════════════════════════

  const handleSpeedChange = useCallback((newSpeed) => {
    setSpeed(newSpeed)
    // Transport.playbackRate scales time — 2.0 = double speed
    Tone.getTransport().playbackRate = newSpeed
  }, [])

  // ═══════════════════════════════════════════
  // CLEANUP — stop everything when component unmounts
  // or when a different file is selected
  // ═══════════════════════════════════════════

  function _stopAll() {
    Tone.getTransport().stop()
    Tone.getTransport().cancel() // Remove ALL scheduled events
    scheduledRef.current = []
    setIsPlaying(false)
    setCurrentTime(0)
    stopTimeTracking?.()
    if (synthRef.current) synthRef.current.releaseAll()
  }

  // ═══════════════════════════════════════════
  // EMPTY STATE
  // ═══════════════════════════════════════════

  if (!parsedMidi) {
    return (
      <div className="midi-player empty">
        <p>Select a file to play</p>
      </div>
    )
  }

  // ═══════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════

  const duration = durationRef.current
  const progress = duration > 0 ? (currentTime / duration) * 100 : 0

  return (
    <div className="midi-player">

      {/* ── Piano Roll Visualizer ── */}
      <PianoRoll
        parsedMidi={parsedMidi}
        currentTime={currentTime}
        isPlaying={isPlaying}
        onSeek={handleSeek}
      />

      {/* ── Transport Controls ── */}
      <div className="transport-bar">

        {/* Play / Pause / Stop */}
        <div className="transport-buttons">
          <button
            className="transport-btn stop-btn"
            onClick={handleStop}
            title="Stop"
          >
            ⏹
          </button>
          <button
            className="transport-btn play-btn"
            onClick={handlePlayPause}
            title={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? '⏸' : '▶'}
          </button>
        </div>

        {/* Time Display */}
        <div className="transport-time">
          <span className="time-current">{formatTime(currentTime)}</span>
          <span className="time-separator">/</span>
          <span className="time-total">{formatTime(duration)}</span>
        </div>

        {/* Seek Bar */}
        <div className="seek-bar" onClick={handleSeekBarClick}>
          <div className="seek-bar-fill" style={{ width: `${progress}%` }} />
          <div className="seek-bar-thumb" style={{ left: `${progress}%` }} />
        </div>

        {/* Speed Control */}
        <div className="speed-control">
          <span className="speed-label">Speed</span>
          <select
            value={speed}
            onChange={(e) => handleSpeedChange(parseFloat(e.target.value))}
            className="speed-select"
          >
            {SPEED_OPTIONS.map(s => (
              <option key={s} value={s}>
                {s === 1.0 ? '1×' : `${s}×`}
              </option>
            ))}
          </select>
        </div>

      </div>
    </div>
  )
}

export default MidiPlayer