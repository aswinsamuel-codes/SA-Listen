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
    const spotifyCoverPlaceholder = document.getElementById('spotifyCoverPlaceholder');
    const spotifyCoverImg = document.getElementById('spotifyCover');
    const spotifyTitleEl = document.getElementById('spotifyTitle');
    const spotifyArtistEl = document.getElementById('spotifyArtist');
    const spotifyTempoEl = document.getElementById('spotifyTempo');
    const spotifyKeyEl = document.getElementById('spotifyKey');
    const spotifyTimeSigEl = document.getElementById('spotifyTimeSig');
    const spotifyTempoSummaryEl = document.getElementById('spotifyTempoSummary');
    const chordSummaryEl = document.getElementById('chordSummary');

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

    // Handle Spotify track loading (metadata + embed only)
    if (loadSpotifyBtn && spotifyTrackInput) {
        loadSpotifyBtn.addEventListener('click', () => {
            const raw = spotifyTrackInput.value.trim();
            if (!raw) return;
            const trackId = extractSpotifyTrackId(raw);
            if (!trackId) {
                alert('Please paste a valid Spotify track URL or ID.');
                return;
            }
            loadSpotifyMetadataAndEmbed(trackId);
        });
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
            startSingingBtn.textContent = 'Stop Singing';
            pitchUserNoteEl.textContent = 'Listening a0 b7 a0Stay close to your mic';

            // Kick off the animation loop that continuously reads microphone
            // data, runs pitch detection, and updates the UI.
            updatePitchLoop();
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
    function analyzeReferenceAudio(file) {
        if (!file || !window.MusicTempo) {
            // Library missing or no file - leave placeholders.
            return;
        }

        const reader = new FileReader();
        reader.onload = async (event) => {
            const arrayBuffer = event.target.result;

            try {
                const AudioContextClass = window.AudioContext || window.webkitAudioContext;
                const ctx = new AudioContextClass();
                const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

                const channelData = audioBuffer.getChannelData(0);

                // Optional: down-sample for speed on long tracks by
                // picking every Nth sample.
                const downSampleFactor = Math.max(1, Math.floor(audioBuffer.sampleRate / 44100));
                const downSampled = new Float32Array(Math.floor(channelData.length / downSampleFactor));
                for (let i = 0, j = 0; i < channelData.length; i += downSampleFactor, j++) {
                    downSampled[j] = channelData[i];
                }

                // --- Tempo estimation (BPM) using MusicTempo ---
                let tempoText = '--';
                try {
                    const mt = new MusicTempo(downSampled);
                    if (mt && typeof mt.tempo === 'number' && isFinite(mt.tempo) && mt.tempo > 0) {
                        tempoText = `${mt.tempo.toFixed(1)} BPM`;
                    }
                } catch (e) {
                    console.warn('Tempo analysis failed:', e);
                }

                tempoValueEl.textContent = tempoText;

                // --- Approximate main chord/root note ---
                let chordText = '--';
                try {
                    const dominantNote = estimateDominantNote(channelData, audioBuffer.sampleRate);
                    if (dominantNote) {
                        chordText = dominantNote;
                    }
                } catch (e) {
                    console.warn('Chord analysis failed:', e);
                }

                chordValueEl.textContent = chordText;

                // Chord/tempo summary under the graph reflects the
                // uploaded reference analysis (not Spotify).
                if (chordSummaryEl) {
                    chordSummaryEl.textContent = chordText;
                }

                if (songAnalysisSection) {
                    songAnalysisSection.style.opacity = '1';
                }

                ctx.close();
            } catch (err) {
                console.error('Error analyzing reference audio:', err);
            }
        };

        reader.readAsArrayBuffer(file);
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


        // Update the embed player to this track for playback only.
        spotifyPlayer.src = `https://open.spotify.com/embed/track/${encodeURIComponent(trackId)}`;

        // NOTE: You must supply a valid Spotify Web API access
        // token below. For security reasons, this demo expects you
        // to inject a token via environment or separate script.
        const SPOTIFY_ACCESS_TOKEN = window.SPOTIFY_ACCESS_TOKEN || '';
        if (!SPOTIFY_ACCESS_TOKEN) {
            console.warn('No Spotify access token provided. Only the embed player will work.');
            return;
        }

        const headers = {
            Authorization: `Bearer ${SPOTIFY_ACCESS_TOKEN}`
        };

        try {
            // Fetch basic track info
            const trackResp = await fetch(`https://api.spotify.com/v1/tracks/${encodeURIComponent(trackId)}`, { headers });
            if (!trackResp.ok) throw new Error('Failed to fetch track metadata');
            const track = await trackResp.json();

            // Update title/artist/cover
            spotifyTitleEl.textContent = track.name || 'Unknown title';
            const artistNames = (track.artists || []).map(a => a.name).join(', ');
            spotifyArtistEl.textContent = artistNames || 'Unknown artist';

            const image = track.album && track.album.images && track.album.images[0];
            if (image && image.url) {
                spotifyCoverImg.src = image.url;
                spotifyCoverImg.style.display = 'block';
                if (spotifyCoverPlaceholder) {
                    spotifyCoverPlaceholder.style.display = 'none';
                }
            } else if (spotifyCoverPlaceholder) {
                spotifyCoverImg.style.display = 'none';
                spotifyCoverPlaceholder.style.display = 'flex';
            }

            // Fetch audio features (tempo, key, time signature)
            const featuresResp = await fetch(`https://api.spotify.com/v1/audio-features/${encodeURIComponent(trackId)}`, { headers });
            if (!featuresResp.ok) throw new Error('Failed to fetch audio features');
            const features = await featuresResp.json();

            // Tempo in BPM
            let tempoDisplay = '--';
            if (features.tempo && isFinite(features.tempo)) {
                tempoDisplay = `${features.tempo.toFixed(1)} BPM`;
            }
            spotifyTempoEl.textContent = tempoDisplay;
            if (spotifyTempoSummaryEl) {
                spotifyTempoSummaryEl.textContent = tempoDisplay;
            }

            // Musical key (Spotify returns 0–11, where 0 = C)
            const keyNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
            let keyDisplay = '--';
            spotifyReferenceFrequency = null;
            if (typeof features.key === 'number' && features.key >= 0 && features.key < keyNames.length) {
                const keyIndex = features.key;
                keyDisplay = keyNames[keyIndex] || '--';
                if (features.mode === 1) {
                    keyDisplay += ' major';
                } else if (features.mode === 0) {
                    keyDisplay += ' minor';
                }

                // Derive a mid-range reference frequency for the
                // song key's tonic (e.g., C4–B4). This uses only
                // metadata (key index) and does NOT analyze audio.
                const midiForC4 = 60; // C4
                const midi = midiForC4 + keyIndex; // tonic in 4th octave
                const semitonesFromA4 = midi - 69; // A4 = 69
                spotifyReferenceFrequency = 440 * Math.pow(2, semitonesFromA4 / 12);
            }
            spotifyKeyEl.textContent = keyDisplay;

            // Time signature (e.g., 4/4)
            let tsDisplay = '--';
            if (features.time_signature && isFinite(features.time_signature)) {
                tsDisplay = `${features.time_signature}/4`;
            }
            spotifyTimeSigEl.textContent = tsDisplay;

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

        startSingingBtn.textContent = 'Start Singing';
        // Keep reference, but go back to a waiting UI
        resetPitchPanel();

        // Reference track volume is left unchanged; users control it
        // directly via the built-in audio player UI. The shared
        // AudioContext remains available so pausing/playing the
        // track continues to work without needing to recreate nodes.
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
            const centsDiff = frequencyToCentsOffset(pitch, TARGET_FREQUENCY);
            const absCents = Math.abs(centsDiff);

            pitchStatusEl.classList.remove('status-match', 'status-near', 'status-waiting');

            if (absCents <= 20) {
                pitchStatusEl.textContent = 'Match';
                pitchStatusEl.classList.add('status-match');
            } else if (absCents <= 50) {
                pitchStatusEl.textContent = 'Near';
                pitchStatusEl.classList.add('status-near');
            } else {
                pitchStatusEl.textContent = 'Off';
                // Off uses the default pill styling (no extra class)
            }

            pitchCardEl.classList.add('is-active');

            // Push a frame to the graph: both reference and user pitch
            addFrequenciesToGraph(referenceFrequency, pitch);
        }

        rafId = requestAnimationFrame(updatePitchLoop);
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

    /**
     * Attach the <audio> element used for the reference track to the
     * shared AudioContext via its own AnalyserNode. This lets us run
     * the same time-domain pitch detection on the reference audio
     * that we already use for the microphone.
     */
    function setupReferenceAnalyser() {
        if (!audioContext || !audioPlayer) return;
        if (referenceAnalyser || referenceSource) return; // Already connected for this context

        try {
            // createMediaElementSource taps the <audio> element into
            // the Web Audio graph. Once we do this, we are
            // responsible for routing it to the speakers via
            // audioContext.destination.
            referenceSource = audioContext.createMediaElementSource(audioPlayer);
            referenceAnalyser = audioContext.createAnalyser();
            referenceAnalyser.fftSize = 2048;
            referenceTimeDomainData = new Float32Array(referenceAnalyser.fftSize);

            // Audio routing for the reference track:
            //   <audio> element -> referenceAnalyser -> destination
            // This lets us both hear the backing track and analyze it
            // in real time for pitch extraction.
            referenceSource.connect(referenceAnalyser);
            referenceAnalyser.connect(audioContext.destination);
        } catch (err) {
            console.error('Error setting up reference analyser:', err);
            referenceAnalyser = null;
            referenceSource = null;
            referenceTimeDomainData = null;
        }
    }

    /**
     * Store the latest reference/user frequencies into a sliding
     * history buffer and schedule a canvas redraw at ~30 FPS.
     */
    function addFrequenciesToGraph(refFreq, userFreq) {
        if (!pitchGraphCtx || !pitchGraphCanvas) return;

        refFreqHistory.push(refFreq);
        userFreqHistory.push(userFreq);

        if (refFreqHistory.length > GRAPH_HISTORY) {
            refFreqHistory.shift();
            userFreqHistory.shift();
        }

        const now = (window.performance && performance.now) ? performance.now() : Date.now();
        if (now - lastGraphDrawTime >= 33) { // ~30 FPS
            drawPitchGraph();
            lastGraphDrawTime = now;
        }
    }

    /**
     * Redraw the live frequency comparison graph on the canvas.
     * X-axis: time (oldest on the left, newest on the right).
     * Y-axis: frequency in Hz, clamped to 50–1000 Hz.
     * Blue line: reference; Red line: user.
     */
    function drawPitchGraph() {
        if (!pitchGraphCtx || !pitchGraphCanvas) return;

        const width = pitchGraphCanvas.width;
        const height = pitchGraphCanvas.height;
        const len = refFreqHistory.length;

        // Clear previous frame
        pitchGraphCtx.clearRect(0, 0, width, height);

        if (len < 2) return;

        // Helper: map frequency in Hz to Y pixel coordinate
        const freqToY = (freq) => {
            if (freq == null || Number.isNaN(freq)) return null;

            // Clamp to vocal range
            const f = Math.min(Math.max(freq, GRAPH_MIN_FREQ), GRAPH_MAX_FREQ);
            const ratio = (f - GRAPH_MIN_FREQ) / (GRAPH_MAX_FREQ - GRAPH_MIN_FREQ);
            return height - ratio * height;
        };

        // Draw reference frequency line (blue)
        pitchGraphCtx.lineWidth = 2;
        pitchGraphCtx.strokeStyle = '#3B82F6';
        pitchGraphCtx.globalAlpha = 0.95;
        pitchGraphCtx.beginPath();

        let move = true;
        for (let i = 0; i < len; i++) {
            const x = (i / (len - 1)) * width;
            const y = freqToY(refFreqHistory[i]);
            if (y == null) {
                move = true;
                continue;
            }
            if (move) {
                pitchGraphCtx.moveTo(x, y);
                move = false;
            } else {
                pitchGraphCtx.lineTo(x, y);
            }
        }
        pitchGraphCtx.stroke();

        // Draw user pitch line (red)
        pitchGraphCtx.strokeStyle = '#F97373';
        pitchGraphCtx.globalAlpha = 0.95;
        pitchGraphCtx.beginPath();
        move = true;

        for (let i = 0; i < len; i++) {
            const x = (i / (len - 1)) * width;
            const y = freqToY(userFreqHistory[i]);
            if (y == null) {
                move = true;
                continue;
            }
            if (move) {
                pitchGraphCtx.moveTo(x, y);
                move = false;
            } else {
                pitchGraphCtx.lineTo(x, y);
            }
        }
        pitchGraphCtx.stroke();

        // Reset alpha for any later drawing
        pitchGraphCtx.globalAlpha = 1;
    }

    /**
     * Autocorrelation-based pitch detection working directly in the
     * time domain.
     *
     * Steps:
     * 1. Check the signal energy (RMS) to ignore silence / noise.
     * 2. Compute the autocorrelation R(lag) over a range of lags that
     *    correspond to the desired vocal range (50–1000 Hz).
     * 3. Find the lag with the highest correlation (best repeating
     *    pattern).
     * 4. Convert that lag into a fundamental frequency:
     *        f0 = sampleRate / lag
     *
     * Returns a frequency in Hz between 50 and 1000, or null if no
     * clear pitch is present.
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

    // Wire up Start / Stop singing controls
    if (startSingingBtn) {
        startSingingBtn.addEventListener('click', () => {
            if (!hasReferenceTrack && !hasSpotifyTrack) {
                alert('Connect a Spotify track or upload a reference track first.');
                return;
            }

            if (isListening) return; // already running

            startMicrophone();

            // If the reference audio was playing when the user last
            // pressed Stop, resume it from the same position.
            if (audioPlayer && wasAudioPlayingWhenStopped && audioPlayer.paused) {
                audioPlayer.play().catch(() => {
                    // Ignore play errors (e.g., if browser blocks it)
                });
            }
        });
    }

    if (stopSingingBtn) {
        stopSingingBtn.addEventListener('click', () => {
            if (!isListening) return;
            stopMicrophone();
        });
    }
});