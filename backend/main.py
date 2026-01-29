from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import librosa
import numpy as np
import shutil
import os
import tempfile

# Ensure static directory exists for serving separated files
os.makedirs("static", exist_ok=True)

app = FastAPI()

# Ensure static directory exists for serving separated files
os.makedirs("static", exist_ok=True)

# Mount static files
app.mount("/static", StaticFiles(directory="static"), name="static")

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
    
    # Check if Spleeter is available
    has_spleeter = False
    try:
        from spleeter.separator import Separator
        has_spleeter = True
    except ImportError:
        print("Spleeter not found. Falling back to Librosa (Simulated 5-stems).")
    
    try:
        # Save input
        with open(input_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
            
        if has_spleeter:
            try:
                # Try Spleeter 5-stems
                separator = Separator('spleeter:5stems')
                separator.separate_to_file(input_path, "static")
                
                # Spleeter output persistence move
                # It creates static/<filename_no_ext>/{vocal,bass..}.wav
                # We need to standardize return paths or just return what Spleeter made.
                foldername = os.path.splitext(input_filename)[0]
                base_url = f"/static/{foldername}"
                return {
                    "vocals": f"{base_url}/vocals.wav",
                    "drums": f"{base_url}/drums.wav",
                    "bass": f"{base_url}/bass.wav",
                    "piano": f"{base_url}/piano.wav",
                    "other": f"{base_url}/other.wav"
                }
            except Exception as e:
                print(f"Spleeter execution failed: {e}. Falling back to Librosa.")
                # Fallthrough to Librosa logic
        
        # --- Fallback: Librosa HPSS (Simulated 5 stems with Filtering) ---
        print("Using Librosa Fallback with Filters...")
        y, sr = librosa.load(input_path, duration=180)
        y_harmonic, y_percussive = librosa.effects.hpss(y)
        
        import soundfile as sf
        
        # 1. Drums <- Percussive (Unchanged)
        sf.write(os.path.join("static", output_map["drums"]), y_percussive, sr)
        
        # 2. Bass <- Low Pass Filter on Harmonic (e.g., < 200Hz)
        # Simple simulation: decompose harmonic further or just hard filter
        # We can use spectral filtering
        S_h = librosa.stft(y_harmonic)
        freqs = librosa.fft_frequencies(sr=sr)
        
        # Create masks
        bass_mask = freqs < 250
        other_mask = freqs >= 250
        
        # Apply masks
        S_bass = S_h * bass_mask[:, np.newaxis]
        S_other = S_h * other_mask[:, np.newaxis]
        
        y_bass = librosa.istft(S_bass)
        y_other_mix = librosa.istft(S_other)
        
        sf.write(os.path.join("static", output_map["bass"]), y_bass, sr)
        
        # 3. Vocals/Piano/Other <- From the 'Other Mix' (Mid/High freqs)
        # Ideally we can't separate Vocals from Piano easily without AI.
        # So we will share the 'y_other_mix' across them for now, 
        # OR we could try to put center-panned audio to vocals (if stereo), but input might be mono.
        
        # For now: 
        # Vocals gets the full Mid/High range (most prominent)
        sf.write(os.path.join("static", output_map["vocals"]), y_other_mix, sr)
        
        # Piano/Other gets a quieter version or same
        sf.write(os.path.join("static", output_map["piano"]), y_other_mix, sr)
        sf.write(os.path.join("static", output_map["other"]), y_other_mix, sr)
        
        return {k: f"/static/{v}" for k, v in output_map.items()}

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
