// src/components/PianoRoll.jsx
/**
 * FL Studio-style Piano Roll Visualizer
 * ======================================
 * Canvas-based piano roll with:
 *   - Piano key sidebar (left)
 *   - Note grid with beat/bar lines  
 *   - Colored note blocks (per-track, velocity = brightness)
 *   - Moving playhead with glow
 *   - Scroll (wheel), zoom (ctrl+wheel)
 *   - Click-to-seek on grid
 *   - Auto-scroll follows playhead
 *
 * Props:
 *   parsedMidi  — output from backend parse_midi()
 *   currentTime — playback position in seconds (from MidiPlayer)
 *   isPlaying   — enables auto-scroll
 *   onSeek      — callback(seconds) when user clicks the grid
 */

import { useRef, useEffect, useCallback, useState, useMemo } from 'react'

// ═══════════════════════════════════════════════
// LAYOUT CONSTANTS — tweak these for look/feel
// ═══════════════════════════════════════════════

const PIANO_WIDTH = 52
const NOTE_HEIGHT = 14
const PITCH_PAD = 3
const HEADER_HEIGHT = 24
const DEFAULT_PX_PER_SEC = 120
const MIN_PX_PER_SEC = 30
const MAX_PX_PER_SEC = 500
const SCROLL_SPEED = 50

// ═══════════════════════════════════════════════
// FL-STYLE DARK THEME
// ═══════════════════════════════════════════════

const THEME = {
  bg:            '#1b1b2f',
  whiteKeyRow:   '#252540',
  blackKeyRow:   '#1e1e35',
  octaveLine:    'rgba(255,255,255,0.12)',
  gridBeat:      'rgba(255,255,255,0.07)',
  gridBar:       'rgba(255,255,255,0.18)',
  headerBg:      '#16162a',
  headerText:    '#888',
  playhead:      '#ff3333',
  playheadGlow:  'rgba(255,50,50,0.12)',
  pianoWhite:    '#b8b8c8',
  pianoBlack:    '#1c1c30',
  pianoBorder:   '#3a3a50',
  pianoLabel:    '#707088',
  noteBorder:    'rgba(0,0,0,0.4)',
}

// Per-track colors — wraps if more tracks than entries
const TRACK_COLORS = [
  '#ff6b6b','#4ecdc4','#ffe66d','#a29bfe',
  '#fd79a8','#00cec9','#ffeaa7','#6c5ce7',
  '#fab1a0','#81ecec','#fdcb6e','#a8e6cf',
]

// ═══════════════════════════════════════════════
// MUSIC HELPERS
// ═══════════════════════════════════════════════

// Which pitch classes are black keys (C=0)
const IS_BLACK_KEY = [
  false,true,false,true,false,
  false,true,false,true,false,
  true,false
]
const NOTE_LABELS = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']

// ═══════════════════════════════════════════════
// CANVAS UTILITIES
// ═══════════════════════════════════════════════

/** Rounded rect path (fill/stroke separately) */
function roundRect(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rad, y)
  ctx.lineTo(x + w - rad, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad)
  ctx.lineTo(x + w, y + h - rad)
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h)
  ctx.lineTo(x + rad, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad)
  ctx.lineTo(x, y + rad)
  ctx.quadraticCurveTo(x, y, x + rad, y)
  ctx.closePath()
}

