from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path
import os

from backend.routers.upload import router as upload_router

# Check if we're on Render
IS_PRODUCTION = os.getenv("RENDER", "") == "true"

app = FastAPI(title="MIDI Assistant")

# CORS
if IS_PRODUCTION:
    origins = []
else:
    origins = ["http://localhost:5173", "http://localhost:3000"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins if origins else ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# API routes
app.include_router(upload_router)

# Try to include analysis router (won't crash if not ready yet)
try:
    from backend.routers.analysis import router as analysis_router
    app.include_router(analysis_router)
except Exception as e:
    print(f"[WARNING] Analysis router not loaded: {e}")

# Serve React build in production
dist_path = Path("dist")
if dist_path.exists():
    # Static assets (js, css, images)
    app.mount("/assets", StaticFiles(directory=dist_path / "assets"), name="static-assets")

    # Catch-all — serve index.html for any non-API route
    @app.get("/{full_path:path}")
    async def serve_react(full_path: str):
        file_path = dist_path / full_path
        if file_path.exists() and file_path.is_file():
            return FileResponse(file_path)
        return FileResponse(dist_path / "index.html")