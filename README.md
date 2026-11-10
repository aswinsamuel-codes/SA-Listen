# SA Listen 

SA Listen is an AI-powered real-time vocal analysis tool designed to help singers improve their pitch accuracy. It provides immediate visual feedback by comparing a singer's live input against a reference track, featuring high-quality audio separation and dynamic visualization.

## Key Features

- **Real-Time Pitch Detection**: Uses the McLeod Pitch Method (normalized autocorrelation with sub-sample interpolation) to track vocal input from ~50 Hz to 1 kHz with low latency. Comparison is octave-independent, so any voice type can sing along.
- **Reference Comparison**: Compares live singing against a reference track's key and melody.
- **Practice Studio (prototype, `/practice.html`)**: Built for practice between lessons with a teacher.
  - **Teachers** create a studio, share a join code, and publish exercises recorded in their own voice (or upload a full song to have the vocals separated). For each exercise they set the Sa (tonic, with kattai) and a level that sets how strict scoring is.
  - **Students** practise against a scrolling **swara note lane** relative to Sa, with a tanpura-style **Sa drone**, a count-in, slow-down, and **note-by-note scoring**. Octaves don't count against you, and tips name the exact swara that's flat or sharp. They send their best take to the teacher.
  - **Teachers review** each take with the coloured note lane and the student's pitch trace, and leave **comments pinned to a moment** in the take. A dashboard shows each student's practice minutes and scores for the week.
  - *Prototype access model:* teacher and student links contain a private token (no passwords yet). Anyone holding the link has that person's access. Data is stored in `backend/data/` (SQLite + media).
- **Karaoke Mode**: Paste a YouTube link (or use any uploaded song) and SA Listen removes the vocals with Demucs. You sing over the instrumental while the original singer plays as a quiet, adjustable **guide vocal**, and that isolated vocal becomes the pitch target, so feedback follows the real melody (with "Rest" between lines). Results are cached, so a song you practise again loads instantly.
- **Practice Tools for Beginners**: A–B looping, slow-down (0.5×–0.9×, key unchanged), guide-vocal fader, and a session report.
- **Session Takes**: Records your raw mic (no browser noise suppression or echo gating), optionally mixed with the backing track, and saves a WAV you can replay or download.
- **AI Audio Splitting**: Integrates `demucs` (Hybrid Transformer Demucs) to separate vocals, drums, bass, and piano from any song.
- **Visual Feedback**:
  - Live frequency graph (Reference vs. User)
  - Neon wave ambient visualizer
  - Pitch accuracy scoring (Match, Near, Off)


## Architecture

The system uses a hybrid architecture:
- **Frontend**: A vanilla JavaScript/HTML5 application using the Web Audio API for real-time microphone processing and canvas-based visualization.
- **Backend**: A FastAPI (Python) server that handles:
  - Heavy AI tasks like source separation (`demucs`)
  - Audio key/chord estimation (`librosa`)
  - File management

## Installation

### Prerequisites
- Python 3.10+
- Node.js (optional, for frontend dev tools)
- FFmpeg (required for audio processing)

### Setup

1. **Clone the repository**:
   ```bash
   git clone https://github.com/aswinsamuel-codes/SA-Listen.git
   cd SA-Listen
   ```

2. **Backend Setup**:
   ```bash
   python -m venv .venv
   .venv\Scripts\activate        # Windows  (macOS/Linux: source .venv/bin/activate)
   pip install -r backend/requirements.txt
   ```
   *Note: First run of the splitter will download the ~2GB Demucs AI model. A CUDA GPU is used automatically if PyTorch can see one.*

3. **Run the Application**:
   ```bash
   # From the project root (or from backend/ — paths are resolved either way)
   python backend/main.py
   ```
   Access the app at `http://127.0.0.1:8000`.

   For auto-reload during development: `uvicorn main:app --reload --app-dir backend`

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `SA_LISTEN_STEM_TTL_HOURS` | `0` (keep) | Delete separated stems in `backend/static/` older than this many hours. Each split writes five full-length WAVs, so set this on long-running servers. |
| `SA_LISTEN_MAX_SONG_MINUTES` | `10` | Longest YouTube video Karaoke Mode will accept. |

Karaoke tracks are cached in `backend/static/karaoke/` (about 10 MB per song). Delete folders there to free space.

> **Note on YouTube:** Karaoke Mode downloads audio with [yt-dlp](https://github.com/yt-dlp/yt-dlp) for personal practice. Respect YouTube's Terms of Service and copyright. Don't redistribute separated tracks, and don't commit them to this repo. If downloads start failing, update yt-dlp first (`pip install -U yt-dlp`), since YouTube changes often.

**Tip for singers:** use headphones. Leave "I'm wearing headphones" ticked so the mic is recorded raw. Untick it on speakers to turn on echo cancellation and lower the music while you sing.

### Tests

Pitch-detection unit tests run in Node or the browser:
```bash
node sa-listen-ui/test/quick_test.js
```
(or open `sa-listen-ui/test/quick_test.html`).

## License

This project is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**.

**Summary of Terms:**
- You may copy, distribute, and modify the software.
- You must include the license and copyright notice.
- If you modify it, you must state changes.
- **Network Use:** If you run this software over a network (e.g., as a web service), you **must** make the source code available to users of that service.

See the [LICENSE](LICENSE) file for the full text.

## Credits

**Core Developer & Architect**:
- **Aswin Samuel A.**

**Libraries Used**:
- `librosa` (Audio analysis)
- `demucs` (Source separation)
- `FastAPI` (Backend framework)


## Crazy Ideas Welcome 

We welcome experimental ideas like:
- Pitch emotion detection
- Breath control analysis
- Vocal health indicators
- AR pitch visualization
- Hardware integrations

Final decisions on architecture and roadmap are maintained by the core maintainers to ensure research integrity and product vision.

If it sounds crazy — we want it.




