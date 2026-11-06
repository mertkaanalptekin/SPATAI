#!/usr/bin/env python3
"""GeoPano3D one-click launcher (standard library only).

    python launch.py              # set up on first run, start, open the browser
    python launch.py --with-ai    # also install PyTorch + Depth-Anything-V2 (large download)
    python launch.py --port 8080 --no-browser
    python launch.py --reinstall  # rebuild the virtual environment

First run: creates ./.venv, installs the Python package, creates .env from .env.example and,
if Node.js is installed and the UI sources changed, rebuilds the web UI. Later runs start in seconds.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request
import venv
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VENV = ROOT / ".venv"
STAMP = VENV / ".geopano3d-install.json"
DIST = ROOT / "frontend" / "dist"
MIN_PY = (3, 11)
IS_WIN = os.name == "nt"

if IS_WIN:
    os.system("")  # enable ANSI colours in the Windows console


def say(msg: str, kind: str = "info") -> None:
    colour = {"info": "36", "ok": "32", "warn": "33", "err": "31", "head": "1;35"}[kind]
    prefix = {"info": "•", "ok": "✔", "warn": "!", "err": "✖", "head": "▶"}[kind]
    try:
        print(f"\033[{colour}m{prefix}\033[0m {msg}", flush=True)
    except UnicodeEncodeError:  # legacy console code pages
        print(f"[{kind}] {msg}", flush=True)


def die(msg: str) -> None:
    say(msg, "err")
    sys.exit(1)


def venv_python() -> Path:
    return VENV / ("Scripts/python.exe" if IS_WIN else "bin/python")


def run(cmd: list[str], label: str | None = None, **kw) -> None:
    say(label or " ".join(str(c) for c in cmd))
    r = subprocess.run([str(c) for c in cmd], **kw)
    if r.returncode != 0:
        die(f"command failed ({r.returncode}): {' '.join(str(c) for c in cmd)}")


# ----------------------------------------------------------------------------- python environment
def requirements(with_ai: bool) -> list[str]:
    """Dependencies straight from pyproject.toml (the app runs from this folder, no package build)."""
    import tomllib  # Python 3.11+

    proj = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]
    reqs = list(proj["dependencies"])
    if with_ai:
        reqs += proj["optional-dependencies"]["ai"]
    return reqs


def install_fingerprint(with_ai: bool) -> str:
    h = hashlib.sha256((ROOT / "pyproject.toml").read_bytes())
    h.update(b"ai" if with_ai else b"base")
    return h.hexdigest()[:16]


def ensure_python_env(with_ai: bool, reinstall: bool) -> Path:
    if reinstall and VENV.exists():
        say("removing old virtual environment")
        shutil.rmtree(VENV)
    py = venv_python()
    if not py.exists():
        say(f"creating virtual environment in {VENV.name}/ (first run only)", "head")
        venv.EnvBuilder(with_pip=True, clear=False).create(VENV)
    previous = {}
    if STAMP.exists():
        try:
            previous = json.loads(STAMP.read_text())
        except ValueError:
            pass
    # keep AI extras once installed, even if --with-ai is not repeated
    with_ai = with_ai or bool(previous.get("with_ai"))
    fp = install_fingerprint(with_ai)
    if previous.get("fingerprint") != fp:
        say("installing GeoPano3D dependencies" + (" incl. PyTorch (this can take a while)" if with_ai else ""), "head")
        reqs = requirements(with_ai)
        run([py, "-m", "pip", "install", "--upgrade", "--disable-pip-version-check", "-q", "pip"], "updating pip")
        run([py, "-m", "pip", "install", "--disable-pip-version-check", "-q", *reqs], f"pip install ({len(reqs)} packages)")
        STAMP.write_text(json.dumps({"fingerprint": fp, "with_ai": with_ai}))
        say("dependencies installed", "ok")
    return py


# ----------------------------------------------------------------------------- web UI
UI_SOURCES = ("src", "index.html", "package.json", "vite.config.ts")


def ui_source_hash() -> str:
    """Must match frontend/stamp-build.mjs (written into dist/.source-hash by `npm run build`)."""
    fe = ROOT / "frontend"
    files: list[Path] = []
    for name in UI_SOURCES:
        p = fe / name
        files += sorted(f for f in p.rglob("*") if f.is_file()) if p.is_dir() else [p] if p.exists() else []
    h = hashlib.sha256()
    for f in sorted(files, key=lambda f: f.relative_to(fe).as_posix()):
        h.update(f.relative_to(fe).as_posix().encode() + b"\0")
        h.update(f.read_bytes().replace(b"\r\n", b"\n") + b"\0")
    return h.hexdigest()


def ensure_ui(force_build: bool) -> None:
    fe = ROOT / "frontend"
    npm = shutil.which("npm")
    stamp = DIST / ".source-hash"
    built = stamp.read_text().strip() if stamp.exists() else ""
    stale = not (DIST / "index.html").exists() or built != ui_source_hash()
    if not (stale or force_build):
        return
    if npm is None:
        if (DIST / "index.html").exists():
            say("UI sources differ from the bundled build, but Node.js is not installed — using the bundled UI", "warn")
            return
        die("The web UI is not built and Node.js (npm) is not installed. Install Node.js 20+ from https://nodejs.org and re-run.")
    say("building the web UI", "head")
    if not (fe / "node_modules").exists():
        run([npm, "ci" if (fe / "package-lock.json").exists() else "install", "--no-audit", "--no-fund"], cwd=fe, shell=IS_WIN)
    run([npm, "run", "build"], cwd=fe, shell=IS_WIN)
    say("web UI built", "ok")


# ----------------------------------------------------------------------------- server
def ensure_env_file() -> None:
    env, example = ROOT / ".env", ROOT / ".env.example"
    if not env.exists() and example.exists() and "GEOPANO3D_ENV_FILE" not in os.environ:
        shutil.copy(example, env)
        say("created .env (add API keys later in the app: ⚙ Settings)", "ok")


def health(port: int) -> dict | None:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1.5) as r:
            return json.loads(r.read())
    except Exception:
        return None


def port_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        if not IS_WIN:  # like uvicorn: ignore TIME_WAIT leftovers of a previous run (Windows semantics differ)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((host, port))
            return True
        except OSError:
            return False


def main() -> None:
    ap = argparse.ArgumentParser(description="Start GeoPano3D Studio")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1", help="use 0.0.0.0 to allow other machines on your network")
    ap.add_argument("--with-ai", action="store_true", help="install PyTorch + transformers for real Depth-Anything-V2")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--reinstall", action="store_true", help="recreate the virtual environment")
    ap.add_argument("--build-ui", action="store_true", help="force a rebuild of the web UI (needs Node.js)")
    args = ap.parse_args()

    if sys.version_info < MIN_PY:
        die(f"Python {MIN_PY[0]}.{MIN_PY[1]}+ is required (found {sys.version.split()[0]}). Get it from https://www.python.org/downloads/")

    say("GeoPano3D Studio", "head")
    py = ensure_python_env(args.with_ai, args.reinstall)
    ensure_ui(args.build_ui)
    ensure_env_file()

    port = args.port
    if health(port):
        url = f"http://127.0.0.1:{port}"
        say(f"GeoPano3D is already running at {url}", "ok")
        if not args.no_browser:
            webbrowser.open(url)
        return
    while not port_free(args.host, port):
        say(f"port {port} is busy, trying {port + 1}", "warn")
        port += 1

    cmd = [str(py), "-m", "uvicorn", "backend.main:app", "--host", args.host, "--port", str(port), "--log-level", "warning"]
    proc = subprocess.Popen(cmd, cwd=ROOT)
    url = f"http://127.0.0.1:{port}"
    say("starting server …")
    for _ in range(240):
        if proc.poll() is not None:
            die("the server stopped during start-up (see the messages above)")
        h = health(port)
        if h:
            ai = h["ai_depth"]
            srcs = [k for k, v in h["sources"].items() if v and k not in ("local", "synthetic")]
            say(f"GeoPano3D Studio is running at \033[1m{url}\033[0m", "ok")
            say(f"AI depth: {'built-in fallback' if ai['backend'] == 'mock' else ai['backend']} on {ai['device']}"
                + ("" if ai["backend"] == "transformers" else "  (run with --with-ai for Depth-Anything-V2)"))
            say("imagery: " + (", ".join(srcs) if srcs else "demo street only — add API keys in ⚙ Settings"))
            if args.host != "127.0.0.1":
                say(f"listening on {args.host}:{port} (reachable from your network)", "warn")
            say("press Ctrl+C to stop")
            if not args.no_browser:
                webbrowser.open(url)
            break
        time.sleep(0.5)
    else:
        proc.terminate()
        die("the server did not answer within 2 minutes")

    def _term(*_):  # service managers / `kill` -> same clean shutdown as Ctrl+C
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, _term)
    try:
        proc.wait()
    except KeyboardInterrupt:
        say("stopping …")
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        say("stopped", "ok")


if __name__ == "__main__":
    main()
