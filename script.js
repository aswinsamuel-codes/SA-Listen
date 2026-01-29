document.addEventListener('DOMContentLoaded', () => {
    // Core upload + reference audio elements
    const audioUpload = document.getElementById('audioUpload');
    const audioPlayer = document.getElementById('audioPlayer');
    const fileNameDisplay = document.getElementById('fileName');
    const audioPreviewContainer = document.getElementById('audioPreviewContainer');
    const uploadArea = document.getElementById('uploadArea');

    // Song analysis elements (tempo, chord) for the reference track
    const tempoValueEl = document.getElementById('tempoValue');
    const chordValueEl = document.getElementById('chordValue');
    const songAnalysisSection = document.getElementById('songAnalysis');

    // Spotify metadata elements (playback & features, no audio analysis)
    const spotifyTrackInput = document.getElementById('spotifyTrackInput');
    const loadSpotifyBtn = document.getElementById('loadSpotifyBtn');
    const spotifyPlayer = document.getElementById('spotifyPlayer');
    // REMOVED: Metadata elements (title, artist, cover, etc) as requested
    // REMOVED: Metadata elements (title, artist, cover, etc) as requested
    const clearSpotifyBtn = document.getElementById('clearSpotifyBtn');
    const tempoSummaryEl = document.getElementById('tempoSummary');
    const chordSummaryEl = document.getElementById('chordSummary');
    const removeReferenceBtn = document.getElementById('removeReferenceBtn');

    // Report Elements
    const reportCard = document.getElementById('reportCard');
    const closeReportBtn = document.getElementById('closeReportBtn');
    const reportScoreEl = document.getElementById('reportScore');
    const reportExcellentEl = document.getElementById('reportExcellent');
    const reportNearEl = document.getElementById('reportNear');
    const reportMissEl = document.getElementById('reportMiss');
    const reportMessageEl = document.getElementById('reportMessage');

    // Session Scoring
    let sessionScore = { total: 0, match: 0, near: 0, miss: 0 };

    // Live pitch feedback panel elements
    const pitchTargetEl = document.getElementById('pitchTarget');
    const pitchUserEl = document.getElementById('pitchUser');
    const pitchStatusEl = document.getElementById('pitchStatus');
    const pitchCardEl = document.getElementById('pitchCard');

    // Canvas-based graph for comparing reference vs user frequency
    const pitchGraphCanvas = document.getElementById('pitchGraph');
    const pitchGraphCtx = pitchGraphCanvas ? pitchGraphCanvas.getContext('2d') : null;
    const refreshGraphBtn = document.getElementById('refreshGraphBtn');

    // Graph configuration: time-scrolling history of recent frequencies
    const GRAPH_MIN_FREQ = 50;   // Hz (bottom of Y-axis)
    const GRAPH_MAX_FREQ = 1000; // Hz (top of Y-axis)
    const GRAPH_HISTORY = 200;   // Number of points kept in history

    const refFreqHistory = [];
    const userFreqHistory = [];
    let lastGraphDrawTime = 0;

    // Grab the small note text under the "You" frequency block
    const pitchUserNoteEl = pitchUserEl.parentElement.querySelector('.pitch-note');

    // Live singing controls
    const startSingingBtn = document.getElementById('startSingingBtn');
    const stopSingingBtn = document.getElementById('stopSingingBtn');

    // Target pitch in Hz (Concert A). You could later derive this
    // from the uploaded reference track.
    const TARGET_FREQUENCY = 440;

    // Reference track volume (kept for future tweaks if needed).
    // Currently we do not change the volume automatically when the
    // mic is active so that the backing track stays clearly audible.
    let originalRefVolume = audioPlayer ? audioPlayer.volume : 1;

    // Simple state flags
    let hasReferenceTrack = false;
    let isListening = false;
    let wasAudioPlayingWhenStopped = false; // remembers if reference audio was playing when user hit Stop

    // Spotify state (metadata only)
    let currentSpotifyTrackId = null;
    let hasSpotifyTrack = false;
    let spotifyReferenceFrequency = null; // derived from Spotify key (metadata only)

    // Last detected pitch (Hz) for simple smoothing of the display
    let lastPitch = null;

    // Web Audio / microphone analysis state
    // A single AudioContext is shared for both microphone and
    // reference-track analysis and kept alive for the page lifetime
    // so that pausing/playing the track continues to work.
    let audioContext = null;
    let mediaStream = null;
    let analyser = null;
    let timeDomainData = null;
    let rafId = null;

    // Separate analyser for the reference track (<audio> element)
    // so we can detect its pitch independently of the microphone.
    let referenceAnalyser = null;
    let referenceTimeDomainData = null;
    let referenceSource = null;

    // Dynamic chord timeline from backend
    // Format: [{ time: 1.2, chord: 'C Maj' }, ...]
    let currentChordSegments = [];

    // Initially, keep the singing controls disabled until a reference track is uploaded
    startSingingBtn.disabled = true;
    if (stopSingingBtn) stopSingingBtn.disabled = true;

    // Ensure the shared AudioContext is resumed when the user
    // manually plays the reference track, which can be required by
    // some autoplay policies.
    if (audioPlayer) {
        audioPlayer.addEventListener('play', async () => {
            if (audioContext && audioContext.state === 'suspended') {
                try {
                    await audioContext.resume();
                } catch (e) {
                    console.warn('Unable to resume AudioContext on play:', e);
                }
            }
        });
    }

    // Handle file selection via input
    audioUpload.addEventListener('change', handleFileSelect);

    // --- Audio Splitter Logic ---
    const splitterUpload = document.getElementById('splitterUpload');
    const splitterFileName = document.getElementById('splitterFileName');
    const processSplitBtn = document.getElementById('processSplitBtn');
    const splitterActions = document.getElementById('splitterActions');
    const splitterLoading = document.getElementById('splitterLoading');
    const stemsContainer = document.getElementById('stemsContainer');
    const resetSplitterBtn = document.getElementById('resetSplitterBtn');
    const stemVocals = document.getElementById('stemVocals');
    const stemAccompaniment = document.getElementById('stemAccompaniment');
    const downloadVocals = document.getElementById('downloadVocals');
    const downloadAccompaniment = document.getElementById('downloadAccompaniment');

    let splitFile = null;

    if (splitterUpload) {
        splitterUpload.addEventListener('change', (e) => {
            if (e.target.files && e.target.files[0]) {
                splitFile = e.target.files[0];
                splitterFileName.textContent = splitFile.name;
                splitterActions.classList.remove('hidden');
                stemsContainer.classList.add('hidden');
            }
        });
    }

    if (processSplitBtn) {
        processSplitBtn.addEventListener('click', async () => {
            if (!splitFile) return;

            // Show loading
            splitterLoading.classList.remove('hidden');
            splitterActions.classList.add('hidden');
            splitterUpload.parentElement.classList.add('hidden'); // Hide upload area temporarily

            try {
                const formData = new FormData();
                formData.append('file', splitFile);

                const response = await fetch('http://127.0.0.1:8000/split', {
                    method: 'POST',
                    body: formData
                });

                if (!response.ok) throw new Error("Split failed");

                const data = await response.json();

                // Assuming backend returns { vocals: "/static/...", accompaniment: "/static/..." }
                // We will rely on the backend serving these files statically or via an endpoint
                // ideally returning base64 or a temp URL. For a local app, serving from static dir is easiest.

                stemVocals.src = `http://127.0.0.1:8000${data.vocals}`;
                stemAccompaniment.src = `http://127.0.0.1:8000${data.accompaniment}`;

                downloadVocals.href = `http://127.0.0.1:8000${data.vocals}`;
                downloadAccompaniment.href = `http://127.0.0.1:8000${data.accompaniment}`;

                stemsContainer.classList.remove('hidden');

            } catch (err) {
                console.error(err);
                alert("Error separating audio. Ensure backend is running and supports Spleeter.");
                // Reset UI
                splitterActions.classList.remove('hidden');
                splitterUpload.parentElement.classList.remove('hidden');
            } finally {
                splitterLoading.classList.add('hidden');
            }
        });
    }

    if (resetSplitterBtn) {
        resetSplitterBtn.addEventListener('click', () => {
            stemsContainer.classList.add('hidden');
            splitterUpload.parentElement.classList.remove('hidden');
            splitterFileName.textContent = 'No file selected';
            splitterActions.classList.add('hidden');
            splitterUpload.value = '';
            splitFile = null;
        });
    }

    if (removeReferenceBtn) {
        removeReferenceBtn.addEventListener('click', removeReferenceTrack);
    }

    // Manual graph refresh: clear histories and redraw axes only
    if (refreshGraphBtn) {
        refreshGraphBtn.addEventListener('click', () => {
            refFreqHistory.length = 0;
            userFreqHistory.length = 0;
            lastPitch = null;
            if (pitchGraphCtx && pitchGraphCanvas) {
                // Clear the canvas and redraw an empty graph frame
                pitchGraphCtx.clearRect(0, 0, pitchGraphCanvas.width, pitchGraphCanvas.height);
            }
        });
    }

    if (closeReportBtn) {
        closeReportBtn.addEventListener('click', () => {
            if (reportCard) reportCard.classList.add('hidden');
        });
    }

    // Drag and drop support for the upload zone
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        uploadArea.addEventListener(eventName, preventDefaults, false);
    });

    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    uploadArea.addEventListener('dragenter', highlight);
    uploadArea.addEventListener('dragover', highlight);
    uploadArea.addEventListener('dragleave', unhighlight);
    uploadArea.addEventListener('drop', handleDrop);

    function highlight() {
        uploadArea.style.borderColor = 'rgba(255,255,255,0.8)';
    }

    function unhighlight() {
        uploadArea.style.borderColor = '';
    }

    function handleDrop(e) {
        const dt = e.dataTransfer;
        const files = dt.files;

        if (files.length > 0 && files[0].type.startsWith('audio/')) {
            audioUpload.files = files; // Manually update input files
            processFile(files[0]);
        }
        unhighlight();
    }

    function handleFileSelect(event) {
        const file = event.target.files[0];
        processFile(file);
    }

    /**
     * Extract a Spotify track ID from either a raw ID or a full
     * Spotify URL. Returns null if the input does not look valid.
     */
    function extractSpotifyTrackId(input) {
        if (!input) return null;

        // If it already looks like an ID (22-character base62), use it.
        const plainIdMatch = /^[A-Za-z0-9]{10,}$/u;
        if (plainIdMatch.test(input) && !input.includes('spotify.com')) {
            return input;
        }

        try {
            const url = new URL(input);
            // Handle URLs like https://open.spotify.com/track/{id}
            const parts = url.pathname.split('/').filter(Boolean);
            const trackIndex = parts.indexOf('track');
            if (trackIndex !== -1 && parts[trackIndex + 1]) {
                return parts[trackIndex + 1].split('?')[0];
            }
        } catch (e) {
            // Not a URL; fall through
        }

        return null;
    }

    /**
     * Process the uploaded audio file: update UI, preview player, and
     * unlock the live singing controls.
     */
    function processFile(file) {
        if (!file) return;

        hasReferenceTrack = true;

        // Update file name display
        fileNameDisplay.textContent = file.name;
        fileNameDisplay.style.color = '#FFFFFF';

        // Create object URL for the audio file and hook up the player
        const objectUrl = URL.createObjectURL(file);
        audioPlayer.src = objectUrl;
        audioPlayer.load();
        audioPreviewContainer.classList.remove('hidden');

        // Kick off basic tempo and main-chord analysis of the
        // reference track in the background.
        analyzeReferenceAudio(file);

        // Ensure pitch panel is in a neutral, waiting state
        resetPitchPanel();

        // Visually and functionally unlock the live singing card
        unlockSessionVisuals();

        // Optional: Auto-play (respecting browser policies)
        // audioPlayer.play().catch(e => console.log('Auto-play prevented:', e));
    }

    /**
     * Reset the pitch panel to its initial waiting state.
     */
    function resetPitchPanel() {
        pitchTargetEl.textContent = `${TARGET_FREQUENCY} Hz`;
        pitchUserEl.textContent = '—';
        pitchUserNoteEl.textContent = 'Waiting for input';

        pitchStatusEl.textContent = 'Waiting';
        pitchStatusEl.classList.remove('status-match', 'status-near');
        pitchStatusEl.classList.add('status-waiting');

        pitchCardEl.classList.remove('is-active');
    }

    /**
     * Adjust the live singing card messaging and enable the button
     * once a reference track is present.
     */
    function unlockSessionVisuals() {
        startSingingBtn.disabled = false;
        if (stopSingingBtn) stopSingingBtn.disabled = false;
    }

    /**
     * Start microphone capture and begin real-time pitch analysis.
     * Uses the Web Audio API (AudioContext, AnalyserNode) together
     * with getUserMedia to access the microphone stream.
     */
    async function startMicrophone() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            alert('Microphone access is not supported in this browser.');
            return;
        }

        try {
            // Ask the user for microphone permission
            mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    channelCount: 1
                }
            });

            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (!audioContext) {
                audioContext = new AudioContextClass();
            }

            // Some browsers start AudioContext in a suspended state
            // and require an explicit resume() inside a user gesture.
            if (audioContext.state === 'suspended') {
                await audioContext.resume();
            }

            const source = audioContext.createMediaStreamSource(mediaStream);
            analyser = audioContext.createAnalyser();
            analyser.fftSize = 2048;

            const bufferLength = analyser.fftSize;
            timeDomainData = new Float32Array(bufferLength);

            // IMPORTANT: For the microphone we only connect the
            // MediaStreamSource to an AnalyserNode. We do NOT route
            // this stream to audioContext.destination so the mic audio
            // is never played through the speakers and is used solely
            // for analysis.
            source.connect(analyser);

            // Also connect the reference <audio> element into this
            // same AudioContext via its own AnalyserNode so we can
            // estimate the reference track's fundamental frequency.
            setupReferenceAnalyser();

            isListening = true;
            pitchUserNoteEl.textContent = 'Listening...';
            startSingingBtn.textContent = 'Mic Active';
            startSingingBtn.classList.add('btn-recording');

            // Reset session score
            sessionScore = { total: 0, match: 0, near: 0, miss: 0 };
            /*
            pitchUserNoteEl.textContent = 'Listening a0 b7 a0Stay close to your mic';

            // Kick off the animation loop that continuously reads microphone
            // data, runs pitch detection, and updates the UI.
            */ updatePitchLoop();
        } catch (err) {
            console.error('Error accessing microphone:', err);
            alert('Unable to access microphone. Please check your permissions.');
        }
    }

    /**
     * Analyze the uploaded reference audio file to estimate its
     * tempo (BPM) and an approximate main chord/root note.
     *
     * This runs once per upload in the background and does not
     * affect live microphone analysis.
     */
    async function analyzeReferenceAudio(file) {
        if (!file) return;

        // Show loading state
        if (tempoValueEl) tempoValueEl.textContent = '...';
        if (chordValueEl) chordValueEl.textContent = '...';
        if (tempoSummaryEl) tempoSummaryEl.textContent = '...';
        if (chordSummaryEl) chordSummaryEl.textContent = '...';

        try {
            const formData = new FormData();
            formData.append('file', file);

            // Call the python backend
            const response = await fetch('http://127.0.0.1:8000/analyze', {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                // If backend fails/is down, fallback or show error
                // For now, we'll just log it and maybe leave "..." or set to "--"
                throw new Error(`Server returned ${response.status}`);
            }

            const data = await response.json();

            // Update UI with backend results
            const tempoText = data.tempo ? `${data.tempo} BPM` : '--';
            const chordText = data.key || '--'; // Using 'key' as the main chord/key info

            // Store segments
            if (data.chords && Array.isArray(data.chords)) {
                currentChordSegments = data.chords;
            } else {
                currentChordSegments = [];
            }

            if (tempoValueEl) tempoValueEl.textContent = tempoText;
            if (chordValueEl) chordValueEl.textContent = chordText;

            if (tempoSummaryEl) tempoSummaryEl.textContent = tempoText;
            if (chordSummaryEl) chordSummaryEl.textContent = chordText;

            if (songAnalysisSection) {
                songAnalysisSection.style.opacity = '1';
            }

        } catch (err) {
            console.error('Error analyzing reference audio with backend:', err);
            // Fallback UI update
            if (tempoValueEl) tempoValueEl.textContent = '--';
            if (chordValueEl) chordValueEl.textContent = '--';
            if (tempoSummaryEl) tempoSummaryEl.textContent = '--';
            if (chordSummaryEl) chordSummaryEl.textContent = '--';
        }
    }



    /**
     * Load metadata for a Spotify track (tempo, key, time signature,
     * basic details) and update the left panel and bottom summary.
     *
     * IMPORTANT: This uses the Spotify Web API only for metadata.
     * The actual audio playback is handled by the Spotify embed
     * iframe and is NEVER passed into the Web Audio analysis
     * pipeline, keeping analysis restricted to user-uploaded
     * reference files only.
     */
    async function loadSpotifyMetadataAndEmbed(trackId) {
        if (!trackId || !spotifyPlayer) return;

        currentSpotifyTrackId = trackId;
        hasSpotifyTrack = true;

        if (clearSpotifyBtn) clearSpotifyBtn.style.display = 'inline-block';

        // Update the embed player to this track for playback only.
        spotifyPlayer.src = `https://open.spotify.com/embed/track/${encodeURIComponent(trackId)}`;

        // NOTE: You must supply a valid Spotify Web API access
        // token below. For security reasons, this demo expects you
        // to inject a token via environment or separate script.
        const SPOTIFY_ACCESS_TOKEN = window.SPOTIFY_ACCESS_TOKEN || '';

        // Even if no token, we allow the embed to work, but warn the user.
        if (!SPOTIFY_ACCESS_TOKEN) {
            console.warn('No Spotify access token provided. Only the embed player will work.');
            alert("Spotify Sync Unavailable:\n\nTo sync the Graph and Tempo, you must provide a valid 'Spotify Access Token' in script.js (line ~443).\n\nWithout this token, the app cannot fetch the song's Key, so the pitch feedback will not match the song.");
            return;
        }

        const headers = {
            Authorization: `Bearer ${SPOTIFY_ACCESS_TOKEN}`
        };

        try {
            // We fetch features for internal logic (graph fallback).
            // Fetch audio features (tempo, key, time signature)
            const featuresResp = await fetch(`https://api.spotify.com/v1/audio-features/${encodeURIComponent(trackId)}`, { headers });
            if (!featuresResp.ok) throw new Error('Failed to fetch audio features');
            const features = await featuresResp.json();

            // Tempo in BPM (only for summary)
            let tempoDisplay = '--';
            if (features.tempo && isFinite(features.tempo)) {
                tempoDisplay = `${features.tempo.toFixed(1)} BPM`;
            }

            if (tempoSummaryEl) {
                tempoSummaryEl.textContent = tempoDisplay;
            }

            // Musical key (Spotify returns 0–11, where 0 = C)
            const keyNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

            spotifyReferenceFrequency = null;
            if (typeof features.key === 'number' && features.key >= 0 && features.key < keyNames.length) {
                const keyIndex = features.key;

                // Derive a mid-range reference frequency for the
                // song key's tonic (e.g., C4–B4). This uses only
                // metadata (key index) and does NOT analyze audio.
                const midiForC4 = 60; // C4
                const midi = midiForC4 + keyIndex; // tonic in 4th octave
                const semitonesFromA4 = midi - 69; // A4 = 69
                spotifyReferenceFrequency = 440 * Math.pow(2, semitonesFromA4 / 12);
            }

            // Enable singing controls when a Spotify track is
            // connected, even if no local reference file exists.
            if (startSingingBtn) startSingingBtn.disabled = false;
            if (stopSingingBtn) stopSingingBtn.disabled = false;
        } catch (err) {
            console.error('Error loading Spotify metadata:', err);
        }
    }

    /**
     * Stop microphone capture and analysis, returning the UI to a
     * neutral waiting state while keeping the reference track loaded.
     */
    function stopMicrophone() {
        isListening = false;

        if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = null;
        }

        if (analyser && audioContext) {
            analyser.disconnect();
        }

        if (mediaStream) {
            mediaStream.getTracks().forEach(track => track.stop());
            mediaStream = null;
        }

        // Pause the reference track if it was playing, and remember
        // that state so we can resume playback when the user starts
        // singing again.
        if (audioPlayer) {
            wasAudioPlayingWhenStopped = !audioPlayer.paused && !audioPlayer.ended;
            if (!audioPlayer.paused) {
                audioPlayer.pause();
            }
        } else {
            wasAudioPlayingWhenStopped = false;
        }

        startSingingBtn.classList.remove('btn-recording');

        // Restore reference track volume

        // Restore reference track volume
        if (audioPlayer) {
            audioPlayer.volume = originalRefVolume;
        }

        startSingingBtn.textContent = 'Start Singing';
        // Keep reference, but go back to a waiting UI
        resetPitchPanel();

        // Reference track volume is left unchanged; users control it
        // AudioContext remains available so pausing/playing the
        // track continues to work without needing to recreate nodes.

        generateReport();
    }

    function generateReport() {
        if (!reportCard) return;

        const { total, match, near, miss } = sessionScore;
        if (total < 50) {
            // Not enough data
            return;
        }

        const score = Math.round(((match + near * 0.5) / total) * 100);

        reportScoreEl.textContent = `${score}%`;
        reportExcellentEl.textContent = `${Math.round((match / total) * 100)}%`;
        reportNearEl.textContent = `${Math.round((near / total) * 100)}%`;
        reportMissEl.textContent = `${Math.round((miss / total) * 100)}%`;

        let msg = "Keep practicing!";
        if (score > 85) msg = "Incredible! You nailed specific nuances.";
        else if (score > 70) msg = "Great job! You were mostly on pitch.";
        else if (score > 50) msg = "Good effort. Try to listen closely to the reference.";

        reportMessageEl.textContent = msg;
        reportCard.classList.remove('hidden');

        // Scroll to report
        reportCard.scrollIntoView({ behavior: 'smooth' });
    }

    /**
     * Main animation loop: grab a snapshot of time-domain microphone
     * data, run a simple autocorrelation-based pitch detector, and
     * update the Live Pitch Feedback panel.
     */
    function updatePitchLoop() {
        if (!isListening || !analyser || !audioContext) return;

        // --- Microphone pitch ---
        analyser.getFloatTimeDomainData(timeDomainData);
        const rawPitch = detectPitch(timeDomainData, audioContext.sampleRate);

        // --- Dynamic Chord Update (Live during Reference Playback) ---
        if (hasReferenceTrack && !audioPlayer.paused && currentChordSegments.length > 0) {
            const t = audioPlayer.currentTime;
            // Find current segment (simple linear search or findLast)
            // segments are sorted by time.
            let currentChord = null;
            for (let i = 0; i < currentChordSegments.length; i++) {
                if (t >= currentChordSegments[i].time) {
                    currentChord = currentChordSegments[i].chord;
                } else {
                    // Passed the current time
                    break;
                }
            }

            if (currentChord) {
                if (chordValueEl) chordValueEl.textContent = currentChord;
                if (chordSummaryEl) chordSummaryEl.textContent = currentChord;
            }
        }

        // --- Reference track pitch (uploaded audio) ---
        let referenceFrequency = null;
        if (!referenceAnalyser && audioContext) {
            // Lazily attach the reference analyser in case the
            // microphone started before the user loaded/played audio.
            setupReferenceAnalyser();
        }
        if (referenceAnalyser && referenceTimeDomainData && !audioPlayer.paused && !audioPlayer.ended) {
            referenceAnalyser.getFloatTimeDomainData(referenceTimeDomainData);
            referenceFrequency = detectPitch(referenceTimeDomainData, audioContext.sampleRate);
        }

        // If there is no active reference pitch from the uploaded
        // audio, fall back to a static reference based on the
        // Spotify key metadata (tonic frequency). This uses only
        // key information from the Web API, not Spotify audio.
        if (referenceFrequency == null && spotifyReferenceFrequency != null) {
            referenceFrequency = spotifyReferenceFrequency;
        }

        if (!rawPitch) {
            // No stable pitch detected
            pitchUserEl.textContent = '—';
            pitchUserNoteEl.textContent = 'Waiting for input';

            pitchStatusEl.textContent = 'Waiting';
            pitchStatusEl.classList.remove('status-match', 'status-near');
            pitchStatusEl.classList.add('status-waiting');
            pitchCardEl.classList.remove('is-active');

            // Reset smoothing state so a future value doesn't jump
            lastPitch = null;

            // Push a frame to the graph. If the reference track is
            // silent or paused, referenceFrequency will be null and
            // the blue line will temporarily disappear.
            addFrequenciesToGraph(referenceFrequency, null);
        } else {
            // Light smoothing so the display does not jitter between
            // frames. This is a simple one-pole low-pass filter in Hz.
            const pitch = lastPitch
                ? (lastPitch * 0.8 + rawPitch * 0.2)
                : rawPitch;
            lastPitch = pitch;

            // Show detected pitch in Hz
            const rounded = pitch.toFixed(1);
            pitchUserEl.textContent = `${rounded} Hz`;
            pitchUserNoteEl.textContent = 'Live microphone';

            // Compare against target frequency in cents
            // Update Target Display with dynamic reference pitch if available
            if (referenceFrequency) {
                pitchTargetEl.textContent = `${referenceFrequency.toFixed(1)} Hz`;
                const refNote = frequencyToNoteName(referenceFrequency);
                if (refNote) {
                    // Update the note label below the target Hz if it exists
                    const targetNoteEl = pitchTargetEl.parentElement.querySelector('.pitch-note');
                    if (targetNoteEl) targetNoteEl.textContent = refNote;
                }
            } else {
                pitchTargetEl.textContent = `${TARGET_FREQUENCY} Hz`;
            }

            // Compare against dynamic reference frequency if available, otherwise static target
            const currentTarget = referenceFrequency || TARGET_FREQUENCY;
            const centsDiff = frequencyToCentsOffset(pitch, currentTarget);
            const absCents = Math.abs(centsDiff);

            pitchStatusEl.classList.remove('status-match', 'status-near', 'status-waiting');

            if (absCents <= 20) {
                pitchStatusEl.textContent = 'Match';
                pitchStatusEl.classList.add('status-match');
                sessionScore.match++;
            } else if (absCents <= 50) {
                // "Near" - show direction
                const direction = centsDiff > 0 ? 'High' : 'Low';
                pitchStatusEl.textContent = `Near (${direction})`;
                pitchStatusEl.classList.add('status-near');
                sessionScore.near++;
            } else {
                // "Off" - show direction
                const direction = centsDiff > 0 ? 'Too High' : 'Too Low';
                pitchStatusEl.textContent = direction;
                // Off uses the default pill styling (no extra class)
                sessionScore.miss++;
            }
            sessionScore.total++;

            pitchCardEl.classList.add('is-active');

            pitchCardEl.classList.add('is-active');

            // Push a frame to the graph: both reference and user pitch
            addFrequenciesToGraph(referenceFrequency, pitch);
        }

        rafId = requestAnimationFrame(updatePitchLoop);
    }

    /**
     * Start Singing button handler
     */
    startSingingBtn.addEventListener('click', () => {
        if (!hasReferenceTrack && !hasSpotifyTrack) {
            alert("Please load a reference track or Spotify track first.");
            return;
        }

        if (isListening) return; // already running

        startMicrophone();

        // Duck the reference volume to reduce bleed
        if (audioPlayer) {
            originalRefVolume = audioPlayer.volume;
            audioPlayer.volume = Math.max(0, originalRefVolume * 0.3);
        }

        // If the reference audio was playing when the user last
        // pressed Stop, resume it from the same position.
        if (audioPlayer && wasAudioPlayingWhenStopped && audioPlayer.paused) {
            audioPlayer.play().catch(() => {
                // Ignore play errors (e.g., if browser blocks it)
            });
        }
    });

    if (stopSingingBtn) {
        stopSingingBtn.addEventListener('click', () => {
            if (!isListening) return;
            stopMicrophone();
        });
    }

    /**
     * Set up the Web Audio analyser for the reference track.
     */
    function setupReferenceAnalyser() {
        if (!audioContext || !audioPlayer) return;
        if (referenceSource) return; // already created

        try {
            referenceSource = audioContext.createMediaElementSource(audioPlayer);
            referenceAnalyser = audioContext.createAnalyser();
            referenceAnalyser.fftSize = 2048;

            referenceSource.connect(referenceAnalyser);
            referenceAnalyser.connect(audioContext.destination);

            referenceTimeDomainData = new Float32Array(referenceAnalyser.fftSize);
        } catch (err) {
            console.warn("Error setting up reference analyser (possibly already connected):", err);
        }
    }

    /**
     * Draw the live frequency graph.
     */
    function addFrequenciesToGraph(refFreq, userFreq) {
        if (!pitchGraphCtx || !pitchGraphCanvas) return;

        refFreqHistory.push(refFreq);
        if (refFreqHistory.length > GRAPH_HISTORY) refFreqHistory.shift();

        userFreqHistory.push(userFreq);
        if (userFreqHistory.length > GRAPH_HISTORY) userFreqHistory.shift();

        const w = pitchGraphCanvas.width;
        const h = pitchGraphCanvas.height;
        pitchGraphCtx.clearRect(0, 0, w, h);

        // Grid lines (optional visuals)
        pitchGraphCtx.strokeStyle = 'rgba(255,255,255,0.05)';
        pitchGraphCtx.lineWidth = 1;
        pitchGraphCtx.beginPath();
        // Draw 3 horizontal lines at approx 200, 440, 800 Hz
        [200, 440, 800].forEach(freq => {
            const pct = (freq - GRAPH_MIN_FREQ) / (GRAPH_MAX_FREQ - GRAPH_MIN_FREQ);
            const y = h - (Math.min(Math.max(pct, 0), 1) * h);
            pitchGraphCtx.moveTo(0, y);
            pitchGraphCtx.lineTo(w, y);
        });
        pitchGraphCtx.stroke();

        drawPath(refFreqHistory, '#3b82f6', 2, w, h); // Blue
        drawPath(userFreqHistory, '#ef4444', 3, w, h); // Red
    }

    function drawPath(data, color, lineWidth, w, h) {
        pitchGraphCtx.beginPath();
        pitchGraphCtx.strokeStyle = color;
        pitchGraphCtx.lineWidth = lineWidth;
        pitchGraphCtx.lineJoin = 'round';

        let pathStarted = false;

        for (let i = 0; i < data.length; i++) {
            const freq = data[i];
            if (freq == null) {
                pathStarted = false;
                continue;
            }

            const x = (i / (GRAPH_HISTORY - 1)) * w;
            const pct = (freq - GRAPH_MIN_FREQ) / (GRAPH_MAX_FREQ - GRAPH_MIN_FREQ);
            const y = h - (Math.min(Math.max(pct, 0), 1) * h);

            if (!pathStarted) {
                pitchGraphCtx.moveTo(x, y);
                pathStarted = true;
            } else {
                pitchGraphCtx.lineTo(x, y);
            }
        }
        pitchGraphCtx.stroke();
    }
    // }); removed to extend scope

    /**
     * Autocorrelation-based pitch detection working directly in the
     * time domain.
     */
    function detectPitch(timeData, sampleRate) {
        const size = timeData.length;

        // 1) Signal energy check via RMS
        let rms = 0;
        for (let i = 0; i < size; i++) {
            const val = timeData[i];
            rms += val * val;
        }
        rms = Math.sqrt(rms / size);
        if (rms < 0.01) {
            // Too quiet: likely no input or just background noise.
            return null;
        }

        // We focus only on the lag range that can represent typical
        // vocal fundamentals.
        const MIN_FREQUENCY = 50;   // Hz
        const MAX_FREQUENCY = 1000; // Hz

        // lag = sampleRate / frequency
        let minLag = Math.floor(sampleRate / MAX_FREQUENCY);
        let maxLag = Math.floor(sampleRate / MIN_FREQUENCY);

        // Keep lags within the buffer
        minLag = Math.max(1, minLag);
        maxLag = Math.min(size - 1, maxLag);

        // Autocorrelation at lag 0 is the signal energy, used to
        // normalize other lags.
        let r0 = 0;
        for (let i = 0; i < size; i++) {
            r0 += timeData[i] * timeData[i];
        }
        if (r0 === 0) {
            return null;
        }

        let bestLag = -1;
        let bestCorrelation = 0;

        // 2) Compute R(lag) for the desired lag range
        for (let lag = minLag; lag <= maxLag; lag++) {
            let sum = 0;
            for (let i = 0; i < size - lag; i++) {
                sum += timeData[i] * timeData[i + lag];
            }

            if (sum > bestCorrelation) {
                bestCorrelation = sum;
                bestLag = lag;
            }
        }

        if (bestLag === -1) {
            return null;
        }

        // Normalize the best correlation value against the zero-lag
        // autocorrelation to ignore low-confidence results.
        const normalizedCorrelation = bestCorrelation / r0;
        if (normalizedCorrelation < 0.3) {
            return null;
        }

        // 3) Convert the best lag to a frequency
        const frequency = sampleRate / bestLag;

        // 4) Clamp to a realistic vocal range
        if (frequency < MIN_FREQUENCY || frequency > MAX_FREQUENCY) {
            return null;
        }

        return frequency;
    }

    /**
     * Convert a frequency difference into cents relative to a target
     * frequency. 1200 cents = 1 octave.
     */
    function frequencyToCentsOffset(freq, targetFreq) {
        return 1200 * Math.log2(freq / targetFreq);
    }

    /**
     * Map a frequency in Hz to a musical note name with octave
     * (e.g. A4, C#3). This is used for displaying an approximate
     * main chord/root for the reference track.
     */
    function frequencyToNoteName(freq) {
        if (!freq || !isFinite(freq)) return null;

        const A4 = 440;
        const semitonesFromA4 = Math.round(12 * Math.log2(freq / A4));
        const midi = 69 + semitonesFromA4; // MIDI note number for A4 is 69

        if (midi < 0 || midi > 127) return null;

        const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const indexFromC = (midi - 60 + 1200) % 12; // 60 is middle C (C4)
        const noteName = noteNames[indexFromC];
        const octave = Math.floor(midi / 12) - 1;

        return `${noteName}${octave}`;
    }

    /**
     * Estimate the dominant note across the reference track by
     * sampling short frames and running the same pitch detector used
     * for the microphone. This gives an approximate main note/root
     * that we display as the song's main chord.
     */
    function estimateDominantNote(channelData, sampleRate) {
        const frameSize = 2048;
        const hopSize = 1024;

        // Analyze up to the first ~20 seconds for speed.
        const maxSamples = Math.min(channelData.length, sampleRate * 20);

        const noteCounts = Object.create(null);
        const frame = new Float32Array(frameSize);

        for (let start = 0; start + frameSize < maxSamples; start += hopSize) {
            for (let i = 0; i < frameSize; i++) {
                frame[i] = channelData[start + i];
            }

            const freq = detectPitch(frame, sampleRate);
            if (!freq) continue;

            const noteName = frequencyToNoteName(freq);
            if (!noteName) continue;

            noteCounts[noteName] = (noteCounts[noteName] || 0) + 1;
        }

        let bestNote = null;
        let bestCount = 0;
        for (const [name, count] of Object.entries(noteCounts)) {
            if (count > bestCount) {
                bestCount = count;
                bestNote = name;
            }
        }

        return bestNote;
    }

    function resetSpotifyTrack() {
        if (spotifyPlayer) spotifyPlayer.src = '';
        if (spotifyTrackInput) spotifyTrackInput.value = '';
        if (clearSpotifyBtn) clearSpotifyBtn.style.display = 'none';

        currentSpotifyTrackId = null;
        hasSpotifyTrack = false;
        spotifyReferenceFrequency = null;

        // Clear summary if it came from Spotify (and no ref track)
        if (tempoSummaryEl && !hasReferenceTrack) tempoSummaryEl.textContent = '--';

        updateSingingControlsState();
    }

    function removeReferenceTrack() {
        if (audioPlayer) {
            audioPlayer.pause();
            audioPlayer.src = '';
        }
        if (audioUpload) audioUpload.value = '';
        if (fileNameDisplay) fileNameDisplay.textContent = 'No file selected';

        if (audioPreviewContainer) audioPreviewContainer.classList.add('hidden');

        // Clear analysis
        if (tempoValueEl) tempoValueEl.textContent = '--';
        if (chordValueEl) chordValueEl.textContent = '--';
        if (songAnalysisSection) songAnalysisSection.style.opacity = '0.5';

        if (tempoSummaryEl) tempoSummaryEl.textContent = '--';
        if (chordSummaryEl) chordSummaryEl.textContent = '--';

        hasReferenceTrack = false;

        updateSingingControlsState();
    }

    function updateSingingControlsState() {
        const canSing = hasReferenceTrack || hasSpotifyTrack;
        if (startSingingBtn) startSingingBtn.disabled = !canSing;
        if (stopSingingBtn) stopSingingBtn.disabled = !canSing;
    }
});
