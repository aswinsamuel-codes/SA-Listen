# SA Listen - AI Vocal Analysis
# Copyright (C) 2024 Sukin S, Aswin Samuel A.
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from typing import Optional
from urllib.parse import urlparse

import librosa
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

# All paths are resolved from this file, so the server behaves the same
# whether it is started from the repo root or from backend/.
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_DIR = os.path.dirname(BASE_DIR)
STATIC_DIR = os.path.join(BASE_DIR, "static")
FRONTEND_DIR = os.path.join(REPO_DIR, "sa-listen-ui")
LOGO_DIR = os.path.join(REPO_DIR, "logo")
ASSETS_DIR = os.path.join(REPO_DIR, "assets")

# Delete generated stems older than this many hours (0 = keep forever).
# Each split writes ~5 full-length WAVs, so without this the folder grows
# without bound.
STEM_TTL_HOURS = float(os.environ.get("SA_LISTEN_STEM_TTL_HOURS", "0"))

AUDIO_EXTENSIONS = {".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac", ".opus", ".webm", ".wma", ".aiff", ".aif"}

DEMUCS_MODEL = "htdemucs_6s"  # 6 stems: bass, drums, guitar, other, piano, vocals
STEM_NAMES = ["vocals", "drums", "bass", "piano", "other"]

# Karaoke uses the faster 4-stem model in two-stem mode (vocals / everything else).
KARAOKE_MODEL = "htdemucs"
KARAOKE_DIR = os.path.join(STATIC_DIR, "karaoke")
KARAOKE_MAX_MINUTES = float(os.environ.get("SA_LISTEN_MAX_SONG_MINUTES", "10"))
YOUTUBE_HOSTS = ("youtube.com", "youtu.be")

os.makedirs(STATIC_DIR, exist_ok=True)
os.makedirs(KARAOKE_DIR, exist_ok=True)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
if os.path.isdir(ASSETS_DIR):
    app.mount("/assets", StaticFiles(directory=ASSETS_DIR), name="assets")
if os.path.isdir(LOGO_DIR):
    app.mount("/logo", StaticFiles(directory=LOGO_DIR), name="logo")


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

def safe_stem(filename: str) -> str:
    """Return a filesystem- and URL-safe base name (no extension, no path).

    Upload filenames come from the client, so path separators ("../") must
    never reach os.path.join, and characters like '#' or '?' would break the
    /static URLs handed back to the browser.
    """
    base = os.path.splitext(os.path.basename(filename or ""))[0]
    base = re.sub(r"[^\w\-]+", "_", base).strip("_")
    return base[:80] or "audio"


def validate_audio(file: UploadFile) -> str:
    """Reject non-audio uploads; returns the (lower-cased) file extension."""
    ext = os.path.splitext(file.filename or "")[1].lower()
    content_type = file.content_type or ""
    if not (content_type.startswith("audio/") or ext in AUDIO_EXTENSIONS):
        raise HTTPException(status_code=400, detail="Invalid file type. Must be an audio file.")
    return ext if ext in AUDIO_EXTENSIONS else ".audio"


