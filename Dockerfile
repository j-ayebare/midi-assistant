# Stage 1: Build React frontend
FROM node:20-alpine AS frontend-build

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

COPY src/ ./src/
COPY index.html vite.config.js ./
COPY public/ ./public/
RUN npm run build

# Stage 2: Python backend + serve static
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ ./backend/

# Copy built frontend from stage 1
COPY --from=frontend-build /app/dist ./dist/

# Create directories
RUN mkdir -p uploads generated

EXPOSE 10000

CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "10000"]