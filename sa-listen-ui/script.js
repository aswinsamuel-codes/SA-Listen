/*
 * SA Listen - AI Vocal Analysis
 * Copyright (C) 2024 Sukin S, Aswin Samuel A.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

document.addEventListener('DOMContentLoaded', () => {
    // Backend location. When the page is served by the FastAPI app, use the
    // same origin (works on any host/port); fall back to the default dev
    // server when the HTML is opened straight from disk.
    const API_BASE = window.location.protocol.startsWith('http') ? '' : 'http://127.0.0.1:8000';

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

    // Reference volume before singing started (restored on Stop when the
    // track was turned down for speaker use).
    let originalRefVolume = audioPlayer ? audioPlayer.volume : 1;

    // Simple state flags
    let hasReferenceTrack = false;
    let isListening = false;
    let isStartingMic = false; // true while waiting for the mic permission prompt
    let referenceObjectUrl = null;
    let sessionObjectUrl = null;

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

    // Session Recording State
    let mediaRecorder = null;
    let recordedChunks = [];
    const recordingPreview = document.getElementById('recordingPreview');
    const sessionAudio = document.getElementById('sessionAudio');
    const downloadSessionBtn = document.getElementById('downloadSessionBtn');

    // Separate analyser for the reference track (<audio> element)
    // so we can detect its pitch independently of the microphone.
    let referenceAnalyser = null;
    let referenceTimeDomainData = null;
    let referenceSource = null;

    // Mic source + recording bus (mic and, optionally, the backing track)
    let micSource = null;
    let recordDest = null;
    let backingRecordGain = null;

    // Karaoke mode: audioPlayer plays the instrumental, guidePlayer plays
    // the separated original vocal in sync. The guide vocal is also the
    // pitch target, which is far cleaner than detecting pitch in a full mix.
    const guidePlayer = document.getElementById('guidePlayer');
    let isKaraokeMode = false;
    let guideLevel = 0.35;
    let guideSource = null;
    let guideAnalyser = null;
    let guideGain = null;
    let guideTimeDomainData = null;
    let currentReferenceFile = null; // the uploaded File, for "make karaoke from this track"

    const headphonesToggle = document.getElementById('headphonesToggle');
    const mixBackingToggle = document.getElementById('mixBackingToggle');

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

    // --- Keep the guide vocal locked to the instrumental ---
    function syncGuide(force) {
        if (!isKaraokeMode || !guidePlayer || !guidePlayer.src) return;
        if (guidePlayer.playbackRate !== audioPlayer.playbackRate) {
            guidePlayer.playbackRate = audioPlayer.playbackRate;
        }
        if (force || Math.abs(guidePlayer.currentTime - audioPlayer.currentTime) > 0.12) {
            guidePlayer.currentTime = audioPlayer.currentTime;
        }
    }

    if (audioPlayer && guidePlayer) {
        audioPlayer.addEventListener('play', () => {
            if (!isKaraokeMode) return;
            syncGuide(true);
            guidePlayer.play().catch(() => { /* will retry on next play */ });
        });
        audioPlayer.addEventListener('pause', () => guidePlayer.pause());
        audioPlayer.addEventListener('ended', () => guidePlayer.pause());
        audioPlayer.addEventListener('seeked', () => syncGuide(true));
        audioPlayer.addEventListener('ratechange', () => syncGuide(false));
        audioPlayer.addEventListener('timeupdate', () => {
            if (!audioPlayer.paused) syncGuide(false);
        });
    }

    // --- Practice Tools: A-B Looping ---
    let loopStart = 0;
    let loopEnd = 0;
    let isLooping = false;
    let loopCheckInterval = null;

    const practiceTools = document.getElementById('practiceTools');
    const setLoopStartBtn = document.getElementById('setLoopStartBtn');
    const setLoopEndBtn = document.getElementById('setLoopEndBtn');
    const toggleLoopBtn = document.getElementById('toggleLoopBtn');
    const loopStatus = document.getElementById('loopStatus');

    function formatTime(seconds) {
        if (!seconds && seconds !== 0) return "--:--";
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    function updateLoopUI() {
        loopStatus.textContent = `${formatTime(loopStart)} / ${formatTime(loopEnd)}`;

        // Only enable loop toggle if we have a valid range
        if (loopEnd > loopStart + 0.5) {
            toggleLoopBtn.disabled = false;
        } else {
            toggleLoopBtn.disabled = true;
            isLooping = false; // logic failsafe
        }

        if (isLooping) {
            toggleLoopBtn.classList.remove('btn-outline');
            toggleLoopBtn.classList.add('btn-primary', 'btn-glow');
            toggleLoopBtn.textContent = "Loop Active";
        } else {
            toggleLoopBtn.classList.add('btn-outline');
            toggleLoopBtn.classList.remove('btn-primary', 'btn-glow');
            toggleLoopBtn.textContent = "Enable Loop";
        }
    }

    if (setLoopStartBtn && audioPlayer) {
        setLoopStartBtn.addEventListener('click', () => {
            loopStart = audioPlayer.currentTime;
            updateLoopUI();
        });

        setLoopEndBtn.addEventListener('click', () => {
            loopEnd = audioPlayer.currentTime;
            updateLoopUI();
        });

        toggleLoopBtn.addEventListener('click', () => {
            isLooping = !isLooping;
            updateLoopUI();

            if (isLooping) {
                // Seek to start immediately if outside range
                if (audioPlayer.currentTime < loopStart || audioPlayer.currentTime > loopEnd) {
                    audioPlayer.currentTime = loopStart;
                }
            }
        });

        // The Looping Engine
        audioPlayer.addEventListener('timeupdate', () => {
            if (!isLooping) return;

            if (audioPlayer.currentTime >= loopEnd) {
                audioPlayer.currentTime = loopStart;
            }
        });
    }

    // --- Practice Tools: speed + guide vocal level ---
    const speedSelect = document.getElementById('speedSelect');
    const guideVolumeRow = document.getElementById('guideVolumeRow');
    const guideVolumeInput = document.getElementById('guideVolume');
    const guideVolumeValue = document.getElementById('guideVolumeValue');

    if (speedSelect && audioPlayer) {
        speedSelect.addEventListener('change', () => {
            const rate = parseFloat(speedSelect.value) || 1;
            // Browsers keep the key when slowing down (preservesPitch is on by default).
            audioPlayer.defaultPlaybackRate = rate; // survives loading a new track
            audioPlayer.playbackRate = rate;
        });
    }

    function applyGuideLevel() {
        if (guideGain) {
            guideGain.gain.value = guideLevel;
        } else if (guidePlayer) {
            guidePlayer.volume = guideLevel; // before the Web Audio graph exists
        }
    }

    if (guideVolumeInput) {
        guideVolumeInput.addEventListener('input', () => {
            guideLevel = Number(guideVolumeInput.value) / 100;
            if (guideVolumeValue) guideVolumeValue.textContent = `${guideVolumeInput.value}%`;
            applyGuideLevel();
        });
    }
    applyGuideLevel();

    // Handle file selection via input
    audioUpload.addEventListener('change', handleFileSelect);

    // Live singing controls (exactly one listener each; a second listener
    // used to open the mic twice and leak a stream that never stopped)
    startSingingBtn.addEventListener('click', () => {
        if (!hasReferenceTrack) {
            alert("Please load a reference track first.");
            return;
        }
        if (isListening || isStartingMic) return;
        startMicrophone();
    });

    if (stopSingingBtn) {
        stopSingingBtn.addEventListener('click', () => {
            if (!isListening) return;
            stopMicrophone();
        });
    }

    // --- Audio Splitter Logic ---
    const splitterUpload = document.getElementById('splitterUpload');
    const splitterFileName = document.getElementById('splitterFileName');
    const processSplitBtn = document.getElementById('processSplitBtn');
    const splitterActions = document.getElementById('splitterActions');
    const splitterLoading = document.getElementById('splitterLoading');
    const stemsContainer = document.getElementById('stemsContainer');
    const resetSplitterBtn = document.getElementById('resetSplitterBtn');
    const stemVocals = document.getElementById('stemVocals');
    const stemDrums = document.getElementById('stemDrums');
    const stemBass = document.getElementById('stemBass');
    const stemPiano = document.getElementById('stemPiano');
    const stemOther = document.getElementById('stemOther');

    const downloadVocals = document.getElementById('downloadVocals');
    const downloadDrums = document.getElementById('downloadDrums');
    const downloadBass = document.getElementById('downloadBass');
    const downloadPiano = document.getElementById('downloadPiano');
    const downloadOther = document.getElementById('downloadOther');

    const removeSplitFileBtn = document.getElementById('removeSplitFileBtn');

    let splitFile = null;

    if (splitterUpload) {
        splitterUpload.addEventListener('change', (e) => {
            if (e.target.files && e.target.files[0]) {
                splitFile = e.target.files[0];
                splitterFileName.textContent = splitFile.name;
                splitterActions.classList.remove('hidden');
                stemsContainer.classList.add('hidden');
                if (removeSplitFileBtn) removeSplitFileBtn.classList.remove('hidden');
            }
        });
    }

    if (removeSplitFileBtn) {
        removeSplitFileBtn.addEventListener('click', () => {
            splitFile = null;
            splitterUpload.value = '';
            splitterFileName.textContent = 'No file selected';
            splitterActions.classList.add('hidden');
            stemsContainer.classList.add('hidden');
            removeSplitFileBtn.classList.add('hidden');
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

                const response = await fetch(`${API_BASE}/split`, {
                    method: 'POST',
                    body: formData
                });

                if (!response.ok) {
                    let detail = '';
                    try { detail = (await response.json()).detail || ''; } catch (_) { /* not JSON */ }
                    throw new Error(detail || "Split failed");
                }

                const data = await response.json();

                // data keys: vocals, drums, bass, piano, other
                const baseUrl = API_BASE;

                if (stemVocals) stemVocals.src = `${baseUrl}${data.vocals}`;
                if (stemDrums) stemDrums.src = `${baseUrl}${data.drums}`;
                if (stemBass) stemBass.src = `${baseUrl}${data.bass}`;
                if (stemPiano) stemPiano.src = `${baseUrl}${data.piano}`;
                if (stemOther) stemOther.src = `${baseUrl}${data.other}`;

                if (downloadVocals) downloadVocals.href = `${baseUrl}${data.vocals}`;
                if (downloadDrums) downloadDrums.href = `${baseUrl}${data.drums}`;
                if (downloadBass) downloadBass.href = `${baseUrl}${data.bass}`;
                if (downloadPiano) downloadPiano.href = `${baseUrl}${data.piano}`;
                if (downloadOther) downloadOther.href = `${baseUrl}${data.other}`;

                stemsContainer.classList.remove('hidden');

            } catch (err) {
                console.error(err);
                // Attempt to see if we have a useful error message
                let msg = err.message;
                if (err.message === "Split failed") {
                    msg = "The backend failed to split the audio. Check the terminal for '500' errors.";
                }
                alert(`Split Error: ${msg}\n\nPlease check the backend console for details.`);

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

    // Demo Track Loader
    const loadDemoBtn = document.getElementById('loadDemoBtn');
    if (loadDemoBtn) {
        loadDemoBtn.addEventListener('click', async () => {
            // Show simple loading state
            loadDemoBtn.textContent = 'Loading...';
            loadDemoBtn.disabled = true;

            try {
                // Fetch valid mp3 from test folder
                const response = await fetch('test/sacred-echo-by-makrifat-islam-388776.mp3');
                if (!response.ok) throw new Error("Demo file not found");

                const blob = await response.blob();
                const file = new File([blob], "Demo: Sacred Echo.mp3", { type: "audio/mp3" });

                processFile(file);

                // Hide demo button area after loading
                loadDemoBtn.parentElement.style.display = 'none';

            } catch (err) {
                console.error("Demo load failed:", err);
                alert("Could not load demo track. Please upload a file manually.");
                loadDemoBtn.textContent = '✨ Try a Demo Track';
                loadDemoBtn.disabled = false;
            }
        });
    }

    // --- Karaoke mode (YouTube link or uploaded file -> instrumental + guide) ---
    const karaokeForm = document.getElementById('karaokeForm');
    const youtubeUrlInput = document.getElementById('youtubeUrlInput');
    const makeKaraokeBtn = document.getElementById('makeKaraokeBtn');
    const makeKaraokeFromFileBtn = document.getElementById('makeKaraokeFromFileBtn');
    const karaokeProgress = document.getElementById('karaokeProgress');
    const karaokeStage = document.getElementById('karaokeStage');
    const karaokePercent = document.getElementById('karaokePercent');
    const karaokeProgressFill = document.getElementById('karaokeProgressFill');
    const karaokeError = document.getElementById('karaokeError');
    const karaokeBadge = document.getElementById('karaokeBadge');
    let karaokeBusy = false;

    function setKaraokeBusy(busy) {
        karaokeBusy = busy;
        if (makeKaraokeBtn) makeKaraokeBtn.disabled = busy;
        if (makeKaraokeFromFileBtn) makeKaraokeFromFileBtn.disabled = busy;
        if (karaokeProgress) karaokeProgress.classList.toggle('hidden', !busy);
    }

    function showKaraokeError(message) {
        if (!karaokeError) return;
        karaokeError.textContent = message || '';
        karaokeError.classList.toggle('hidden', !message);
    }

    function showKaraokeProgress(stage, progress) {
        if (karaokeStage) karaokeStage.textContent = stage || 'Working…';
        const known = typeof progress === 'number';
        if (karaokePercent) karaokePercent.textContent = known ? `${progress}%` : '';
        if (karaokeProgressFill) {
            karaokeProgressFill.classList.toggle('indeterminate', !known);
            karaokeProgressFill.style.width = known ? `${progress}%` : '';
        }
    }

    async function runKaraokeJob(formData) {
        if (karaokeBusy) return;
        setKaraokeBusy(true);
        showKaraokeError('');
        showKaraokeProgress('Starting…', null);

        try {
            const startResp = await fetch(`${API_BASE}/karaoke`, { method: 'POST', body: formData });
            const startData = await startResp.json().catch(() => ({}));
            if (!startResp.ok) throw new Error(startData.detail || `Server returned ${startResp.status}`);

            // Poll until the job finishes.
            for (;;) {
                await new Promise(r => setTimeout(r, 1500));
                const resp = await fetch(`${API_BASE}/karaoke/${startData.job_id}`);
                const job = await resp.json().catch(() => ({}));
                if (!resp.ok) throw new Error(job.detail || `Server returned ${resp.status}`);

                if (job.status === 'done') {
                    loadKaraokeTrack(job.result);
                    if (youtubeUrlInput) youtubeUrlInput.value = '';
                    break;
                }
                if (job.status === 'error') throw new Error(job.error || 'Karaoke failed.');
                const label = job.title ? `${job.stage} · ${job.title}` : job.stage;
                showKaraokeProgress(label, job.progress);
            }
        } catch (err) {
            console.error('Karaoke failed:', err);
            const offline = err instanceof TypeError; // fetch() network failure
            showKaraokeError(offline
                ? 'Could not reach the SA Listen backend. Is it running (python backend/main.py)?'
                : err.message);
        } finally {
            setKaraokeBusy(false);
        }
    }

    if (karaokeForm) {
        karaokeForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const url = youtubeUrlInput.value.trim();
            if (!url) return;
            const formData = new FormData();
            formData.append('url', url);
            runKaraokeJob(formData);
        });
    }

    if (makeKaraokeFromFileBtn) {
        makeKaraokeFromFileBtn.addEventListener('click', () => {
            if (!currentReferenceFile) return;
            const formData = new FormData();
            formData.append('file', currentReferenceFile);
            runKaraokeJob(formData);
        });
    }

    function setKaraokeMode(on) {
        isKaraokeMode = on;
        if (karaokeBadge) karaokeBadge.classList.toggle('hidden', !on);
        if (guideVolumeRow) guideVolumeRow.classList.toggle('hidden', !on);
        if (!on && guidePlayer) {
            guidePlayer.pause();
            guidePlayer.removeAttribute('src');
            guidePlayer.load();
        }
    }

    /**
     * Load a finished karaoke job: instrumental in the main player, the
     * separated vocal as a synced guide (and as the pitch target).
     */
    function loadKaraokeTrack(result) {
        if (!result) return;
        if (isListening) stopMicrophone();

        if (referenceObjectUrl) {
            URL.revokeObjectURL(referenceObjectUrl);
            referenceObjectUrl = null;
        }
        currentReferenceFile = null;
        hasReferenceTrack = true;
        setKaraokeMode(true);

        audioPlayer.src = `${API_BASE}${result.instrumental}`;
        audioPlayer.load();
        guidePlayer.src = `${API_BASE}${result.vocals}`;
        guidePlayer.load();
        applyGuideLevel();

        fileNameDisplay.textContent = result.title || 'Karaoke track';
        fileNameDisplay.style.color = '#FFFFFF';
        audioPreviewContainer.classList.remove('hidden');
        if (makeKaraokeFromFileBtn) makeKaraokeFromFileBtn.classList.add('hidden');

        applyAnalysis(result);
        resetPitchPanel();
        unlockSessionVisuals();
    }

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
     * Process the uploaded audio file: update UI, preview player, and
     * unlock the live singing controls.
     */
    function processFile(file) {
        if (!file) return;
        if (isListening) stopMicrophone();

        hasReferenceTrack = true;
        currentReferenceFile = file;
        setKaraokeMode(false);
        if (makeKaraokeFromFileBtn) makeKaraokeFromFileBtn.classList.remove('hidden');

        // Update file name display
        fileNameDisplay.textContent = file.name;
        fileNameDisplay.style.color = '#FFFFFF';

        // Create object URL for the audio file and hook up the player
        if (referenceObjectUrl) URL.revokeObjectURL(referenceObjectUrl);
        referenceObjectUrl = URL.createObjectURL(file);
        audioPlayer.src = referenceObjectUrl;
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
        pitchTargetEl.textContent = '—';
        const targetNoteEl = pitchTargetEl.parentElement.querySelector('.pitch-note');
        if (targetNoteEl) targetNoteEl.textContent = 'From the song';
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

        // Show Practice Tools
        const practiceTools = document.getElementById('practiceTools');
        if (practiceTools) practiceTools.style.display = 'block';
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

        isStartingMic = true;
        const onHeadphones = headphonesToggle ? headphonesToggle.checked : true;
        try {
            // Singing needs the raw mic: browser noise suppression treats
            // sustained notes as noise and AGC pumps the level, which made
            // takes sound choppy/"buffering". Echo cancellation is only
            // useful on speakers (it also gates the voice while music plays).
            mediaStream = await navigator.mediaDevices.getUserMedia(singingMicConstraints(onHeadphones));

            ensureAudioContext();

            // Some browsers start AudioContext in a suspended state
            // and require an explicit resume() inside a user gesture.
            if (audioContext.state === 'suspended') {
                await audioContext.resume();
            }

            micSource = audioContext.createMediaStreamSource(mediaStream);
            analyser = audioContext.createAnalyser();
            analyser.fftSize = 2048;
            timeDomainData = new Float32Array(analyser.fftSize);

            // The mic goes to the analyser and the recording bus only, never
            // to audioContext.destination, so it is not played back through
            // the speakers.
            micSource.connect(analyser);

            // Route the players through the same AudioContext so their pitch
            // can be analysed and the backing track can be recorded.
            setupReferenceAnalyser();
            setupGuideGraph();

            isListening = true;
            pitchUserNoteEl.textContent = 'Listening...';
            startSingingBtn.textContent = 'Mic Active';
            startSingingBtn.classList.add('btn-recording');

            // Reset session score
            sessionScore = { total: 0, match: 0, near: 0, miss: 0 };

            startSessionRecording();

            if (audioPlayer) {
                // On speakers, turn the track down so it does not swamp the
                // mic. With headphones there is no bleed, so leave it alone.
                originalRefVolume = audioPlayer.volume;
                if (!onHeadphones) audioPlayer.volume = Math.max(0, originalRefVolume * 0.5);

                // Start (or resume) the song so the learner can just sing.
                if (audioPlayer.paused) {
                    if (audioPlayer.ended) audioPlayer.currentTime = 0;
                    audioPlayer.play().catch(() => { /* blocked by browser */ });
                }
            }

            updatePitchLoop();
        } catch (err) {
            console.error('Error accessing microphone:', err);
            alert('Unable to access microphone. Please check your permissions.');
        } finally {
            isStartingMic = false;
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
            const response = await fetch(`${API_BASE}/analyze`, {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                // If backend fails/is down, fallback or show error
                // For now, we'll just log it and maybe leave "..." or set to "--"
                throw new Error(`Server returned ${response.status}`);
            }

            applyAnalysis(await response.json());
        } catch (err) {
            console.error('Error analyzing reference audio with backend:', err);
            // Fallback UI update
            if (tempoValueEl) tempoValueEl.textContent = '--';
            if (chordValueEl) chordValueEl.textContent = '--';
            if (tempoSummaryEl) tempoSummaryEl.textContent = '--';
            if (chordSummaryEl) chordSummaryEl.textContent = '--';
        }
    }

    /** Show tempo / key / chord timeline returned by /analyze or /karaoke. */
    function applyAnalysis(data) {
        const tempoText = data && data.tempo ? `${data.tempo} BPM` : '--';
        const chordText = (data && data.key) || '--';
        currentChordSegments = data && Array.isArray(data.chords) ? data.chords : [];

        if (tempoValueEl) tempoValueEl.textContent = tempoText;
        if (chordValueEl) chordValueEl.textContent = chordText;
        if (tempoSummaryEl) tempoSummaryEl.textContent = tempoText;
        if (chordSummaryEl) chordSummaryEl.textContent = chordText;
        if (songAnalysisSection) songAnalysisSection.style.opacity = '1';
    }

    function ensureAudioContext() {
        if (!audioContext) {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            audioContext = new AudioContextClass();
        }
        return audioContext;
    }

    /**
     * Record a "take": the raw mic, plus the backing track if the user
     * wants it mixed in. Saved as WAV so it has a real duration, seeks
     * properly and opens in any player or DAW.
     */
    function startSessionRecording() {
        if (recordingPreview) recordingPreview.style.display = 'none'; // Hide previous
        recordedChunks = [];
        if (typeof MediaRecorder === 'undefined') return;

        try {
            recordDest = audioContext.createMediaStreamDestination();
            micSource.connect(recordDest);

            const mixBacking = mixBackingToggle ? mixBackingToggle.checked : true;
            if (mixBacking && referenceSource) {
                backingRecordGain = audioContext.createGain();
                backingRecordGain.gain.value = 0.6; // keep the voice on top
                referenceSource.connect(backingRecordGain);
                backingRecordGain.connect(recordDest);
            }

            mediaRecorder = new MediaRecorder(recordDest.stream);
            mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) recordedChunks.push(event.data);
            };
            mediaRecorder.onstop = () => finishSessionRecording(mediaRecorder.mimeType);
            // Timeslice so data is flushed regularly rather than all at the end.
            mediaRecorder.start(1000);
        } catch (e) {
            console.warn("MediaRecorder failed:", e);
            mediaRecorder = null;
        }
    }

    async function finishSessionRecording(mimeType) {
        if (backingRecordGain) {
            backingRecordGain.disconnect();
            backingRecordGain = null;
        }
        recordDest = null;
        if (recordedChunks.length === 0) return;

        const compressed = new Blob(recordedChunks, { type: mimeType || 'audio/webm' });
        const { blob: take, extension } = await recordingToWav(compressed, audioContext);

        if (sessionObjectUrl) URL.revokeObjectURL(sessionObjectUrl);
        sessionObjectUrl = URL.createObjectURL(take);
        if (sessionAudio) sessionAudio.src = sessionObjectUrl;
        if (downloadSessionBtn) {
            downloadSessionBtn.href = sessionObjectUrl;
            const dateStr = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
            downloadSessionBtn.download = `SA-Listen-Take-${dateStr}.${extension}`;
        }
        if (recordingPreview) recordingPreview.style.display = 'block';
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

        // Stop the recorder first so the last chunk still contains audio.
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
        }

        if (analyser) analyser.disconnect();
        if (micSource) {
            micSource.disconnect();
            micSource = null;
        }

        if (mediaStream) {
            mediaStream.getTracks().forEach(track => track.stop());
            mediaStream = null;
        }

        // Pause the song; Start Singing resumes it from the same spot.
        if (audioPlayer && !audioPlayer.paused) {
            audioPlayer.pause();
        }

        startSingingBtn.classList.remove('btn-recording');

        // Restore reference track volume
        if (audioPlayer) {
            audioPlayer.volume = originalRefVolume;
        }

        startSingingBtn.textContent = 'Start Singing';
        // Keep reference, but go back to a waiting UI
        resetPitchPanel();

        // The AudioContext stays alive so the players keep working
        // without recreating nodes.
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
        const trackPlaying = !audioPlayer.paused && !audioPlayer.ended;
        if (isKaraokeMode && guideAnalyser) {
            // Karaoke: the isolated original vocal is the target melody.
            if (trackPlaying && !guidePlayer.paused) {
                guideAnalyser.getFloatTimeDomainData(guideTimeDomainData);
                referenceFrequency = detectPitch(guideTimeDomainData, audioContext.sampleRate);
            }
        } else if (referenceAnalyser && referenceTimeDomainData && trackPlaying) {
            referenceAnalyser.getFloatTimeDomainData(referenceTimeDomainData);
            referenceFrequency = detectPitch(referenceTimeDomainData, audioContext.sampleRate);
        }

        // Always show the target note, so a learner can see (and hear) what
        // to sing before they start.
        const targetNoteEl = pitchTargetEl.parentElement.querySelector('.pitch-note');
        if (referenceFrequency) {
            pitchTargetEl.textContent = `${referenceFrequency.toFixed(1)} Hz`;
            if (targetNoteEl) targetNoteEl.textContent = frequencyToNoteName(referenceFrequency) || '';
        } else {
            pitchTargetEl.textContent = '—';
            if (targetNoteEl) targetNoteEl.textContent = trackPlaying ? 'Rest (no melody)' : 'Play the song';
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
            pitchUserNoteEl.textContent = frequencyToNoteName(pitch) || 'Live microphone';

            pitchStatusEl.classList.remove('status-match', 'status-near', 'status-waiting');

            if (referenceFrequency == null) {
                // Nothing to match right now (instrumental break or paused
                // track). Show the note but do not score the frame.
                pitchStatusEl.textContent = trackPlaying ? 'Rest' : 'Free singing';
                pitchStatusEl.classList.add('status-waiting');
            } else {
                // Octaves are folded out so a singer an octave above/below the
                // reference still matches (references also jump octaves).
                const centsDiff = pitchClassCentsOffset(pitch, referenceFrequency);
                const absCents = Math.abs(centsDiff);

                if (absCents <= 20) {
                    pitchStatusEl.textContent = 'Match';
                    pitchStatusEl.classList.add('status-match');
                    sessionScore.match++;
                } else if (absCents <= 50) {
                    const direction = centsDiff > 0 ? 'High' : 'Low';
                    pitchStatusEl.textContent = `Near (${direction})`;
                    pitchStatusEl.classList.add('status-near');
                    sessionScore.near++;
                } else {
                    // "Off" uses the default pill styling (no extra class)
                    pitchStatusEl.textContent = centsDiff > 0 ? 'Too High' : 'Too Low';
                    sessionScore.miss++;
                }
                sessionScore.total++;
            }

            pitchCardEl.classList.add('is-active');

            // Push a frame to the graph: both reference and user pitch
            addFrequenciesToGraph(referenceFrequency, pitch);
        }

        rafId = requestAnimationFrame(updatePitchLoop);
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
     * Route the guide vocal through Web Audio: an analyser (full level,
     * used as the pitch target) and a gain node for the "Guide vocal"
     * slider, so turning the guide down never weakens pitch detection.
     */
    function setupGuideGraph() {
        if (!audioContext || !guidePlayer || guideSource) return;
        try {
            guideSource = audioContext.createMediaElementSource(guidePlayer);
            guideAnalyser = audioContext.createAnalyser();
            guideAnalyser.fftSize = 2048;
            guideTimeDomainData = new Float32Array(guideAnalyser.fftSize);
            guideGain = audioContext.createGain();

            guideSource.connect(guideAnalyser);
            guideSource.connect(guideGain);
            guideGain.connect(audioContext.destination);

            guidePlayer.volume = 1; // level is now controlled by guideGain
            applyGuideLevel();
        } catch (err) {
            console.warn('Error setting up guide vocal graph:', err);
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

    function removeReferenceTrack() {
        // Never leave the mic running without a reference track.
        if (isListening) stopMicrophone();

        if (audioPlayer) {
            audioPlayer.pause();
            audioPlayer.removeAttribute('src');
            audioPlayer.load();
        }
        if (referenceObjectUrl) {
            URL.revokeObjectURL(referenceObjectUrl);
            referenceObjectUrl = null;
        }
        currentChordSegments = [];
        currentReferenceFile = null;
        setKaraokeMode(false);
        if (makeKaraokeFromFileBtn) makeKaraokeFromFileBtn.classList.remove('hidden');
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
        const canSing = hasReferenceTrack;
        if (startSingingBtn) startSingingBtn.disabled = !canSing;
        if (stopSingingBtn) stopSingingBtn.disabled = !canSing;
    }

    // --- NEON WAVE VISUALIZER ---
    const bgCanvas = document.getElementById('bgVisualizer');
    const bgCtx = bgCanvas ? bgCanvas.getContext('2d') : null;
    let visualizerRaf = null;

    function resizeCanvas() {
        if (!bgCanvas) return;
        bgCanvas.width = window.innerWidth;
        bgCanvas.height = window.innerHeight;
    }

    window.addEventListener('resize', resizeCanvas);
    resizeCanvas();

    function drawNeonWave() {
        if (!bgCtx || !bgCanvas) return;

        // Clear with transparent bg
        bgCtx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);

        // We'll use frequency data from referenceAnalyser if playing
        let dataArray;
        if (referenceAnalyser && !audioPlayer.paused) {
            const bufferLength = referenceAnalyser.frequencyBinCount;
            // Use a smaller buffer for visualizer to match the idle array size logic if needed, 
            // but analyser usually returns 1024 or 2048. We'll stick to what we have.
            dataArray = new Uint8Array(bufferLength);
            referenceAnalyser.getByteFrequencyData(dataArray);
        } else {
            // Idle animation data (slow, gentle sine wave simulation)
            // Create a fake frequency array
            const t = Date.now() / 3000; // Slower time base
            dataArray = new Uint8Array(256).map((_, i) => {
                // Generate a gentle rolling wave appearance
                // Base value + sine wave modulation
                const val = 20 + 15 * Math.sin(t * 1.5 + i * 0.05);
                return Math.max(0, val);
            });
        }

        const width = bgCanvas.width;
        const height = bgCanvas.height;
        const barWidth = (width / dataArray.length) * 2.5;
        let x = 0;

        // Draw multiple layered waves
        // Draw multiple layered waves - DARKER and more spread out
        bgCtx.lineWidth = 2; /* Thicker lines for visibility */
        bgCtx.lineCap = 'round';

        // Wave 1: Dark Blue/Teal (Reference)
        bgCtx.beginPath();
        bgCtx.strokeStyle = 'rgba(0, 100, 200, 0.6)';
        drawWavePath(dataArray, 0, height * 0.5, 1.2, 0); /* Center height */
        bgCtx.stroke();

        // Wave 2: Dark Magenta/Purple
        bgCtx.beginPath();
        bgCtx.strokeStyle = 'rgba(180, 0, 180, 0.5)';
        drawWavePath(dataArray, 50, height * 0.55, 1.0, 500);
        bgCtx.stroke();

        // Wave 3: Dark Green/Teal
        bgCtx.beginPath();
        bgCtx.strokeStyle = 'rgba(0, 150, 100, 0.5)';
        drawWavePath(dataArray, 100, height * 0.45, 0.8, 1000);
        bgCtx.stroke();

        visualizerRaf = requestAnimationFrame(drawNeonWave);
    }

    function drawWavePath(data, offsetIndex, basePath, scale, timeOffset) {
        // Mirrored Spectrum: Center is High freq, Sides are Low freq? 
        // Or Center Low, Sides High?
        // Let's do: Center = Active Lows/Mids, Sides = Tapering.
        // Actually, user wants "one end active, other end still" fixed.
        // Best approach: Double the active spectrum. Left half = 0..Limit, Right half = Limit..0 (Mirror)

        const dataLimit = Math.floor(data.length * 0.40); // Focus on first 40% (Bass/Mids/HighMids)
        // We will draw 2x this limit (Reflected)

        // We iterate pixels across width
        const width = bgCanvas.width;
        bgCtx.moveTo(0, basePath);

        const t = Date.now() / 2000;
        const totalPoints = 100; // Number of points to draw

        for (let i = 0; i <= totalPoints; i++) {
            const x = (i / totalPoints) * width;

            // Map x to frequency index
            // Symmetrical: 0 (Left) -> 1 (Center) -> 0 (Right)
            // Normalized 0..1..0
            let norm = i / totalPoints;
            // 0 -> 0.5 -> 1
            // We want frequency index to go 0 -> Max -> 0?
            // Or Max -> 0 -> Max?
            // Usually Bass in Center looks best. (Index 0 is Bass)
            // So Norm: 1 -> 0 -> 1 ? (High -> Low -> High) -> Edges are still
            // User complains "other end is still". That implies Highs are dead.
            // If we put Bass at edges, edges move.

            // Let's map linear 0 -> Limit -> 0.
            // But wait, if we want activity everywhere, just repeating the pattern might be better.
            // Let's try Bass at Edges (Active) and Treble in Center?

            // Let's do simple Mirror:
            // Left Half: data[0] ... data[limit]
            // Right Half: data[limit] ... data[0]

            let dataIndex;
            if (norm < 0.5) {
                // Left side: 0 -> Limit
                // norm 0..0.5 maps to 0..1
                dataIndex = Math.floor((norm * 2) * dataLimit);
            } else {
                // Right side: Limit -> 0
                // norm 0.5..1 maps to 1..0
                dataIndex = Math.floor(((1 - norm) * 2) * dataLimit);
            }

            const val = data[dataIndex] || 0;
            const v = val / 255.0;

            const magnitude = (val > 50) ? 150 : 50;
            const displacement = v * magnitude * scale;

            // wave travel
            const waveMotion = Math.sin(i * 0.1 + t + timeOffset) * 20;

            const y = basePath + waveMotion - displacement;

            if (i === 0) bgCtx.moveTo(x, y);
            else bgCtx.lineTo(x, y);
        }
        bgCtx.lineTo(width, basePath);
    }

    // Start visualizer
    drawNeonWave();

    // Floating Particles
    function createParticles() {
        const particleContainer = document.body;
        for (let i = 0; i < 30; i++) {
            const p = document.createElement('div');
            p.classList.add('floating-particle');
            const size = Math.random() * 80 + 20;
            p.style.width = `${size}px`;
            p.style.height = `${size}px`;
            p.style.left = `${Math.random() * 100}vw`;
            p.style.top = `${Math.random() * 100}vh`;
            p.style.animationDuration = `${Math.random() * 10 + 10}s`;
            p.style.animationDelay = `-${Math.random() * 20}s`;
            p.style.opacity = Math.random() * 0.1 + 0.02; // Very faint
            particleContainer.appendChild(p);
        }
    }
    createParticles();

    // --- Interactive Background Elements: Floating Notes on Click ---
    // --- Interactive Background Elements: Floating Notes on Click ---
    document.addEventListener('click', (e) => {
        const target = e.target;
        // stricter check: only ignore if inside a card or button/input
        const insideCard = target.closest('.card');
        const insideInteractive = target.closest('button') || target.tagName === 'INPUT' || target.tagName === 'A';

        // We allow clicking on .how-it-works now since it is transparent
        if (insideCard || insideInteractive) return;

        spawnMusicalNote(e.clientX, e.clientY);
    });

    function spawnMusicalNote(x, y) {
        const notes = ['♪', '♫', '♬', '♩', '♭', '♮', '♯', '𝄞'];
        const note = notes[Math.floor(Math.random() * notes.length)];

        const el = document.createElement('div');
        el.textContent = note;
        el.style.position = 'fixed';
        el.style.left = x + 'px';
        el.style.top = y + 'px';

        // Premium Brown Colors (SaddleBrown, Sienna, Bronze)
        // R: 100-160, G: 40-80, B: 20-50
        const r = Math.floor(100 + Math.random() * 60);
        const g = Math.floor(40 + Math.random() * 40);
        const b = Math.floor(20 + Math.random() * 30);
        el.style.color = `rgba(${r}, ${g}, ${b}, ${0.6 + Math.random() * 0.4})`;

        el.style.fontSize = `${1.5 + Math.random() * 2}rem`;
        el.style.fontWeight = 'bold';
        el.style.pointerEvents = 'none';
        el.style.zIndex = '9999'; /* Ensure it is on top of everything */
        el.style.userSelect = 'none';
        el.style.textShadow = '0 2px 4px rgba(255,255,255,0.2)'; /* Subtle light shadow for depth */

        // Initial state
        el.style.transform = `translate(-50%, -50%) scale(0.5) rotate(${Math.random() * 60 - 30}deg)`;
        el.style.transition = 'all 1.2s cubic-bezier(0.25, 0.46, 0.45, 0.94)';
        el.style.opacity = '1';

        document.body.appendChild(el);

        // Trigger animation
        requestAnimationFrame(() => {
            el.style.transform = `translate(-50%, -150px) scale(1.2) rotate(${Math.random() * 60 - 30}deg)`;
            el.style.opacity = '0';
        });

        // Cleanup
        setTimeout(() => {
            if (document.body.contains(el)) {
                document.body.removeChild(el);
            }
        }, 1200);
    }

});
