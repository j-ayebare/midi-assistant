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

const SPEED_OPTIONS = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0]

const DEFAULT_SYNTH_CONFIG = {
  maxPolyphony: 64,
  voice: Tone.Synth,
  options: {
    oscillator: { type: 'triangle8' },
    envelope: {
      attack: 0.02,
      decay: 0.3,
      sustain: 0.4,
      release: 0.8,
    },
    volume: -8,
  },
}

// ═══════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════

function midiToToneName(noteNum) {
  const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']
  const octave = Math.floor(noteNum / 12) - 1
  return `${names[noteNum % 12]}${octave}`
}

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

  // ── Refs ──
  const synthRef = useRef(null)
  const scheduledRef = useRef([])
  const rafRef = useRef(null)
  const durationRef = useRef(0)
  const baseBpmRef = useRef(120)

  // ═══════════════════════════════════════════
  // SYNTH LIFECYCLE
  // ═══════════════════════════════════════════

  useEffect(() => {
    synthRef.current = new Tone.PolySynth(DEFAULT_SYNTH_CONFIG).toDestination()

    return () => {
      _stopAll()
      if (synthRef.current) {
        synthRef.current.dispose()
        synthRef.current = null
      }
    }
  }, [])

  // ═══════════════════════════════════════════
  // SCHEDULE NOTES
  // ═══════════════════════════════════════════

  useEffect(() => {
    if (!parsedMidi) {
      setIsLoaded(false)
      return
    }

    _stopAll()

    const duration = parsedMidi.duration_seconds || 0
    durationRef.current = duration
    const tpb = parsedMidi.ticks_per_beat || 480
    const bpm = parsedMidi.tempo_bpm || 120
    const spb = 60 / bpm

    // Store base BPM for display
    baseBpmRef.current = bpm

    // Set Transport BPM to match the MIDI file
    // Speed changes will modify this value directly
    Tone.getTransport().bpm.value = bpm

    // Reset playback rate to 1 — we control speed via BPM
    Tone.getTransport().playbackRate = 1

    // Reset speed state
    setSpeed(1.0)

    // ── Schedule notes using Transport time (seconds at base BPM) ──
    // Transport.seconds maps directly to song position.
    // When we change BPM, Transport automatically plays faster/slower.
    const events = []

    ;(parsedMidi.tracks || []).forEach(track => {
      if (track.is_drum) return

      ;(track.notes || []).forEach(note => {
        const startSec = note.start_seconds
          ?? (note.start_ticks / tpb) * spb
        const endSec = note.end_seconds
          ?? (note.end_ticks / tpb) * spb
        const durSec = Math.max(0.01, endSec - startSec)

        // Convert to beat-relative time for scheduling
        // This way BPM changes affect both timing AND duration
        const startBeats = startSec / spb
        const durBeats = durSec / spb

        const eventId = Tone.getTransport().schedule((time) => {
          if (synthRef.current) {
            try {
              // Convert beat duration back to seconds at CURRENT tempo
              // Tone handles this automatically via the time parameter
              const currentSpb = 60 / Tone.getTransport().bpm.value
              const actualDur = durBeats * currentSpb

              synthRef.current.triggerAttackRelease(
                midiToToneName(note.pitch),
                actualDur,
                time,
                note.velocity / 127
              )
            } catch (e) {
              // Swallow errors from notes outside playable range
            }
          }
        }, startSec) // Schedule at original position — Transport BPM handles speed

        events.push(eventId)
      })
    })

    scheduledRef.current = events

    // Auto-stop at end
    const stopEvent = Tone.getTransport().schedule(() => {
      setTimeout(() => handleStop(), 50)
    }, duration + 0.1)
    events.push(stopEvent)

    setIsLoaded(true)
    setCurrentTime(0)

  }, [parsedMidi])

  // ═══════════════════════════════════════════
  // TIME TRACKING
  // ═══════════════════════════════════════════

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
    if (synthRef.current) {
      synthRef.current.releaseAll()
    }
  }, [stopTimeTracking])

  const handlePlayPause = useCallback(() => {
    if (isPlaying) {
      handlePause()
    } else {
      handlePlay()
    }
  }, [isPlaying, handlePlay, handlePause])

  // ═══════════════════════════════════════════
  // SEEK
  // ═══════════════════════════════════════════

  const handleSeek = useCallback((timeInSeconds) => {
    const wasPlaying = isPlaying

    Tone.getTransport().pause()
    if (synthRef.current) synthRef.current.releaseAll()

    Tone.getTransport().seconds = timeInSeconds
    setCurrentTime(timeInSeconds)

    if (wasPlaying) {
      Tone.getTransport().start()
      startTimeTracking()
    }
  }, [isPlaying, startTimeTracking])

  const handleSeekBarClick = useCallback((e) => {
    const bar = e.currentTarget
    const rect = bar.getBoundingClientRect()
    const fraction = (e.clientX - rect.left) / rect.width
    const time = fraction * durationRef.current
    handleSeek(Math.max(0, Math.min(durationRef.current, time)))
  }, [handleSeek])

  // ═══════════════════════════════════════════
  // SPEED CONTROL — changes actual BPM
  // ═══════════════════════════════════════════

  const handleSpeedChange = useCallback((newSpeed) => {
    setSpeed(newSpeed)

    // Change the actual BPM — this speeds up/slows down everything:
    // note triggers, note durations, transport position advancement
    const newBpm = baseBpmRef.current * newSpeed
    Tone.getTransport().bpm.value = newBpm
  }, [])

  // ═══════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════

  function _stopAll() {
    Tone.getTransport().stop()
    Tone.getTransport().cancel()
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
  const currentBpm = Math.round(baseBpmRef.current * speed)

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
                {s === 1.0 ? `1× (${baseBpmRef.current} BPM)` : `${s}× (${Math.round(baseBpmRef.current * s)} BPM)`}
              </option>
            ))}
          </select>
        </div>

      </div>
    </div>
  )
}

export default MidiPlayer