/** Brighten/darken a hex color. factor <1 = darker, >1 = brighter */
function adjustBrightness(hex, factor) {
  const r = Math.min(255, Math.max(0, parseInt(hex.slice(1,3), 16) * factor))
  const g = Math.min(255, Math.max(0, parseInt(hex.slice(3,5), 16) * factor))
  const b = Math.min(255, Math.max(0, parseInt(hex.slice(5,7), 16) * factor))
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`
}

// ═══════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════

function PianoRoll({ parsedMidi, currentTime = 0, isPlaying = false, onSeek }) {

  const containerRef = useRef(null)
  const pianoRef = useRef(null)
  const gridRef = useRef(null)
  const rafRef = useRef(null)
  const wasPlayingRef = useRef(false)

  const [scrollX, setScrollX] = useState(0)
  const [scrollY, setScrollY] = useState(0)
  const [pxPerSec, setPxPerSec] = useState(DEFAULT_PX_PER_SEC)
  const [size, setSize] = useState({ width: 800, height: 400 })

  // ── Precompute layout from parsed MIDI (only recalcs when data changes) ──
  const layout = useMemo(() => {
    if (!parsedMidi) return null

    const rawMin = parsedMidi.pitch_range?.min ?? 21
    const rawMax = parsedMidi.pitch_range?.max ?? 108
    const minPitch = Math.max(0, rawMin - PITCH_PAD)
    const maxPitch = Math.min(127, rawMax + PITCH_PAD)
    const pitchCount = maxPitch - minPitch + 1
    const totalHeight = pitchCount * NOTE_HEIGHT + HEADER_HEIGHT

    const duration = parsedMidi.duration_seconds || 0
    const ticksPerBeat = parsedMidi.ticks_per_beat || 480
    const bpm = parsedMidi.tempo_bpm || 120
    const secondsPerBeat = 60 / bpm

    const tsParts = (parsedMidi.time_signature || '4/4').split('/')
    const beatsPerBar = parseInt(tsParts[0]) || 4

    // Flatten non-drum notes with time in seconds
    const notes = []
    ;(parsedMidi.tracks || []).forEach((track, trackIdx) => {
      if (track.is_drum) return
      ;(track.notes || []).forEach(n => {
        // Support both old parser (ticks only) and new (has start_seconds)
        const startSec = n.start_seconds
          ?? (n.start_ticks / ticksPerBeat) * secondsPerBeat
        const endSec = n.end_seconds
          ?? (n.end_ticks / ticksPerBeat) * secondsPerBeat
        notes.push({
          pitch: n.pitch,
          startSec, endSec,
          velocity: n.velocity || 100,
          trackIdx,
        })
      })
    })

    return {
      minPitch, maxPitch, pitchCount, totalHeight,
      duration, ticksPerBeat, bpm, secondsPerBeat, beatsPerBar,
      notes,
    }
  }, [parsedMidi])

  // ── Track container resizes ──
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const obs = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      setSize({ width, height })
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  // Derived helpers
  const gridWidth = size.width - PIANO_WIDTH
  const pitchToY = useCallback((pitch) => {
    if (!layout) return 0
    return (layout.maxPitch - pitch) * NOTE_HEIGHT - scrollY + HEADER_HEIGHT
  }, [layout, scrollY])

  // ── Auto-scroll: snap on play, follow during playback ──
  useEffect(() => {
    if (!layout) return

    if (isPlaying) {
      const headX = currentTime * pxPerSec

      if (!wasPlayingRef.current) {
        // Just started playing: SNAP view so playhead is 10% from left
        setScrollX(Math.max(0, headX - gridWidth * 0.1))
        wasPlayingRef.current = true
      } else {
        // Already playing: smooth follow when playhead nears right edge
        const rightThreshold = scrollX + gridWidth * 0.85
        if (headX > rightThreshold) {
          setScrollX(Math.max(0, headX - gridWidth * 0.15))
        }
      }
    } else {
      // Paused — keep flag true so resume doesn't jump
      wasPlayingRef.current = true
    }
  }, [currentTime, isPlaying, pxPerSec, gridWidth, layout, scrollX])

  // ── When fully stopped (time resets to 0), reset scroll ──
  useEffect(() => {
    if (!isPlaying && currentTime === 0) {
      wasPlayingRef.current = false
      setScrollX(0)
    }
  }, [isPlaying, currentTime])

  // ═══════════════════════════════════════════
  // DRAWING — Piano Sidebar
  // ═══════════════════════════════════════════

  const drawPiano = useCallback(() => {
    const canvas = pianoRef.current
    if (!canvas || !layout) return
    const ctx = canvas.getContext('2d')
    const { minPitch, maxPitch } = layout

    // HiDPI support
    const dpr = window.devicePixelRatio || 1
    canvas.width = PIANO_WIDTH * dpr
    canvas.height = size.height * dpr
    ctx.scale(dpr, dpr)
    canvas.style.width = PIANO_WIDTH + 'px'
    canvas.style.height = size.height + 'px'

    ctx.fillStyle = THEME.bg
    ctx.fillRect(0, 0, PIANO_WIDTH, size.height)

    for (let pitch = maxPitch; pitch >= minPitch; pitch--) {
      const y = pitchToY(pitch)
      const pc = pitch % 12
      const isBlack = IS_BLACK_KEY[pc]

      // Skip if off-screen
      if (y + NOTE_HEIGHT < 0 || y > size.height) continue

      // Key background
      ctx.fillStyle = isBlack ? THEME.pianoBlack : THEME.pianoWhite
      ctx.fillRect(0, y, PIANO_WIDTH, NOTE_HEIGHT)

      // Subtle border
      ctx.strokeStyle = THEME.pianoBorder
      ctx.strokeRect(0, y, PIANO_WIDTH, NOTE_HEIGHT)

      // Label on C notes (octave markers)
      if (pc === 0) {
        const octave = Math.floor(pitch / 12) - 1
        ctx.fillStyle = THEME.pianoLabel
        ctx.font = '9px monospace'
        ctx.fillText(`C${octave}`, 4, y + NOTE_HEIGHT - 3)
      }
    }
  }, [layout, size, scrollY, pitchToY])

  // ═══════════════════════════════════════════
  // DRAWING — Main Grid + Notes + Playhead
  // ═══════════════════════════════════════════

  const drawGrid = useCallback(() => {
    const canvas = gridRef.current
    if (!canvas || !layout) return
    const ctx = canvas.getContext('2d')

    // HiDPI
    const dpr = window.devicePixelRatio || 1
    canvas.width = gridWidth * dpr
    canvas.height = size.height * dpr
    ctx.scale(dpr, dpr)
    canvas.style.width = gridWidth + 'px'
    canvas.style.height = size.height + 'px'

    const { minPitch, maxPitch, duration, secondsPerBeat, beatsPerBar, notes } = layout

    // ── Background + Row Shading ──
    ctx.fillStyle = THEME.bg
    ctx.fillRect(0, 0, gridWidth, size.height)

    for (let pitch = maxPitch; pitch >= minPitch; pitch--) {
      const y = pitchToY(pitch)
      if (y + NOTE_HEIGHT < 0 || y > size.height) continue

      const isBlack = IS_BLACK_KEY[pitch % 12]
      ctx.fillStyle = isBlack ? THEME.blackKeyRow : THEME.whiteKeyRow
      ctx.fillRect(0, y, gridWidth, NOTE_HEIGHT)

      // Brighter line at every C (octave boundary)
      if (pitch % 12 === 0) {
        ctx.strokeStyle = THEME.octaveLine
        ctx.beginPath()
        ctx.moveTo(0, y + NOTE_HEIGHT)
        ctx.lineTo(gridWidth, y + NOTE_HEIGHT)
        ctx.stroke()
      }
    }

    // ── Beat & Bar Lines ──
    const totalBeats = duration / secondsPerBeat
    for (let beat = 0; beat <= totalBeats + 1; beat++) {
      const x = beat * secondsPerBeat * pxPerSec - scrollX
      if (x < -1 || x > gridWidth + 1) continue

      const isBarLine = beat % beatsPerBar === 0
      ctx.strokeStyle = isBarLine ? THEME.gridBar : THEME.gridBeat
      ctx.lineWidth = isBarLine ? 1.5 : 0.5
      ctx.beginPath()
      ctx.moveTo(x, HEADER_HEIGHT)
      ctx.lineTo(x, size.height)
      ctx.stroke()
    }
    ctx.lineWidth = 1

    // ── Header / Ruler ──
    ctx.fillStyle = THEME.headerBg
    ctx.fillRect(0, 0, gridWidth, HEADER_HEIGHT)

    ctx.fillStyle = THEME.headerText
    ctx.font = '10px monospace'
    for (let beat = 0; beat <= totalBeats + 1; beat++) {
      const x = beat * secondsPerBeat * pxPerSec - scrollX
      if (x < -20 || x > gridWidth + 20) continue

      if (beat % beatsPerBar === 0) {
        const barNum = Math.floor(beat / beatsPerBar) + 1
        ctx.fillText(`${barNum}`, x + 3, 15)

        ctx.strokeStyle = THEME.headerText
        ctx.beginPath()
        ctx.moveTo(x, HEADER_HEIGHT - 5)
        ctx.lineTo(x, HEADER_HEIGHT)
        ctx.stroke()
      }
    }

    // ── Note Blocks ──
    for (const note of notes) {
      const x = note.startSec * pxPerSec - scrollX
      const w = Math.max(2, (note.endSec - note.startSec) * pxPerSec)
      const y = pitchToY(note.pitch)

      // Culling: skip notes fully off-screen
      if (x + w < 0 || x > gridWidth) continue
      if (y + NOTE_HEIGHT < HEADER_HEIGHT || y > size.height) continue

      // Color: track base color adjusted by velocity
      const baseColor = TRACK_COLORS[note.trackIdx % TRACK_COLORS.length]
      const velFactor = 0.4 + (note.velocity / 127) * 0.6
      const noteColor = adjustBrightness(baseColor, velFactor)

      // Draw rounded rectangle
      roundRect(ctx, x, y + 1, w, NOTE_HEIGHT - 2, 3)
      ctx.fillStyle = noteColor
      ctx.fill()
      ctx.strokeStyle = THEME.noteBorder
      ctx.lineWidth = 0.5
      ctx.stroke()

      // Inner highlight — top edge lighter for 3D effect (FL-style)
      if (NOTE_HEIGHT > 8 && w > 6) {
        ctx.strokeStyle = 'rgba(255,255,255,0.15)'
        ctx.beginPath()
        ctx.moveTo(x + 3, y + 2)
        ctx.lineTo(x + w - 3, y + 2)
        ctx.stroke()
      }
    }

    // ── Playhead ──
    const headX = currentTime * pxPerSec - scrollX
    if (headX >= 0 && headX <= gridWidth) {
      // Glow behind playhead
      const glowWidth = 12
      const grad = ctx.createLinearGradient(headX - glowWidth, 0, headX + glowWidth, 0)
      grad.addColorStop(0, 'transparent')
      grad.addColorStop(0.5, THEME.playheadGlow)
      grad.addColorStop(1, 'transparent')
      ctx.fillStyle = grad
      ctx.fillRect(headX - glowWidth, HEADER_HEIGHT, glowWidth * 2, size.height)

      // Playhead line
      ctx.strokeStyle = THEME.playhead
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(headX, HEADER_HEIGHT)
      ctx.lineTo(headX, size.height)
      ctx.stroke()
      ctx.lineWidth = 1

      // Small triangle at top
      ctx.fillStyle = THEME.playhead
      ctx.beginPath()
      ctx.moveTo(headX - 5, HEADER_HEIGHT)
      ctx.lineTo(headX + 5, HEADER_HEIGHT)
      ctx.lineTo(headX, HEADER_HEIGHT + 6)
      ctx.closePath()
      ctx.fill()
    }
  }, [layout, size, scrollX, scrollY, pxPerSec, gridWidth, pitchToY, currentTime])

  // ═══════════════════════════════════════════
  // RENDER LOOP — redraws on scroll/zoom/play
  // ═══════════════════════════════════════════

  useEffect(() => {
    drawPiano()
    drawGrid()
  }, [drawPiano, drawGrid])

  // ═══════════════════════════════════════════
  // EVENT HANDLERS
  // ═══════════════════════════════════════════

  /** Scroll/zoom on wheel */
  const handleWheel = useCallback((e) => {
    e.preventDefault()

    if (e.ctrlKey || e.metaKey) {
      // Zoom
      const delta = e.deltaY > 0 ? -15 : 15
      setPxPerSec(prev => Math.max(MIN_PX_PER_SEC, Math.min(MAX_PX_PER_SEC, prev + delta)))
    } else if (e.shiftKey) {
      // Vertical scroll
      setScrollY(prev => {
        const maxY = layout ? layout.totalHeight - size.height : 0
        return Math.max(0, Math.min(maxY, prev + e.deltaY))
      })
    } else {
      // Horizontal scroll
      const totalW = (layout?.duration ?? 0) * pxPerSec
      setScrollX(prev => Math.max(0, Math.min(totalW - gridWidth, prev + e.deltaY)))
    }
  }, [layout, pxPerSec, size, gridWidth])

  /** Click-to-seek on the grid */
  const handleClick = useCallback((e) => {
    if (!onSeek || !layout) return
    const rect = gridRef.current?.getBoundingClientRect()
    if (!rect) return
    const clickX = e.clientX - rect.left
    const time = (clickX + scrollX) / pxPerSec
    onSeek(Math.max(0, Math.min(layout.duration, time)))
  }, [onSeek, layout, scrollX, pxPerSec])

  // ═══════════════════════════════════════════
  // EMPTY STATE
  // ═══════════════════════════════════════════

  if (!parsedMidi) {
    return (
      <div className="piano-roll-empty">
        <p>Select a MIDI file to view the piano roll</p>
      </div>
    )
  }

  // ═══════════════════════════════════════════
  // JSX — two canvases side by side
  // ═══════════════════════════════════════════

  return (
    <div
      className="piano-roll-container"
      ref={containerRef}
      style={{
        display: 'flex',
        background: THEME.bg,
        borderRadius: '8px',
        overflow: 'hidden',
        border: '1px solid #2a2a4a',
        height: '450px',
        userSelect: 'none',
      }}
    >
      {/* Piano key sidebar */}
      <canvas
        ref={pianoRef}
        style={{ flex: '0 0 auto', cursor: 'default' }}
      />

      {/* Note grid — captures wheel + click events */}
      <canvas
        ref={gridRef}
        onWheel={handleWheel}
        onClick={handleClick}
        style={{ flex: 1, cursor: 'crosshair' }}
      />
    </div>
  )
}

export default PianoRoll