def save_upload(file: UploadFile, directory: str, ext: str) -> str:
    path = os.path.join(directory, f"{safe_stem(file.filename)}{ext}")
    with open(path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
    return path


def cleanup_old_stems() -> None:
    if STEM_TTL_HOURS <= 0:
        return
    cutoff = time.time() - STEM_TTL_HOURS * 3600
    for name in os.listdir(STATIC_DIR):
        path = os.path.join(STATIC_DIR, name)
        if name.endswith(".wav") and os.path.isfile(path) and os.path.getmtime(path) < cutoff:
            try:
                os.remove(path)
            except OSError as e:
                print(f"Could not remove old stem {name}: {e}")


def demucs_device() -> str:
    try:
        import torch
        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


# --------------------------------------------------------------------------
# Analysis
# --------------------------------------------------------------------------

KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

# Krumhansl-Schmuckler key profiles
KS_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KS_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

# Binary chord-tone templates used per beat
CHORD_MAJOR = np.array([1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1])
CHORD_MINOR = np.array([1, 0, 1, 1, 0, 1, 0, 1, 0, 1, 0, 0])


def _correlation(a, b) -> float:
    # Silent / flat chroma has zero variance -> corrcoef is NaN; treat as no match.
    with np.errstate(invalid="ignore", divide="ignore"):
        c = np.corrcoef(a, b)[0, 1]
    return -1.0 if np.isnan(c) else float(c)


def estimate_key(chroma):
    """Estimate the musical key (e.g. 'C Major', 'F# Minor') from a chromagram."""
    chroma_sum = np.sum(chroma, axis=1)

    best_corr, best_key = -1.0, ""
    for quality, profile in (("Major", KS_MAJOR), ("Minor", KS_MINOR)):
        for root in range(12):
            corr = _correlation(chroma_sum, np.roll(profile, root))
            if corr > best_corr:
                best_corr, best_key = corr, f"{KEY_NAMES[root]} {quality}"
    return best_key


def estimate_chord_segments(chroma, sr, beat_frames):
    """Estimate a chord for each beat. Returns [{ "time": float, "chord": str }]."""
    if len(beat_frames) == 0:
        return []

    # Average the chroma between consecutive beats
    chroma_synced = librosa.util.sync(chroma, beat_frames, aggregate=np.median)
    beat_times = librosa.frames_to_time(beat_frames, sr=sr)

    segments = []
    for i in range(min(chroma_synced.shape[1], len(beat_times))):
        col = chroma_synced[:, i]
        best_corr, best_chord = -1.0, "--"
        for root in range(12):
            for suffix, template in (("Maj", CHORD_MAJOR), ("Min", CHORD_MINOR)):
                corr = _correlation(col, np.roll(template, root))
                if corr > best_corr:
                    best_corr, best_chord = corr, f"{KEY_NAMES[root]} {suffix}"
        segments.append({"time": float(beat_times[i]), "chord": best_chord})
    return segments


def analyze_path(path, duration=120):
    """Tempo, key and per-beat chords for an audio file.

    Only the first `duration` seconds are analyzed (None = whole file).
    """
    y, sr = librosa.load(path, duration=duration)

    onset_env = librosa.onset.onset_strength(y=y, sr=sr)
    tempo, beat_frames = librosa.beat.beat_track(onset_envelope=onset_env, sr=sr)
    tempo = float(np.atleast_1d(tempo)[0])

    # Compute the chromagram once and share it (it is the expensive part).
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    detected_key = estimate_key(chroma)

    return {
        "tempo": round(tempo, 1),
        "key": detected_key,
        "main_chord": detected_key.split(' ')[0] if detected_key else "",
        "chords": estimate_chord_segments(chroma, sr, beat_frames),
    }


# --------------------------------------------------------------------------
# Routes
#
# Handlers are plain `def` (not `async def`) on purpose: librosa and Demucs
# are CPU-bound and blocking, so FastAPI runs them in its thread pool. As
# `async def` they blocked the event loop, freezing the whole server
# (including static files and other requests) for the length of a split.
# --------------------------------------------------------------------------

@app.post("/analyze")
def analyze_audio(file: UploadFile = File(...)):
    ext = validate_audio(file)
    temp_dir = tempfile.mkdtemp(prefix="sa_listen_")
    try:
        temp_path = save_upload(file, temp_dir, ext)
        return {"filename": file.filename, **analyze_path(temp_path)}
    except HTTPException:
        raise
    except Exception as e:
        print(f"Analyze error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


@app.post("/split", status_code=200)
def split_audio(file: UploadFile = File(...)):
    print(f"Received split request for file: {file.filename}")
    ext = validate_audio(file)
    cleanup_old_stems()

    unique_name = f"{safe_stem(file.filename)}_{os.urandom(4).hex()}"
    output_map = {stem: f"{unique_name}_{stem}.wav" for stem in STEM_NAMES}

    # Each job gets its own working dir: the upload is not exposed under
    # /static, and concurrent splits cannot delete each other's output.
    work_dir = tempfile.mkdtemp(prefix="sa_listen_split_")
    try:
        input_path = save_upload(file, work_dir, ext)
        out_dir = os.path.join(work_dir, "separated")

        device = demucs_device()
        print(f"Running Demucs ({DEMUCS_MODEL}, {device}) on {input_path}...")
        cmd = [sys.executable, "-m", "demucs", "-n", DEMUCS_MODEL, "-d", device, "--out", out_dir, input_path]
        subprocess.run(cmd, check=True)

        # Demucs writes to <out>/<model>/<input name without ext>/<stem>.wav
        demucs_output_dir = os.path.join(out_dir, DEMUCS_MODEL, os.path.splitext(os.path.basename(input_path))[0])
        if not os.path.isdir(demucs_output_dir):
            raise FileNotFoundError(f"Demucs output folder not found at: {demucs_output_dir}")

        for stem in STEM_NAMES:
            src = os.path.join(demucs_output_dir, f"{stem}.wav")
            target = os.path.join(STATIC_DIR, output_map[stem])
            if os.path.exists(src):
                shutil.move(src, target)
            elif stem == "piano" and os.path.exists(os.path.join(demucs_output_dir, "other.wav")):
                # 4-stem models have no piano; fall back to "other".
                shutil.copy(os.path.join(demucs_output_dir, "other.wav"), target)
            else:
                print(f"Warning: stem '{stem}' not produced by Demucs.")

        return {k: f"/static/{v}" for k, v in output_map.items()}

    except subprocess.CalledProcessError as e:
        print(f"Demucs CLI failed: {e}")
        raise HTTPException(
            status_code=500,
            detail="Audio separation failed. Is demucs installed (pip install demucs) and FFmpeg on PATH?",
        )
    except HTTPException:
        raise
    except Exception as e:
        print(f"Split error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


# --------------------------------------------------------------------------
# Karaoke: YouTube link or uploaded file -> instrumental + guide vocal
#
# Runs as a background job because download + separation takes minutes on
# CPU. The client polls GET /karaoke/{job_id} for stage/progress. Results
# are cached per YouTube video id / file hash under static/karaoke/, so a
# song a learner practises again loads instantly.
# --------------------------------------------------------------------------

KARAOKE_JOBS = {}
KARAOKE_JOBS_LOCK = threading.Lock()
# Separation saturates the CPU/GPU; run one at a time and queue the rest.
SEPARATION_LOCK = threading.Lock()


def is_youtube_url(url: str) -> bool:
    try:
        parsed = urlparse(url.strip())
    except ValueError:
        return False
    host = (parsed.hostname or "").lower()
    return parsed.scheme in ("http", "https") and any(
        host == h or host.endswith("." + h) for h in YOUTUBE_HOSTS
    )


def _update_job(job_id, **fields):
    with KARAOKE_JOBS_LOCK:
        if job_id in KARAOKE_JOBS:
            KARAOKE_JOBS[job_id].update(fields)


def _cached_karaoke(cache_key):
    meta_path = os.path.join(KARAOKE_DIR, cache_key, "meta.json")
    if not os.path.exists(meta_path):
        return None
    with open(meta_path, encoding="utf-8") as f:
        return json.load(f)


def _file_hash(path):
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()[:16]


def _download_youtube(job_id, url, work_dir):
    """Fetch the best audio stream. Returns (cache_key, source_path or None if cached, title)."""
    try:
        import yt_dlp
    except ImportError:
        raise RuntimeError("yt-dlp is not installed. Run: pip install yt-dlp")

    def on_progress(d):
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            if total:
                _update_job(job_id, progress=min(100, round(100 * d.get("downloaded_bytes", 0) / total)))

    opts = {
        "format": "bestaudio/best",
        "outtmpl": os.path.join(work_dir, "source.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "progress_hooks": [on_progress],
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
        if info.get("_type") == "playlist" or "entries" in info:
            raise ValueError("Please paste a link to a single video, not a playlist.")
        if info.get("is_live"):
            raise ValueError("Live streams can't be turned into karaoke.")
        duration = info.get("duration") or 0
        if duration > KARAOKE_MAX_MINUTES * 60:
            raise ValueError(f"That video is {duration // 60:.0f} min long; the limit is {KARAOKE_MAX_MINUTES:.0f} min.")

        title = info.get("title") or "YouTube track"
        cache_key = "yt_" + re.sub(r"[^\w\-]", "_", str(info.get("id", uuid.uuid4().hex)))
        if _cached_karaoke(cache_key):
            return cache_key, None, title

        _update_job(job_id, stage="Downloading audio", progress=0, title=title)
        ydl.process_ie_result(info, download=True)

    for name in os.listdir(work_dir):
        if name.startswith("source."):
            return cache_key, os.path.join(work_dir, name), title
    raise RuntimeError("Download finished but no audio file was produced.")


def _separate_vocals(job_id, source_path, work_dir, dest_dir):
    """Demucs two-stem split -> dest_dir/instrumental.mp3 + dest_dir/vocals.mp3."""
    out_dir = os.path.join(work_dir, "separated")
    cmd = [
        sys.executable, "-m", "demucs",
        "-n", KARAOKE_MODEL, "--two-stems", "vocals",
        "--mp3", "--mp3-bitrate", "192",
        "-d", demucs_device(), "--out", out_dir, source_path,
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

    # Demucs reports progress with tqdm on stderr ("  42%|████  | ...").
    tail, pending = [], b""
    while True:
        chunk = proc.stderr.read1(512)
        if not chunk:
            break
        pending += chunk
        *lines, pending = re.split(rb"[\r\n]", pending)
        for raw in lines:
            text = raw.decode(errors="ignore").strip()
            match = re.search(r"(\d{1,3})%\|", text)
            if match:
                _update_job(job_id, progress=int(match.group(1)))
            elif text:
                tail = (tail + [text])[-5:]
    code = proc.wait()
    if code != 0:
        print("Demucs failed:\n" + "\n".join(tail))
        hint = tail[-1] if tail else f"exit code {code}"
        raise RuntimeError(f"Vocal separation failed ({hint}). Is demucs installed and FFmpeg on PATH?")

    stem_dir = os.path.join(out_dir, KARAOKE_MODEL, os.path.splitext(os.path.basename(source_path))[0])
    os.makedirs(dest_dir, exist_ok=True)
    shutil.move(os.path.join(stem_dir, "no_vocals.mp3"), os.path.join(dest_dir, "instrumental.mp3"))
    shutil.move(os.path.join(stem_dir, "vocals.mp3"), os.path.join(dest_dir, "vocals.mp3"))


def _run_karaoke_job(job_id, work_dir, url=None, upload_path=None, upload_name=None):
    try:
        if url:
            _update_job(job_id, stage="Looking up video")
            cache_key, source_path, title = _download_youtube(job_id, url, work_dir)
        else:
            cache_key = "file_" + _file_hash(upload_path)
            source_path, title = upload_path, os.path.splitext(upload_name or "Uploaded track")[0]

        result = _cached_karaoke(cache_key)
        if not result:
            _update_job(job_id, stage="Waiting for another song to finish", progress=None, title=title)
            with SEPARATION_LOCK:
                result = _cached_karaoke(cache_key)  # may have been built while we waited
                if not result:
                    dest_dir = os.path.join(KARAOKE_DIR, cache_key)
                    _update_job(job_id, stage="Removing vocals", progress=0)
                    _separate_vocals(job_id, source_path, work_dir, dest_dir)

                    _update_job(job_id, stage="Analyzing tempo and chords", progress=None)
                    analysis = analyze_path(os.path.join(dest_dir, "instrumental.mp3"), duration=None)

                    base_url = f"/static/karaoke/{cache_key}"
                    result = {
                        "title": title,
                        "source": url,
                        "instrumental": f"{base_url}/instrumental.mp3",
                        "vocals": f"{base_url}/vocals.mp3",
                        **analysis,
                    }
                    tmp_meta = os.path.join(dest_dir, "meta.json.tmp")
                    with open(tmp_meta, "w", encoding="utf-8") as f:
                        json.dump(result, f)
                    os.replace(tmp_meta, os.path.join(dest_dir, "meta.json"))

        _update_job(job_id, status="done", stage="Ready", progress=100, title=result.get("title"), result=result)
    except Exception as e:
        print(f"Karaoke job {job_id} failed: {e}")
        _update_job(job_id, status="error", error=str(e))
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


@app.post("/karaoke")
def create_karaoke(url: Optional[str] = Form(None), file: Optional[UploadFile] = File(None)):
    url = (url or "").strip()
    if not url and file is None:
        raise HTTPException(status_code=400, detail="Send a YouTube link or an audio file.")
    if url and not is_youtube_url(url):
        raise HTTPException(status_code=400, detail="Please paste a YouTube link (youtube.com or youtu.be).")

    work_dir = tempfile.mkdtemp(prefix="sa_listen_karaoke_")
    upload_path = None
    try:
        if not url:
            upload_path = save_upload(file, work_dir, validate_audio(file))
    except Exception:
        shutil.rmtree(work_dir, ignore_errors=True)
        raise

    job_id = uuid.uuid4().hex
    with KARAOKE_JOBS_LOCK:
        # Forget finished jobs older than a day so the dict cannot grow forever.
        cutoff = time.time() - 86400
        for old_id in [j for j, v in KARAOKE_JOBS.items() if v["created"] < cutoff and v["status"] != "running"]:
            del KARAOKE_JOBS[old_id]
        KARAOKE_JOBS[job_id] = {
            "status": "running", "stage": "Starting", "progress": None,
            "title": None, "error": None, "result": None, "created": time.time(),
        }

    threading.Thread(
        target=_run_karaoke_job,
        args=(job_id, work_dir),
        kwargs={"url": url or None, "upload_path": upload_path, "upload_name": file.filename if file else None},
        daemon=True,
    ).start()
    return {"job_id": job_id}


@app.get("/karaoke/{job_id}")
def karaoke_status(job_id: str):
    with KARAOKE_JOBS_LOCK:
        job = dict(KARAOKE_JOBS.get(job_id) or {})
    if not job:
        raise HTTPException(status_code=404, detail="Unknown karaoke job (the server may have restarted).")
    job.pop("created", None)
    return job


# Frontend catch-all must be mounted last so it does not shadow the API.
if os.path.isdir(FRONTEND_DIR):
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
