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

"""Teacher / student practice studios (prototype).

A teacher creates a studio and shares a join code. Students join, practise
the teacher's assignments with note-level feedback, and send takes back.
The teacher reviews takes and leaves time-stamped comments.

Access model (prototype only): every teacher and student gets a random
secret token that lives in their personal link. There are no passwords.
Anyone holding a link has that person's access, and uploaded media URLs
are unguessable but public. Replace with real accounts before launch.
"""

import json
import os
import re
import secrets
import shutil
import sqlite3
import tempfile
import threading
import time
from typing import Callable, Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api")

_DB_PATH = None
_MEDIA_DIR = None
_SEPARATE: Optional[Callable] = None
_VALIDATE_AUDIO: Optional[Callable] = None
_DB_LOCK = threading.Lock()

MAX_UPLOAD_BYTES = 60 * 1024 * 1024
LEVELS = {"beginner": 50, "intermediate": 30, "advanced": 18}  # tolerance in cents
JOIN_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O/1/I confusion

SCHEMA = """
CREATE TABLE IF NOT EXISTS studios (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    teacher_name TEXT NOT NULL,
    teacher_token TEXT NOT NULL UNIQUE,
    join_code TEXT NOT NULL UNIQUE,
    created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY,
    studio_id INTEGER NOT NULL REFERENCES studios(id),
    name TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS assignments (
    id INTEGER PRIMARY KEY,
    studio_id INTEGER NOT NULL REFERENCES studios(id),
    title TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    sa_hz REAL NOT NULL,
    level TEXT NOT NULL,
    guide_url TEXT,
    backing_url TEXT,
    status TEXT NOT NULL,           -- processing | ready | error
    error TEXT,
    created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS takes (
    id INTEGER PRIMARY KEY,
    assignment_id INTEGER NOT NULL REFERENCES assignments(id),
    student_id INTEGER NOT NULL REFERENCES students(id),
    audio_url TEXT NOT NULL,
    duration REAL NOT NULL,
    score INTEGER,
    summary TEXT NOT NULL DEFAULT '{}',   -- JSON: counts, per-note results, tips
    frames TEXT NOT NULL DEFAULT '[]',    -- JSON: [[t, hz|0], ...] for the review trace
    created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY,
    take_id INTEGER NOT NULL REFERENCES takes(id),
    time_sec REAL NOT NULL,
    text TEXT NOT NULL,
    created REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_takes_assignment ON takes(assignment_id);
CREATE INDEX IF NOT EXISTS idx_takes_student ON takes(student_id);
CREATE INDEX IF NOT EXISTS idx_comments_take ON comments(take_id);
"""


def configure(data_dir: str, separate: Callable, validate_audio: Callable) -> None:
    """Called once by main.py. `separate(path, name)` returns a karaoke result dict."""
    global _DB_PATH, _MEDIA_DIR, _SEPARATE, _VALIDATE_AUDIO
    os.makedirs(data_dir, exist_ok=True)
    _MEDIA_DIR = os.path.join(data_dir, "media")
    os.makedirs(_MEDIA_DIR, exist_ok=True)
    _DB_PATH = os.path.join(data_dir, "studio.db")
    _SEPARATE = separate
    _VALIDATE_AUDIO = validate_audio
    with _connect() as db:
        db.executescript(SCHEMA)


def media_dir() -> str:
    return _MEDIA_DIR


