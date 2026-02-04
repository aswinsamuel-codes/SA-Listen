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

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import librosa
import numpy as np
import shutil
import os
import sys
import tempfile

# Ensure static directory exists for serving separated files
os.makedirs("static", exist_ok=True)

app = FastAPI()

# Ensure static directory exists for serving separated files
os.makedirs("static", exist_ok=True)

# Mount static files
app.mount("/static", StaticFiles(directory="static"), name="static")

# Mount assets directory (for logos/images)
assets_path = os.path.join(os.path.dirname(__file__), "..", "assets")
if os.path.exists(assets_path):
    app.mount("/assets", StaticFiles(directory=assets_path), name="assets")

# Mount frontend files logic moved to bottom to avoid blocking API POST requests

# Enable CORS for frontend communication
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],  # Explicitly allow these
    allow_headers=["*"],
    expose_headers=["*"]
)

def estimate_key(y, sr):
    """
    Estimate the musical key (e.g., 'C major', 'F# minor') from audio.
    Uses Chroma feature to correlate with major/minor templates.
    """
    # 1. Compute Chroma
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    
    # 2. Sum chroma over time to get a single vector of 12 semitones
    chroma_sum = np.sum(chroma, axis=1)
    
    # 3. Define templates for Major and Minor keys
    #    Indices: C, C#, D, D#, E, F, F#, G, G#, A, A#, B
    #    Major profile: [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88] (Krumhansl-Schmuckler)
    #    Simplifying for robustness:
    major_template = np.array([1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1])
    minor_template = np.array([1, 0, 1, 1, 0, 1, 0, 1, 0, 1, 0, 0]) # Natural minor
    
    # Krumhansl-Schmuckler weightings are better for real audio
    ks_major = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
    ks_minor = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
    
    key_names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
    
    max_corr = -1
    best_key = ""
    
    # Check all 12 major keys
    for i in range(12):
        # Rotate template to match root note i
        profile = np.roll(ks_major, i)
        corr = np.corrcoef(chroma_sum, profile)[0, 1]
        if corr > max_corr:
            max_corr = corr
            best_key = f"{key_names[i]} Major"
            
    # Check all 12 minor keys
    for i in range(12):
        profile = np.roll(ks_minor, i)
        corr = np.corrcoef(chroma_sum, profile)[0, 1]
        if corr > max_corr:
            max_corr = corr
            best_key = f"{key_names[i]} Minor"
            
    return best_key


def estimate_chord_segments(y, sr, tempo, beat_frames):
    """
    Estimate chord for each beat segment.
    Returns a list of { "time": float, "chord": string }.
    """
    # 1. Compute Chroma (harmonic content)
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    
    # 2. Sync chroma to the detected beats
    # This averages the chroma features between each beat event
    chroma_synced = librosa.util.sync(chroma, beat_frames, aggregate=np.median)
    
    # 3. Define templates (Simplified Major/Minor)
    major_template = np.array([1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1])
    minor_template = np.array([1, 0, 1, 1, 0, 1, 0, 1, 0, 1, 0, 0])
    key_names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
    
    segments = []
    beat_times = librosa.frames_to_time(beat_frames, sr=sr)
    
    # Iterate over each synced column (each beat)
    # chroma_synced shape is (12, n_beats)
    # Safely determine number of segments to process
    n_segments = min(chroma_synced.shape[1], len(beat_times))
    
    for i in range(n_segments):
        col = chroma_synced[:, i]
        
        max_corr = -1
        best_chord = "--"
        
        # Correlate with all 12 major and 12 minor templates
        for root in range(12):
            # Major
            profile = np.roll(major_template, root)
            corr = np.corrcoef(col, profile)[0, 1]
            if corr > max_corr:
                max_corr = corr
                best_chord = f"{key_names[root]} Maj"
                
            # Minor
            profile = np.roll(minor_template, root)
            corr = np.corrcoef(col, profile)[0, 1]
            if corr > max_corr:
                max_corr = corr
                best_chord = f"{key_names[root]} Min"
        
        # Clean up timestamp
        t = float(beat_times[i])
        segments.append({
            "time": t,
            "chord": best_chord
        })
        
    return segments

