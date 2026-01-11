# SA Listen UI

A cozy, premium-feel web interface for **SA Listen**, an AI-powered vocal analysis app. The UI lets you upload a reference track, visualize its pitch, sing along live via your microphone, and compare your pitch against the target in real time.

## Features

- **Reference Track Upload**
	- Drag-and-drop or browse to upload an audio file.
	- In-browser audio preview using the built-in player.

- **Live Pitch Feedback Panel**
	- Real-time microphone pitch detection using the Web Audio API.
	- Displays:
		- **Target frequency (Hz)** (reference pitch)
		- **Your frequency (Hz)** (live mic)
		- **Status**: `Waiting`, `Match`, `Near`, `Off` based on cents difference.

- **Live Frequency Comparison Graph**
	- HTML canvas graph with time on the X-axis and frequency (50–1000 Hz) on the Y-axis.
	- **Blue line**: reference track fundamental frequency.
	- **Red line**: your live vocal pitch.
	- Sliding window history that updates at ~30 FPS.

- **Live Singing Session Card**
	- Locked until a reference track is uploaded.
	- "Start Singing" toggles live microphone analysis on/off.
	- Automatically lowers reference track volume while listening to reduce bleed into the mic.

- **Design**
	- Cream background (`#FAF7F2`), black header/cards (`#0F0F0F`).
	- White primary text, soft gray secondary text, soft blue accent (`#3B82F6`).
	- Mobile-first, single-column layout with touch-friendly controls.

## Project Structure

- [index.html](index.html)
- [style.css](style.css)
- [script.js](script.js)
- [assets/](assets)
	- Logo image used in the header.

## Getting Started

1. **Clone the repository**

	 ```bash
	 git clone https://github.com/aswinsamuel-codes/SA-Listen.git
	 cd SA-Listen/sa-listen-ui
	 ```

2. **Serve over HTTP(S)**

	 Because the app uses `getUserMedia` for microphone access, most browsers require HTTPS or `http://localhost`.

	 You can use a simple static server, for example:

	 ```bash
	 # Python 3
	 python -m http.server 8000
	 # or
	 # Node (http-server must be installed globally)
	 npx http-server -p 8000
	 ```

	 Then open:

	 ```
	 http://localhost:8000/index.html
	 ```

3. **Grant microphone permission**

	 - Upload a reference track.
	 - Click **Start Singing**.
	 - Your browser will prompt for microphone access; allow it.

## How It Works (High Level)

- **Reference Track Path**
	- The `<audio>` element is connected to an `AnalyserNode` via `createMediaElementSource`. Time-domain data is analyzed with an autocorrelation-based pitch detector to estimate the reference fundamental frequency.

- **Microphone Path**
	- `navigator.mediaDevices.getUserMedia` provides a mic stream.
	- The stream is connected only to an `AnalyserNode` (not to `destination`), so mic audio is never played back.
	- The same time-domain autocorrelation pitch detector is used.

- **Pitch Comparison & Status**
	- The detected microphone pitch is compared in **cents** to the target frequency (currently a fixed Concert A = 440 Hz):
		- `MATCH` if within ±20 cents
		- `NEAR` if within ±50 cents
		- `OFF` otherwise

- **Graph Rendering**
	- The app keeps sliding-window arrays of recent reference and user pitches.
	- At ~30 FPS, it redraws an HTML canvas where:
		- X-axis = sample index over time
		- Y-axis = clamped 50–1000 Hz
		- Blue polyline = reference
		- Red polyline = microphone

## Browser Compatibility

- Modern Chromium-based browsers (Chrome, Edge) and recent Safari should work.
- Requirements:
	- `AudioContext` / `webkitAudioContext`
	- `navigator.mediaDevices.getUserMedia`
	- `requestAnimationFrame`

If microphone access fails, check the browser permissions for the site and ensure you are serving the app from `localhost` or over HTTPS.

## Future Ideas

- Derive the target frequency dynamically from the uploaded reference track instead of using a fixed 440 Hz.
- Show note names (e.g., A4, C#4) alongside frequencies.
- Add basic latency compensation or input calibration.
- Save practice sessions or provide history/insights.