def _connect():
    db = sqlite3.connect(_DB_PATH, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    return db


def _query(sql, params=(), one=False):
    with _DB_LOCK, _connect() as db:
        rows = db.execute(sql, params).fetchall()
    rows = [dict(r) for r in rows]
    return (rows[0] if rows else None) if one else rows


def _execute(sql, params=()):
    with _DB_LOCK, _connect() as db:
        cur = db.execute(sql, params)
        db.commit()
        return cur.lastrowid


def _clean_text(value: str, limit: int) -> str:
    return re.sub(r"\s+", " ", (value or "")).strip()[:limit]


def _new_join_code() -> str:
    while True:
        code = "".join(secrets.choice(JOIN_CODE_ALPHABET) for _ in range(6))
        if not _query("SELECT 1 FROM studios WHERE join_code = ?", (code,), one=True):
            return code


def _save_media(upload: UploadFile, prefix: str, ext: str) -> str:
    """Store an upload under data/media with an unguessable name; returns its URL."""
    name = f"{prefix}_{secrets.token_urlsafe(12)}{ext}"
    path = os.path.join(_MEDIA_DIR, name)
    size = 0
    with open(path, "wb") as out:
        while True:
            chunk = upload.file.read(1 << 20)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_UPLOAD_BYTES:
                out.close()
                os.remove(path)
                raise HTTPException(status_code=413, detail="File is too large (60 MB max).")
            out.write(chunk)
    return f"/media/{name}"


def _teacher_studio(token: str):
    studio = _query("SELECT * FROM studios WHERE teacher_token = ?", (token,), one=True)
    if not studio:
        raise HTTPException(status_code=404, detail="Unknown teacher link.")
    return studio


def _student(token: str):
    student = _query("SELECT * FROM students WHERE token = ?", (token,), one=True)
    if not student:
        raise HTTPException(status_code=404, detail="Unknown student link.")
    return student


def _public_assignment(a):
    return {k: a[k] for k in ("id", "title", "notes", "sa_hz", "level", "guide_url", "backing_url", "status", "error", "created")} | {
        "tolerance": LEVELS.get(a["level"], 50)
    }


def _public_take(t, with_frames=False):
    out = {k: t[k] for k in ("id", "assignment_id", "student_id", "audio_url", "duration", "score", "created")}
    out["summary"] = json.loads(t["summary"] or "{}")
    if with_frames:
        out["frames"] = json.loads(t["frames"] or "[]")
    out["comments"] = _query("SELECT id, time_sec, text, created FROM comments WHERE take_id = ? ORDER BY time_sec", (t["id"],))
    return out


# --------------------------------------------------------------------------
# Studios and membership
# --------------------------------------------------------------------------

class StudioIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    teacher_name: str = Field(min_length=1, max_length=60)


class JoinIn(BaseModel):
    join_code: str = Field(min_length=4, max_length=12)
    name: str = Field(min_length=1, max_length=60)


class CommentIn(BaseModel):
    time_sec: float = Field(ge=0, le=7200)
    text: str = Field(min_length=1, max_length=1000)


@router.post("/studios")
def create_studio(body: StudioIn):
    token = secrets.token_urlsafe(18)
    code = _new_join_code()
    _execute(
        "INSERT INTO studios (name, teacher_name, teacher_token, join_code, created) VALUES (?, ?, ?, ?, ?)",
        (_clean_text(body.name, 80), _clean_text(body.teacher_name, 60), token, code, time.time()),
    )
    return {"teacher_token": token, "join_code": code}


@router.post("/join")
def join_studio(body: JoinIn):
    studio = _query("SELECT * FROM studios WHERE join_code = ?", (body.join_code.strip().upper(),), one=True)
    if not studio:
        raise HTTPException(status_code=404, detail="No studio has that code. Check it with your teacher.")
    token = secrets.token_urlsafe(18)
    _execute(
        "INSERT INTO students (studio_id, name, token, created) VALUES (?, ?, ?, ?)",
        (studio["id"], _clean_text(body.name, 60), token, time.time()),
    )
    return {"student_token": token, "studio_name": studio["name"]}


@router.get("/teacher/{token}")
def teacher_dashboard(token: str):
    studio = _teacher_studio(token)
    week_ago = time.time() - 7 * 86400

    students = _query("SELECT id, name, created FROM students WHERE studio_id = ? ORDER BY name", (studio["id"],))
    for s in students:
        stats = _query(
            """SELECT COUNT(*) AS takes, COALESCE(SUM(duration), 0) AS seconds, AVG(score) AS avg_score,
                      MAX(created) AS last_active
               FROM takes WHERE student_id = ? AND created >= ?""",
            (s["id"], week_ago), one=True,
        )
        last = _query("SELECT MAX(created) AS t FROM takes WHERE student_id = ?", (s["id"],), one=True)
        s["week"] = {
            "takes": stats["takes"],
            "minutes": round(stats["seconds"] / 60, 1),
            "avg_score": round(stats["avg_score"]) if stats["avg_score"] is not None else None,
        }
        s["last_active"] = last["t"]

    assignments = [_public_assignment(a) for a in _query(
        "SELECT * FROM assignments WHERE studio_id = ? ORDER BY created DESC", (studio["id"],))]

    takes = _query(
        """SELECT t.*, s.name AS student_name, a.title AS assignment_title
           FROM takes t JOIN students s ON s.id = t.student_id JOIN assignments a ON a.id = t.assignment_id
           WHERE a.studio_id = ? ORDER BY t.created DESC LIMIT 100""",
        (studio["id"],),
    )
    recent = []
    for t in takes:
        item = _public_take(t)
        item["student_name"] = t["student_name"]
        item["assignment_title"] = t["assignment_title"]
        recent.append(item)

    return {
        "studio": {"name": studio["name"], "teacher_name": studio["teacher_name"], "join_code": studio["join_code"]},
        "students": students,
        "assignments": assignments,
        "takes": recent,
    }


@router.get("/student/{token}")
def student_home(token: str):
    student = _student(token)
    studio = _query("SELECT name, teacher_name FROM studios WHERE id = ?", (student["studio_id"],), one=True)
    assignments = [_public_assignment(a) for a in _query(
        "SELECT * FROM assignments WHERE studio_id = ? AND status != 'error' ORDER BY created DESC",
        (student["studio_id"],))]
    takes = [_public_take(t) for t in _query(
        "SELECT * FROM takes WHERE student_id = ? ORDER BY created DESC", (student["id"],))]
    return {
        "student": {"name": student["name"]},
        "studio": studio,
        "assignments": assignments,
        "takes": takes,
    }


# --------------------------------------------------------------------------
# Assignments
# --------------------------------------------------------------------------

def _process_full_song(assignment_id: int, upload_path: str, upload_name: str, work_dir: str):
    """Background: split a full song into vocals (guide) + instrumental (backing)."""
    try:
        result = _SEPARATE(upload_path, upload_name)
        _execute(
            "UPDATE assignments SET guide_url = ?, backing_url = ?, status = 'ready' WHERE id = ?",
            (result["vocals"], result["instrumental"], assignment_id),
        )
    except Exception as e:  # surfaced to the teacher on the dashboard
        _execute("UPDATE assignments SET status = 'error', error = ? WHERE id = ?", (str(e)[:500], assignment_id))
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


@router.post("/teacher/{token}/assignments")
def create_assignment(
    token: str,
    title: str = Form(...),
    sa_hz: float = Form(...),
    level: str = Form("beginner"),
    notes: str = Form(""),
    full_song: bool = Form(False),
    audio: UploadFile = File(...),
):
    studio = _teacher_studio(token)
    if not (40 < sa_hz < 1000):
        raise HTTPException(status_code=400, detail="Sa must be between 40 and 1000 Hz.")
    if level not in LEVELS:
        raise HTTPException(status_code=400, detail=f"Level must be one of {', '.join(LEVELS)}.")
    ext = _VALIDATE_AUDIO(audio)
    title = _clean_text(title, 120) or "Untitled exercise"
    notes = (notes or "").strip()[:2000]

    if not full_song:
        # The teacher's own voice is the guide; no processing needed.
        guide_url = _save_media(audio, "guide", ext)
        assignment_id = _execute(
            """INSERT INTO assignments (studio_id, title, notes, sa_hz, level, guide_url, status, created)
               VALUES (?, ?, ?, ?, ?, ?, 'ready', ?)""",
            (studio["id"], title, notes, sa_hz, level, guide_url, time.time()),
        )
    else:
        work_dir = tempfile.mkdtemp(prefix="sa_listen_assign_")
        upload_path = os.path.join(work_dir, f"song{ext}")
        with open(upload_path, "wb") as out:
            shutil.copyfileobj(audio.file, out)
        assignment_id = _execute(
            """INSERT INTO assignments (studio_id, title, notes, sa_hz, level, status, created)
               VALUES (?, ?, ?, ?, ?, 'processing', ?)""",
            (studio["id"], title, notes, sa_hz, level, time.time()),
        )
        threading.Thread(
            target=_process_full_song,
            args=(assignment_id, upload_path, audio.filename or title, work_dir),
            daemon=True,
        ).start()

    return _public_assignment(_query("SELECT * FROM assignments WHERE id = ?", (assignment_id,), one=True))


@router.delete("/teacher/{token}/assignments/{assignment_id}")
def delete_assignment(token: str, assignment_id: int):
    studio = _teacher_studio(token)
    a = _query("SELECT * FROM assignments WHERE id = ? AND studio_id = ?", (assignment_id, studio["id"]), one=True)
    if not a:
        raise HTTPException(status_code=404, detail="Assignment not found.")
    with _DB_LOCK, _connect() as db:
        db.execute("DELETE FROM comments WHERE take_id IN (SELECT id FROM takes WHERE assignment_id = ?)", (assignment_id,))
        db.execute("DELETE FROM takes WHERE assignment_id = ?", (assignment_id,))
        db.execute("DELETE FROM assignments WHERE id = ?", (assignment_id,))
        db.commit()
    return {"ok": True}


# --------------------------------------------------------------------------
# Takes and comments
# --------------------------------------------------------------------------

@router.post("/student/{token}/assignments/{assignment_id}/takes")
def submit_take(
    token: str,
    assignment_id: int,
    duration: float = Form(...),
    score: Optional[int] = Form(None),
    summary: str = Form("{}"),
    frames: str = Form("[]"),
    audio: UploadFile = File(...),
):
    student = _student(token)
    a = _query("SELECT * FROM assignments WHERE id = ? AND studio_id = ?", (assignment_id, student["studio_id"]), one=True)
    if not a:
        raise HTTPException(status_code=404, detail="Assignment not found.")
    try:
        summary_obj = json.loads(summary)
        frames_obj = json.loads(frames)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid take data.")
    if len(frames) > 2_000_000 or len(summary) > 500_000:
        raise HTTPException(status_code=413, detail="Take data too large.")

    ext = os.path.splitext(audio.filename or "")[1].lower() or ".wav"
    if ext not in (".wav", ".webm", ".m4a", ".ogg", ".mp3"):
        ext = ".wav"
    audio_url = _save_media(audio, "take", ext)
    take_id = _execute(
        """INSERT INTO takes (assignment_id, student_id, audio_url, duration, score, summary, frames, created)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (assignment_id, student["id"], audio_url, max(0.0, min(duration, 7200.0)),
         None if score is None else max(0, min(100, score)),
         json.dumps(summary_obj), json.dumps(frames_obj), time.time()),
    )
    return _public_take(_query("SELECT * FROM takes WHERE id = ?", (take_id,), one=True))


@router.get("/teacher/{token}/takes/{take_id}")
def teacher_take(token: str, take_id: int):
    studio = _teacher_studio(token)
    t = _query(
        """SELECT t.*, s.name AS student_name FROM takes t
           JOIN assignments a ON a.id = t.assignment_id JOIN students s ON s.id = t.student_id
           WHERE t.id = ? AND a.studio_id = ?""",
        (take_id, studio["id"]), one=True,
    )
    if not t:
        raise HTTPException(status_code=404, detail="Take not found.")
    out = _public_take(t, with_frames=True)
    out["student_name"] = t["student_name"]
    return out


@router.post("/teacher/{token}/takes/{take_id}/comments")
def add_comment(token: str, take_id: int, body: CommentIn):
    teacher_take(token, take_id)  # ownership check
    _execute(
        "INSERT INTO comments (take_id, time_sec, text, created) VALUES (?, ?, ?, ?)",
        (take_id, body.time_sec, body.text.strip(), time.time()),
    )
    return _query("SELECT id, time_sec, text, created FROM comments WHERE take_id = ? ORDER BY time_sec", (take_id,))
