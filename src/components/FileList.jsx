function FileList({ files, onDelete, onSelect, selectedFile }) {
    if (files.length === 0) {
        return (
            <div className="file-list empty">
                <p>No files uploaded yet</p>
            </div>
        )
    }

    return (
        <div className="file-list">
            {files.map(file => (
                <div 
                    key={file.filename} 
                    className={`file-item ${selectedFile === file.filename ? 'selected' : ''}`}
                    onClick={() => onSelect(file.filename)}
                >
                    <div className="file-info">
                        <span className="file-icon">🎵</span>
                        <div className="file-details">
                            <span className="file-name">{file.original_name}</span>
                            <span className="file-meta">
                                {formatSize(file.size_bytes)}
                                {file.uploaded_at && ` • ${formatDate(file.uploaded_at)}`}
                            </span>
                        </div>
                    </div>
                    <button 
                        className="delete-btn"
                        onClick={(e) => {
                            e.stopPropagation()  // Don't trigger select
                            onDelete(file.filename)
                        }}
                    >
                        Delete
                    </button>
                </div>
            ))}
        </div>
    )
}

function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(isoString) {
    const date = new Date(isoString)
    return date.toLocaleDateString()
}

export default FileList