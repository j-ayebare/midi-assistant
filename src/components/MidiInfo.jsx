function MidiInfo({ data, isLoading }) {
    if (isLoading) {
        return (
            <div className="midi-info loading">
                <p>Parsing MIDI file...</p>
            </div>
        )
    }

    if (!data) {
        return (
            <div className="midi-info empty">
                <p>Select a file to view details</p>
            </div>
        )
    }

    return (
        <div className="midi-info">
            <h3>{data.original_name}</h3>
            
            <div className="info-grid">
                <div className="info-item">
                    <span className="info-label">Duration</span>
                    <span className="info-value">{formatDuration(data.duration_seconds)}</span>
                </div>
                <div className="info-item">
                    <span className="info-label">Tempo</span>
                    <span className="info-value">{data.tempo_bpm} BPM</span>
                </div>
                <div className="info-item">
                    <span className="info-label">Time Sig</span>
                    <span className="info-value">{data.time_signature}</span>
                </div>
                <div className="info-item">
                    <span className="info-label">Tracks</span>
                    <span className="info-value">{data.track_count}</span>
                </div>
                <div className="info-item">
                    <span className="info-label">Notes</span>
                    <span className="info-value">{data.total_notes}</span>
                </div>
                <div className="info-item">
                    <span className="info-label">Range</span>
                    <span className="info-value">
                        {noteName(data.pitch_range.min)} - {noteName(data.pitch_range.max)}
                    </span>
                </div>
            </div>

            <div className="track-list">
                <h4>Tracks</h4>
                {data.tracks.map(track => (
                    <div key={track.index} className="track-item">
                        <span className="track-name">{track.name}</span>
                        <span className="track-notes">{track.note_count} notes</span>
                    </div>
                ))}
            </div>
        </div>
    )
}

function formatDuration(seconds) {
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

function noteName(midiNumber) {
    const octave = Math.floor(midiNumber / 12) - 1
    const note = NOTE_NAMES[midiNumber % 12]
    return `${note}${octave}`
}

export default MidiInfo