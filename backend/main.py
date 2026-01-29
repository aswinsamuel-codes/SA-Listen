from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import librosa
import numpy as np
import shutil
import os
import tempfile

app = FastAPI()

# Enable CORS for frontend communication
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all origins for local dev convenience
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
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

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
