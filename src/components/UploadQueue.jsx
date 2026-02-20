function UploadQueue({ queue }) {
    if (queue.length === 0) return null

    return (
        <div className="upload-queue">
            {queue.map(item => (
                <div key={item.id} className={`queue-item ${item.status}`}>
                    <span className="queue-icon">
                        {item.status === 'pending' && '⏳'}
                        {item.status === 'uploading' && '⬆️'}
                        {item.status === 'success' && '✅'}
                        {item.status === 'error' && '❌'}
                    </span>
                    <span className="queue-name">{item.name}</span>
                    <span className="queue-status">
                        {item.status === 'pending' && 'Waiting...'}
                        {item.status === 'uploading' && 'Uploading...'}
                        {item.status === 'success' && 'Done'}
                        {item.status === 'error' && item.error}
                    </span>
                </div>
            ))}
        </div>
    )
}

export default UploadQueue