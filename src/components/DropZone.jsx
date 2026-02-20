import { useState } from 'react'

function DropZone({ onFilesSelect, disabled }) {
    const [isDragging, setIsDragging] = useState(false)

    function handleDragEnter(e) {
        e.preventDefault()
        if (!disabled) setIsDragging(true)
    }

    function handleDragOver(e) {
        e.preventDefault()
    }

    function handleDragLeave(e) {
        e.preventDefault()
        setIsDragging(false)
    }

    function handleDrop(e) {
        e.preventDefault()
        setIsDragging(false)

        if (disabled) return

        const files = Array.from(e.dataTransfer.files)
        if (files.length > 0) {
            validateAndSelect(files)
        }
    }

    function handleClick() {
        if (disabled) return

        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.mid,.midi'
        input.multiple = true  // Allow multiple selection
        input.onchange = (e) => {
            const files = Array.from(e.target.files)
            if (files.length > 0) {
                validateAndSelect(files)
            }
        }
        input.click()
    }

    function validateAndSelect(files) {
        const validFiles = files.filter(file => {
            const name = file.name.toLowerCase()
            return name.endsWith('.mid') || name.endsWith('.midi')
        })

        const invalidCount = files.length - validFiles.length

        if (invalidCount > 0) {
            alert(`${invalidCount} file(s) skipped (not MIDI format)`)
        }

        if (validFiles.length > 0) {
            onFilesSelect(validFiles)  // Pass array of files
        }
    }

    return (
        <div
            className={`drop-zone ${isDragging ? 'dragging' : ''} ${disabled ? 'disabled' : ''}`}
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={handleClick}
        >
            {isDragging ? (
                <p>Drop it!</p>
            ) : (
                <>
                    <p>Drag & drop MIDI files here</p>
                    <p className="subtext">or click to browse (multiple allowed)</p>
                </>
            )}
        </div>
    )
}

export default DropZone