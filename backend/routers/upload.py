from fastapi import APIRouter, UploadFile, File, HTTPException
import aiofiles
import uuid
import json
from datetime import datetime
from fastapi.responses import FileResponse


from backend.config import UPLOAD_DIR, MAX_FILE_SIZE_MB, ALLOWED_EXTENSIONS
from backend.core.midi_parser import parse_midi

router = APIRouter(tags=["upload"])

METADATA_FILE = UPLOAD_DIR / "metadata.json"


def load_metadata() -> dict:
    """Load filename mappings."""
    if METADATA_FILE.exists():
        with open(METADATA_FILE, "r") as f:
            return json.load(f)
    return {}


def save_metadata(data: dict):
    """Save filename mappings."""
    with open(METADATA_FILE, "w") as f:
        json.dump(data, f, indent=2)


@router.post("/upload")
async def upload_midi(file: UploadFile = File(...)):
    # Validate extension
    suffix = "." + file.filename.split(".")[-1].lower() if "." in file.filename else ""
    if suffix not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Invalid file type")
    
    # Read and check size
    contents = await file.read()
    if len(contents) / (1024 * 1024) > MAX_FILE_SIZE_MB:
        raise HTTPException(status_code=400, detail="File too large")
    
    # Save with unique name
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    unique_id = uuid.uuid4().hex[:8]
    safe_name = f"{timestamp}_{unique_id}{suffix}"
    
    async with aiofiles.open(UPLOAD_DIR / safe_name, "wb") as f:
        await f.write(contents)
    
    # Store original name mapping
    metadata = load_metadata()
    metadata[safe_name] = {
        "original_name": file.filename,
        "uploaded_at": datetime.now().isoformat(),
        "size_bytes": len(contents)
    }
    save_metadata(metadata)
    
    return {
        "success": True,
        "filename": safe_name,
        "original_name": file.filename,
        "size_bytes": len(contents)
    }


@router.get("/files")
async def list_files():
    metadata = load_metadata()
    files = []
    
    for f in UPLOAD_DIR.glob("*.mid*"):
        file_info = metadata.get(f.name, {})
        files.append({
            "filename": f.name,
            "original_name": file_info.get("original_name", f.name),
            "size_bytes": f.stat().st_size,
            "uploaded_at": file_info.get("uploaded_at", "")
        })
    
    # Sort by newest first
    files.sort(key=lambda x: x.get("uploaded_at", ""), reverse=True)
    return {"files": files}


@router.delete("/files/{filename}")
async def delete_file(filename: str):
    file_path = UPLOAD_DIR / filename
    
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    
    if not file_path.resolve().is_relative_to(UPLOAD_DIR.resolve()):
        raise HTTPException(status_code=403, detail="Access denied")
    
    file_path.unlink()
    
    # Remove from metadata
    metadata = load_metadata()
    if filename in metadata:
        del metadata[filename]
        save_metadata(metadata)
    
    return {"success": True}


@router.get("/files/{filename}/parse")
async def parse_file(filename: str):
    """Parse a MIDI file and return musical data."""
    file_path = UPLOAD_DIR / filename
    
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    
    if not file_path.resolve().is_relative_to(UPLOAD_DIR.resolve()):
        raise HTTPException(status_code=403, detail="Access denied")
    
    try:
        data = parse_midi(file_path)
        
        # Add filename info
        metadata = load_metadata()
        file_info = metadata.get(filename, {})
        data["filename"] = filename
        data["original_name"] = file_info.get("original_name", filename)
        
        return data
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Parse error: {str(e)}")

@router.get("/files/{filename}/raw")
async def get_raw_file(filename: str):
    """Serve the raw MIDI file."""
    file_path = UPLOAD_DIR / filename
    
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    
    if not file_path.resolve().is_relative_to(UPLOAD_DIR.resolve()):
        raise HTTPException(status_code=403, detail="Access denied")
    
    return FileResponse(
        file_path,
        media_type="audio/midi",
        filename=filename
    )

