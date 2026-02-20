import { useState, useEffect, useRef } from 'react'
import DropZone from './components/DropZone'
import FileList from './components/FileList'
import UploadQueue from './components/UploadQueue'
import MidiInfo from './components/MidiInfo'
import MidiPlayer from './components/MidiPlayer'

function App() {
  const [files, setFiles] = useState([])
  const [queue, setQueue] = useState([])
  const [isProcessing, setIsProcessing] = useState(false)

  const [selectedFile, setSelectedFile] = useState(null)
  const [midiData, setMidiData] = useState(null)
  const [isParsing, setIsParsing] = useState(false)

  const queueRef = useRef([])

  useEffect(() => {
    queueRef.current = queue
  }, [queue])

  useEffect(() => {
    loadFiles()
  }, [])

  useEffect(() => {
    if (queue.length > 0 && !isProcessing) {
      processQueue()
    }
  }, [queue, isProcessing])

  useEffect(() => {
    if (selectedFile) {
      parseFile(selectedFile)
    } else {
      setMidiData(null)
    }
  }, [selectedFile])

  async function loadFiles() {
    try {
      const response = await fetch('/api/files')
      const data = await response.json()
      setFiles(data.files)
    } catch (error) {
      console.error('Failed to load files:', error)
    }
  }

  async function parseFile(filename) {
    setIsParsing(true)
    setMidiData(null)
    try {
      const response = await fetch(`/api/files/${filename}/parse`)
      if (!response.ok) throw new Error('Parse failed')
      const data = await response.json()
      setMidiData(data)
    } catch (error) {
      console.error('Parse error:', error)
      setMidiData(null)
    } finally {
      setIsParsing(false)
    }
  }

  function handleFilesSelect(files) {
    const newItems = files.map(file => ({
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      file: file,
      name: file.name,
      status: 'pending',
      error: null
    }))
    setQueue(prev => [...prev, ...newItems])
  }

  async function processQueue() {
    setIsProcessing(true)
    while (true) {
      const currentQueue = queueRef.current
      const pendingIndex = currentQueue.findIndex(item => item.status === 'pending')
      if (pendingIndex === -1) break
      const item = currentQueue[pendingIndex]
      setQueue(prev => prev.map(q =>
        q.id === item.id ? { ...q, status: 'uploading' } : q
      ))
      try {
        await uploadFile(item.file)
        setQueue(prev => prev.map(q =>
          q.id === item.id ? { ...q, status: 'success' } : q
        ))
      } catch (error) {
        setQueue(prev => prev.map(q =>
          q.id === item.id ? { ...q, status: 'error', error: error.message } : q
        ))
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    setIsProcessing(false)
    loadFiles()
    setTimeout(() => {
      setQueue(prev => prev.filter(item => item.status === 'error'))
    }, 3000)
  }

  async function uploadFile(file) {
    const formData = new FormData()
    formData.append('file', file)
    const response = await fetch('/api/upload', {
      method: 'POST',
      body: formData
    })
    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.detail || 'Upload failed')
    }
    return response.json()
  }

  async function handleDelete(filename) {
    if (!confirm('Delete this file?')) return
    try {
      const response = await fetch(`/api/files/${filename}`, {
        method: 'DELETE'
      })
      if (!response.ok) throw new Error('Delete failed')
      if (selectedFile === filename) setSelectedFile(null)
      loadFiles()
    } catch (error) {
      alert(error.message)
    }
  }

  return (
    <div className="app-layout">

      {/* ── LEFT COLUMN ── */}
      <div className="left-column">

        {/* Title + Drop Zone */}
        <div className="panel title-panel">
          <h1>MIDI Assistant</h1>
          <DropZone
            onFilesSelect={handleFilesSelect}
            disabled={isProcessing}
          />
          <UploadQueue queue={queue} />
        </div>

        {/* Uploaded Files */}
        <div className="panel files-panel">
          <h2>Uploaded Files</h2>
          <FileList
            files={files}
            onDelete={handleDelete}
            onSelect={setSelectedFile}
            selectedFile={selectedFile}
          />
        </div>

        {/* MIDI Details */}
        <div className="panel details-panel">
          <h2>MIDI Details</h2>
          <MidiInfo data={midiData} isLoading={isParsing} />
        </div>

      </div>

      {/* ── RIGHT COLUMN ── */}
      <div className="right-column">

        {/* Info / Options Header */}
        <div className="panel info-panel">
          <p className="site-info">
            Upload MIDI files to visualize, play back, and analyze.
            Select a file from the list to get started.
          </p>
        </div>

        {/* Piano Roll + Transport (fills remaining height) */}
        <div className="panel roll-panel">
          <MidiPlayer parsedMidi={midiData} filename={selectedFile} />
        </div>

      </div>

    </div>
  )
}

export default App