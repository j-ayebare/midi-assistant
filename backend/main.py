from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path
import os

from backend.routers.upload import router as upload_router

IS_PRODUCTION = os.getenv("RENDER", "") == "true"

app = FastAPI(title="MIDI Assistant")

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

# ── API routes ──
app.include_router(upload_router, prefix="/api")

try:
    from backend.routers.analysis import router as analysis_router
    app.include_router(analysis_router)
except Exception as e:
    print(f"[WARNING] Analysis router not loaded: {e}")

# ── Serve React build ──
dist_path = Path("dist")
if dist_path.exists():
    app.mount("/assets", StaticFiles(directory=dist_path / "assets"), name="static-assets")

    # Serve index.html at root
    @app.get("/")
    async def serve_root():
        return FileResponse(dist_path / "index.html")

    # SPA fallback — serve index.html for non-API 404s
    from starlette.middleware.base import BaseHTTPMiddleware

    class SPAMiddleware(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            response = await call_next(request)
            if response.status_code == 404 and not request.url.path.startswith("/api"):
                return FileResponse(dist_path / "index.html")
            return response

    app.add_middleware(SPAMiddleware)