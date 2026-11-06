# GeoPano3D Studio — docker compose up --build   (then open http://localhost:8000)
# Build with real Depth-Anything-V2:  docker compose build --build-arg WITH_AI=1

FROM node:22-slim AS ui
WORKDIR /ui
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim
ARG WITH_AI=0
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY pyproject.toml launch.py ./
RUN python -c "import launch, subprocess, sys; subprocess.check_call([sys.executable, '-m', 'pip', 'install', *launch.requirements(bool(int('${WITH_AI}')))])"
COPY backend ./backend
COPY scripts ./scripts
COPY .env.example ./
COPY --from=ui /ui/dist ./frontend/dist
# settings (.env) and exports live in the /data volume so they survive container rebuilds
ENV GEOPANO3D_ENV_FILE=/data/.env EXPORT_WORK_DIR=/data/exports ALLOW_REMOTE_SETTINGS=true
VOLUME ["/data"]
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health')"
CMD ["sh", "-c", "[ -f /data/.env ] || cp .env.example /data/.env; exec uvicorn backend.main:app --host 0.0.0.0 --port 8000"]