@app.post("/analyze")
async def analyze_audio(file: UploadFile = File(...)):
    if not file.content_type.startswith("audio/"):
        raise HTTPException(status_code=400, detail="Invalid file type. Must be an audio file.")
    
    temp_dir = tempfile.mkdtemp()
    temp_path = os.path.join(temp_dir, file.filename)
    
    try:
        with open(temp_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
            
        # Load audio (limit to 2 minutes for performance if needed, or full song)
        y, sr = librosa.load(temp_path, duration=120)
        
        # 1. Estimate Tempo & Beats
        onset_env = librosa.onset.onset_strength(y=y, sr=sr)
        tempo, beat_frames = librosa.beat.beat_track(onset_envelope=onset_env, sr=sr)
        
        if isinstance(tempo, np.ndarray):
            tempo = tempo.item()
            
        # 2. Global Key (overall)
        detected_key = estimate_key(y, sr)
        
        # 3. Dynamic Chord Segments (Live)
        # Using the beat frames to map time-to-chord
        chord_segments = estimate_chord_segments(y, sr, tempo, beat_frames)
        
        return {
            "filename": file.filename,
            "tempo": round(tempo, 1),
            "key": detected_key,
            "main_chord": detected_key.split(' ')[0],
            "chords": chord_segments  # New field: timeline of chords
        }
        
    except Exception as e:
        print(f"Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
        
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)
        os.rmdir(temp_dir)

@app.post("/split", status_code=200)
async def split_audio(file: UploadFile = File(...)):
    print(f"Received split request for file: {file.filename}")
    if not file.content_type.startswith("audio/"):
        raise HTTPException(status_code=400, detail="Invalid file type. Must be an audio file.")
    
    # Create unique name
    unique_name = f"{os.path.splitext(file.filename)[0]}_{os.urandom(4).hex()}"
    input_filename = f"{unique_name}{os.path.splitext(file.filename)[1]}"
    input_path = os.path.join("static", input_filename)
    
    # Prepare output paths (Vocals, Drums, Bass, Piano, Other)
    output_map = {
        "vocals": f"{unique_name}_vocals.wav",
        "drums": f"{unique_name}_drums.wav",
        "bass": f"{unique_name}_bass.wav",
        "piano": f"{unique_name}_piano.wav",
        "other": f"{unique_name}_other.wav"
    }

    try:
        # Save input
        with open(input_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        # --- Use HTDemucs (Demucs) for High Quality Separation ---
        # We use 'htdemucs_6s' because standard htdemucs is only 4 stems (no piano)
        # htdemucs_6s stems: bass, drums, guitar, other, piano, vocals
        model = "htdemucs_6s"
        
        print(f"Running Demucs ({model}) on {input_path}...")
        
        # Demucs CLI command
        # -n: model
        # -d: device (cpu) to be safe, or 'cuda' if GPU available (auto usually works but explicit cpu is safer for general deployment)
        # --out: output directory
        # Use python -m demucs to ensure we use the installed module in the current env
        cmd = [sys.executable, "-m", "demucs", "-n", model, "-d", "cpu", "--out", "static/separated", input_path]
        
        import subprocess
        subprocess.run(cmd, check=True)
        
        # Demucs output structure: static/separated/<model>/<input_filename_no_ext>/<stem>.wav
        # Note: input_filename_no_ext is how Demucs names the folder.
        input_name_no_ext = os.path.splitext(input_filename)[0]
        demucs_output_dir = os.path.join("static", "separated", model, input_name_no_ext)
        
        if not os.path.exists(demucs_output_dir):
            raise FileNotFoundError(f"Demucs output folder not found at: {demucs_output_dir}")

        # Map Demucs output filenames to our expected frontend filenames
        # Demucs files are usually: vocals.wav, drums.wav, bass.wav, other.wav, piano.wav, guitar.wav
        
        # Helper to move and rename
        def move_stem(demucs_name, target_key):
            src = os.path.join(demucs_output_dir, f"{demucs_name}.wav")
            target = os.path.join("static", output_map[target_key])
            
            if os.path.exists(src):
                shutil.move(src, target)
            else:
                print(f"Warning: Stem {demucs_name} not found. Creating silent/empty file for {target_key}.")
                # Fallback: Copy 'other' or create silent file if needed.
                # For now, let's just error or copy the original 'other' if we are desperate.
                # If piano is missing (e.g. wrong model), allow Copying 'other' to 'piano'
                if target_key == 'piano' and os.path.exists(os.path.join(demucs_output_dir, "other.wav")):
                     shutil.copy(os.path.join(demucs_output_dir, "other.wav"), target)

        move_stem("vocals", "vocals")
        move_stem("drums", "drums")
        move_stem("bass", "bass")
        move_stem("piano", "piano")
        move_stem("other", "other")
        
        # Cleanup split folder
        shutil.rmtree(os.path.join("static", "separated"), ignore_errors=True) # clean up the huge separated folder

        return {k: f"/static/{v}" for k, v in output_map.items()}

    except subprocess.CalledProcessError as e:
        print(f"Demucs CLI failed: {e}")
        raise HTTPException(status_code=500, detail="Audio separation failed during processing.")
    except Exception as e:
        print(f"Split Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
        
    finally:
        if os.path.exists(input_path):
            os.remove(input_path)

# Mount frontend files from sa-listen-ui directory (Catch-all must be last)
frontend_path = os.path.join(os.path.dirname(__file__), "..", "sa-listen-ui")
if os.path.exists(frontend_path):
    app.mount("/", StaticFiles(directory=frontend_path, html=True), name="frontend")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
