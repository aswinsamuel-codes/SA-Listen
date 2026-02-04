# SA Listen (Semantic Audio Listen)

SA Listen is an AI-powered real-time vocal analysis tool designed to help singers improve their pitch accuracy. It provides immediate visual feedback by comparing a singer's live input against a reference track, featuring high-quality audio separation and dynamic visualization.

## Key Features

- **Real-Time Pitch Detection**: Uses autocorrelation-based pitch detection to track vocal input with low latency.
- **Reference Comparison**: Compares live singing against a reference track's key and melody.
- **AI Audio Splitting**: Integrates `demucs` (Hybrid Transformer Demucs) to separate vocals, drums, bass, and piano from any song.
- **Visual Feedback**:
  - Live frequency graph (Reference vs. User)
  - Neon wave ambient visualizer
  - Pitch accuracy scoring (Match, Near, Off)
- **Spotify Integration**: Syncs beat/bar information for metadata (tempo/key) analysis.

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
   cd backend
   pip install -r requirements.txt
   ```
   *Note: First run of the splitter will download the ~2GB Demucs AI model.*

3. **Run the Application**:
   ```bash
   # From the project root
   python backend/main.py
   ```
   Access the app at `http://127.0.0.1:8000`.

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
- **Sukin S**

**Libraries Used**:
- `librosa` (Audio analysis)
- `demucs` (Source separation)
- `FastAPI` (Backend framework)
- `music-tempo` (Frontend tempo estimation)

## Journal Notes

**Research Motivation**: This tool addresses the lack of accessible, real-time visual feedback tools for vocal pedagogy that utilize modern AI source separation. Traditional tools often require pre-processed MIDI files; SA Listen works with raw audio.

**System Novelty**: By combining browser-based zero-latency pitch detection with server-side high-fidelity model processing, SA Listen offers a "best of both worlds" approach—immediate feedback for the user, with deep analysis available on demand.

**Ethical & Legal Audio Handling**: The application processes audio locally (browser) or temporarily (server RAM/temp) for analysis. Uploaded files are solely used for user-session analysis and are not permanently stored or used to train models, respecting user privacy and copyright.
