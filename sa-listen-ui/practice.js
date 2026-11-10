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

/*
 * Practice Studio (prototype): teachers publish exercises in their own
 * voice, students practise against a swara note lane with a Sa drone and
 * send takes back, teachers review with time-stamped comments.
 *
 * Depends on pitch.js (detectPitch, segmentNotes, scoreTake, ...) and
 * audio-utils.js (singingMicConstraints, recordingToWav).
 */
(() => {
    'use strict';

    const API = window.location.protocol.startsWith('http') ? '' : 'http://127.0.0.1:8000';
    const STORAGE_KEY = 'saListen.lastStudio';
    const ANALYSIS_RATE = 11025;   // melody analysis sample rate (Hz)
    const SING_LATENCY = 0.12;     // expected singer lag behind the guide (s)
    const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const KATTAI = ['1', '1½', '2', '2½', '3', '4', '4½', '5', '5½', '6', '6½', '7'];
    const LEVEL_LABEL = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced' };

    const $ = id => document.getElementById(id);

    // ------------------------------------------------------------------
    // Small utilities
    // ------------------------------------------------------------------

    /** Build DOM safely (user text always goes through textContent). */
    function el(tag, props = {}, ...children) {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(props)) {
            if (value == null || value === false) continue;
            if (key === 'class') node.className = value;
            else if (key === 'text') node.textContent = value;
            else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
            else node.setAttribute(key, value === true ? '' : value);
        }
        for (const child of children.flat()) {
            if (child != null) node.append(child instanceof Node ? child : String(child));
        }
        return node;
    }

    async function api(path, opts = {}) {
        const init = { ...opts };
        if (opts.json !== undefined) {
            init.method = init.method || 'POST';
            init.headers = { 'Content-Type': 'application/json' };
            init.body = JSON.stringify(opts.json);
            delete init.json;
        }
        let resp;
        try {
            resp = await fetch(API + path, init);
        } catch (e) {
            throw new Error('Could not reach the SA Listen server. Is it running (python backend/main.py)?');
        }
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
            let detail = data.detail;
            if (Array.isArray(detail)) detail = detail.map(d => d.msg).join('; ');
            throw new Error(detail || `Request failed (${resp.status})`);
        }
        return data;
    }

    let flashTimer = null;
    function flash(message, ok = false) {
        const box = $('flash');
        box.textContent = message;
        box.classList.toggle('ok', ok);
        box.classList.remove('hidden');
        clearTimeout(flashTimer);
        flashTimer = setTimeout(() => box.classList.add('hidden'), ok ? 5000 : 9000);
        box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    function fmtTime(sec) {
        if (!isFinite(sec) || sec < 0) sec = 0;
        return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
    }

    function timeAgo(ts) {
        if (!ts) return 'never';
        const s = Date.now() / 1000 - ts;
        if (s < 60) return 'just now';
        if (s < 3600) return `${Math.floor(s / 60)} min ago`;
        if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
        return `${Math.floor(s / 86400)} d ago`;
    }

    function scoreChip(score) {
        if (score == null) return el('span', { class: 'chip', text: 'no score' });
        const cls = score >= 80 ? 'good' : score >= 50 ? 'mid' : 'low';
        return el('span', { class: `chip ${cls}`, text: `${score}%` });
    }

    function saLabel(hz) {
        const midi = Math.round(69 + 12 * Math.log2(hz / 440));
        const name = NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
        const cents = Math.round((69 + 12 * Math.log2(hz / 440) - midi) * 100);
        const exact = Math.abs(cents) > 8 ? ` (${hz.toFixed(1)} Hz)` : '';
        return `${name} · kattai ${KATTAI[((midi % 12) + 12) % 12]}${exact}`;
    }

    function remember(kind, token, label) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ kind, token, label })); } catch (e) { /* private mode */ }
    }

    function recalled() {
        try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (e) { return null; }
    }

    let audioContext = null;
    function audioCtx() {
        if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
        if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
        return audioContext;
    }

    // ------------------------------------------------------------------
    // Sa drone (tanpura-like: mandra Pa, Sa, Sa, mandra Sa)
    // ------------------------------------------------------------------

    function createDrone(ctx, saHz) {
        const out = ctx.createGain();
        out.gain.value = 0;
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 1400;
        filter.connect(out);
        out.connect(ctx.destination);

        const voices = [
            { f: saHz * 0.75, g: 0.22, lfo: 0.21 },
            { f: saHz, g: 0.25, lfo: 0.33, detune: -3 },
            { f: saHz, g: 0.2, lfo: 0.27, detune: 3 },
            { f: saHz * 0.5, g: 0.3, lfo: 0.17 },
        ];
        const nodes = voices.map(v => {
            const osc = ctx.createOscillator();
            osc.type = 'sawtooth';
            osc.frequency.value = v.f;
            osc.detune.value = v.detune || 0;
            const gain = ctx.createGain();
            gain.gain.value = v.g;
            // Slow swell on each string so it breathes like a tanpura.
            const lfo = ctx.createOscillator();
            lfo.frequency.value = v.lfo;
            const depth = ctx.createGain();
            depth.gain.value = v.g * 0.5;
            lfo.connect(depth);
            depth.connect(gain.gain);
            osc.connect(gain);
            gain.connect(filter);
            osc.start();
            lfo.start();
            return [osc, lfo];
        });

        let level = 0.35;
        return {
            setLevel(v) {
                level = v;
                out.gain.setTargetAtTime(v * 0.12, ctx.currentTime, 0.05);
            },
            start() { out.gain.setTargetAtTime(level * 0.12, ctx.currentTime, 0.2); },
            stop() {
                out.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
                setTimeout(() => {
                    nodes.flat().forEach(n => { try { n.stop(); } catch (e) { /* already stopped */ } });
                    out.disconnect();
                }, 600);
            },
        };
    }

    // ------------------------------------------------------------------
    // Melody analysis of the guide (teacher's voice)
    // ------------------------------------------------------------------

    const melodyCache = new Map();

    async function analyzeMelody(url, saHz, onProgress) {
        const key = `${url}|${saHz}`;
        if (melodyCache.has(key)) return melodyCache.get(key);

        const resp = await fetch(API + url);
        if (!resp.ok) throw new Error('Could not load the exercise audio.');
        const decoded = await audioCtx().decodeAudioData(await resp.arrayBuffer());

        // Resample to mono 11 kHz: ~10x faster pitch tracking, same accuracy for voices.
        const length = Math.max(1, Math.ceil(decoded.duration * ANALYSIS_RATE));
        const offline = new OfflineAudioContext(1, length, ANALYSIS_RATE);
        const src = offline.createBufferSource();
        src.buffer = decoded;
        src.connect(offline.destination);
        src.start();
        const samples = (await offline.startRendering()).getChannelData(0);

        // Same as pitchContour(), but yields to keep the page responsive.
        const frameSize = 1024, hop = 128;
        const frame = new Float32Array(frameSize);
        const contour = [];
        const totalFrames = Math.max(1, Math.floor((samples.length - frameSize) / hop));
        for (let i = 0, start = 0; start + frameSize <= samples.length; i++, start += hop) {
            frame.set(samples.subarray(start, start + frameSize));
            contour.push({ t: (start + frameSize / 2) / ANALYSIS_RATE, f: detectPitch(frame, ANALYSIS_RATE) });
            if (i % 400 === 0) {
                onProgress && onProgress(Math.round(100 * i / totalFrames));
                await new Promise(r => setTimeout(r, 0));
            }
        }
        const result = { notes: segmentNotes(contour, saHz), duration: decoded.duration };
        melodyCache.set(key, result);
        return result;
    }

    // ------------------------------------------------------------------
    // Note lane (shared by practice and review)
    // ------------------------------------------------------------------

    function laneRange(notes) {
        if (!notes.length) return [-3, 14];
        let lo = Math.min(...notes.map(n => n.semitone)) - 2;
        let hi = Math.max(...notes.map(n => n.semitone)) + 2;
        while (hi - lo < 10) { lo--; hi++; }
        return [lo, hi];
    }

    function targetSemitoneAt(notes, t) {
        let lo = 0, hi = notes.length - 1, idx = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (notes[mid].start <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
        }
        const cand = notes[idx], next = notes[idx + 1];
        if (!cand) return next ? next.semitone : 0;
        if (next && t > cand.end && next.start - t < t - cand.end) return next.semitone;
        return cand.semitone;
    }

    const RESULT_COLORS = { hit: '#10B981', near: '#F59E0B', missed: '#EF4444', silent: '#4B5563' };

    function drawLane(canvas, { notes, frames, playhead, saHz, range, past = 2.5, future = 5, fullTrace = false }) {
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth, h = canvas.clientHeight;
        if (!w || !h) return;
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(h * dpr);
        }
        const g = canvas.getContext('2d');
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, w, h);

        const labelW = 34;
        const t0 = playhead - past, t1 = playhead + future;
        const x = t => labelW + ((t - t0) / (t1 - t0)) * (w - labelW);
        const [lo, hi] = range;
        const rowH = h / (hi - lo + 1);
        const y = s => h - (s - lo + 0.5) * rowH;

        // Swara rows
        g.font = '600 11px Inter, sans-serif';
        g.textBaseline = 'middle';
        for (let s = lo; s <= hi; s++) {
            const pc = ((s % 12) + 12) % 12;
            const octave = Math.floor(s / 12);
            const strong = pc === 0 || pc === 7;
            g.fillStyle = strong ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.025)';
            g.fillRect(labelW, y(s) - 0.5, w - labelW, 1);
            g.fillStyle = strong ? '#E5E7EB' : '#6B7280';
            const dots = octave < 0 ? '̣'.repeat(-octave) : '̇'.repeat(octave);
            g.fillText(SWARA_SHORT[pc] + dots, 8, y(s));
        }

        // Target notes
        for (const n of notes) {
            if (n.end < t0 || n.start > t1) continue;
            const active = n.start <= playhead && playhead <= n.end;
            g.fillStyle = n.result ? RESULT_COLORS[n.result] : active ? '#60A5FA' : 'rgba(59,130,246,0.55)';
            const x0 = Math.max(labelW, x(n.start)), x1 = x(n.end);
            if (x1 <= x0) continue;
            const barH = Math.max(6, rowH * 0.7);
            g.beginPath();
            if (g.roundRect) g.roundRect(x0, y(n.semitone) - barH / 2, x1 - x0, barH, 4);
            else g.rect(x0, y(n.semitone) - barH / 2, x1 - x0, barH);
            g.fill();
            if (x1 - x0 > 22) {
                g.fillStyle = '#0A0A0A';
                g.fillText(n.label, x0 + 6, y(n.semitone));
            }
        }

        // Singer's pitch, folded into the target's octave
        if (frames && frames.length) {
            g.strokeStyle = '#93C5FD';
            g.lineWidth = 2.5;
            g.lineJoin = 'round';
            g.beginPath();
            let penDown = false, lastT = -1;
            for (const p of frames) {
                // Live practice only has the past; a recorded take can show it all.
                if (p.t < t0 || p.t > (fullTrace ? t1 : playhead + 0.05)) continue;
                if (!p.f || p.t - lastT > 0.15) { penDown = false; }
                lastT = p.t;
                if (!p.f) continue;
                const s = 12 * Math.log2(p.f / saHz);
                const target = notes.length ? targetSemitoneAt(notes, p.t - SING_LATENCY) : Math.round(s);
                const folded = s - 12 * Math.round((s - target) / 12);
                const py = Math.min(h - 2, Math.max(2, y(folded)));
                if (penDown) g.lineTo(x(p.t), py); else g.moveTo(x(p.t), py);
                penDown = true;
            }
            g.stroke();
        }

        // Playhead
        g.fillStyle = 'rgba(255,255,255,0.8)';
        g.fillRect(x(playhead) - 1, 0, 2, h);
    }

    // ------------------------------------------------------------------
    // Routing
    // ------------------------------------------------------------------

    function showView(id) {
        for (const v of ['landingView', 'teacherView', 'studentView']) $(v).classList.toggle('hidden', v !== id);
    }

    function route() {
        const params = new URLSearchParams(window.location.hash.slice(1));
        closePractice();
        if (params.get('teacher')) loadTeacher(params.get('teacher'));
        else if (params.get('student')) loadStudent(params.get('student'));
        else showLanding(params.get('join'));
    }

    window.addEventListener('hashchange', route);

    // ------------------------------------------------------------------
    // Landing
    // ------------------------------------------------------------------

    function showLanding(joinCode) {
        showView('landingView');
        if (joinCode) $('joinStudioForm').join_code.value = joinCode;
        const last = recalled();
        $('resumeBox').classList.toggle('hidden', !last);
        if (last) {
            $('resumeText').textContent = last.kind === 'teacher'
                ? `You're the teacher of ${last.label}.` : `You're a student in ${last.label}.`;
            $('resumeLink').href = `#${last.kind}=${encodeURIComponent(last.token)}`;
        }
    }

    $('createStudioForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        try {
            const res = await api('/api/studios', { json: { name: form.name.value, teacher_name: form.teacher_name.value } });
            window.location.hash = `teacher=${encodeURIComponent(res.teacher_token)}`;
            flash('Studio created. Bookmark this page: its link is your key to the studio.', true);
        } catch (err) { flash(err.message); }
    });

    $('joinStudioForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        try {
            const res = await api('/api/join', { json: { join_code: form.join_code.value, name: form.name.value } });
            window.location.hash = `student=${encodeURIComponent(res.student_token)}`;
            flash(`Welcome to ${res.studio_name}! Bookmark this page: its link is your personal key.`, true);
        } catch (err) { flash(err.message); }
    });

    // ------------------------------------------------------------------
    // Teacher
    // ------------------------------------------------------------------

    let teacherToken = null;
    let teacherPoll = null;

    async function loadTeacher(token) {
        teacherToken = token;
        clearTimeout(teacherPoll);
        let data;
        try {
            data = await api(`/api/teacher/${encodeURIComponent(token)}`);
        } catch (err) {
            showLanding();
            flash(err.message);
            return;
        }
        showView('teacherView');
        remember('teacher', token, data.studio.name);
        renderTeacher(data);
        if (data.assignments.some(a => a.status === 'processing')) {
            teacherPoll = setTimeout(() => {
                if (teacherToken === token && !$('teacherView').classList.contains('hidden')) loadTeacher(token);
            }, 4000);
        }
    }

    function renderTeacher(data) {
        $('tStudioName').textContent = data.studio.name;
        $('tJoinCode').textContent = data.studio.join_code;
        $('copyInviteBtn').dataset.code = data.studio.join_code;

        // Students
        const tbody = $('tStudents');
        tbody.replaceChildren(...data.students.map(s => {
            const inactive = !s.last_active || Date.now() / 1000 - s.last_active > 3 * 86400;
            return el('tr', {},
                el('td', { text: s.name }),
                el('td', { text: s.week.takes }),
                el('td', { text: s.week.minutes }),
                el('td', { text: s.week.avg_score == null ? '–' : `${s.week.avg_score}%` }),
                el('td', { class: inactive ? 'inactive' : null, text: timeAgo(s.last_active) }));
        }));
        $('tStudentsEmpty').classList.toggle('hidden', data.students.length > 0);

        // Assignments
        $('tAssignments').replaceChildren(...data.assignments.map(a => {
            const status = a.status === 'ready' ? el('span', { class: 'chip good', text: 'Live' })
                : a.status === 'processing' ? el('span', { class: 'chip info', text: 'Separating vocals…' })
                    : el('span', { class: 'chip low', text: 'Failed', title: a.error || '' });
            return el('li', { class: 'item' },
                el('div', { class: 'item-main' },
                    el('div', { class: 'item-title', text: a.title }),
                    el('div', { class: 'item-sub', text: `${LEVEL_LABEL[a.level]} · Sa ${saLabel(a.sa_hz)}${a.backing_url ? ' · with music' : ''}${a.status === 'error' && a.error ? ` · ${a.error}` : ''}` })),
                status,
                el('button', {
                    class: 'btn btn-ghost btn-sm btn-remove', type: 'button', title: 'Delete exercise and its takes',
                    text: 'Delete', onclick: () => deleteAssignment(a),
                }));
        }));
        $('tAssignmentsEmpty').classList.toggle('hidden', data.assignments.length > 0);

        // Takes
        $('tTakes').replaceChildren(...data.takes.map(t => el('li', {
            class: 'item clickable', tabindex: '0', role: 'button',
            onclick: () => openReview(t.id),
            onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openReview(t.id); } },
        },
        el('div', { class: 'item-main' },
            el('div', { class: 'item-title', text: `${t.student_name} · ${t.assignment_title}` }),
            el('div', { class: 'item-sub', text: `${timeAgo(t.created)} · ${fmtTime(t.duration)} · ${t.comments.length ? `${t.comments.length} comment${t.comments.length > 1 ? 's' : ''}` : 'not reviewed'}` })),
        scoreChip(t.score))));
        $('tTakesEmpty').classList.toggle('hidden', data.takes.length > 0);
    }

    async function deleteAssignment(a) {
        if (!window.confirm(`Delete "${a.title}" and all students' takes for it? This can't be undone.`)) return;
        try {
            await api(`/api/teacher/${encodeURIComponent(teacherToken)}/assignments/${a.id}`, { method: 'DELETE' });
            loadTeacher(teacherToken);
        } catch (err) { flash(err.message); }
    }

    $('copyInviteBtn').addEventListener('click', async () => {
        const code = $('copyInviteBtn').dataset.code;
        const link = `${window.location.origin}${window.location.pathname}#join=${code}`;
        try {
            await navigator.clipboard.writeText(link);
            flash('Invite link copied. Send it to your students.', true);
        } catch (e) {
            window.prompt('Copy this invite link:', link);
        }
    });

    // --- Sa picker ---------------------------------------------------

    function fillSaSelect(select) {
        select.replaceChildren();
        for (let midi = 43; midi <= 64; midi++) { // G2 .. E4
            const hz = 440 * Math.pow(2, (midi - 69) / 12);
            select.append(el('option', { value: hz.toFixed(2), text: `${saLabel(hz)} · ${hz.toFixed(1)} Hz` }));
        }
        select.value = (440 * Math.pow(2, (49 - 69) / 12)).toFixed(2); // C#3, a common male Sa
    }
    fillSaSelect($('saSelect'));

    async function listenForPitch(seconds) {
        const stream = await navigator.mediaDevices.getUserMedia(singingMicConstraints(true));
        const ctx = audioCtx();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        source.connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        const pitches = [];
        await new Promise(resolve => {
            const timer = setInterval(() => {
                analyser.getFloatTimeDomainData(buf);
                const f = detectPitch(buf, ctx.sampleRate);
                if (f) pitches.push(f);
            }, 30);
            setTimeout(() => { clearInterval(timer); resolve(); }, seconds * 1000);
        });
        source.disconnect();
        stream.getTracks().forEach(t => t.stop());
        return pitches;
    }

    $('detectSaBtn').addEventListener('click', async () => {
        const btn = $('detectSaBtn');
        btn.disabled = true;
        btn.textContent = '🎙 Sing Sa…';
        try {
            const pitches = await listenForPitch(3);
            if (pitches.length < 20) throw new Error("Didn't hear a steady note. Sing or play your Sa for the whole 3 seconds.");
            pitches.sort((a, b) => a - b);
            const hz = pitches[Math.floor(pitches.length / 2)];
            const select = $('saSelect');
            const option = el('option', { value: hz.toFixed(2), text: `Detected: ${saLabel(hz)} · ${hz.toFixed(1)} Hz` });
            select.prepend(option);
            select.value = option.value;
            flash(`Sa set to ${hz.toFixed(1)} Hz.`, true);
        } catch (err) {
            flash(err.name === 'NotAllowedError' ? 'Microphone permission is needed to detect Sa.' : err.message);
        } finally {
            btn.disabled = false;
            btn.textContent = '🎙 Detect';
        }
    });

    // --- Exercise source: record or upload -------------------------------

    let activeSource = 'record';
    let recordedGuide = null;
    let guideRecording = null;

    document.querySelectorAll('.source-tabs .tab').forEach(tab => {
        tab.addEventListener('click', () => {
            activeSource = tab.dataset.source;
            document.querySelectorAll('.source-tabs .tab').forEach(t => t.classList.toggle('active', t === tab));
            $('recordPanel').classList.toggle('hidden', activeSource !== 'record');
            $('uploadPanel').classList.toggle('hidden', activeSource !== 'upload');
        });
    });

    $('recordGuideBtn').addEventListener('click', async () => {
        const btn = $('recordGuideBtn');
        if (guideRecording) {
            guideRecording.recorder.stop();
            return;
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia(singingMicConstraints(true));
            const ctx = audioCtx();
            const recorder = new MediaRecorder(stream);
            const chunks = [];
            const drone = $('recordDroneToggle').checked ? createDrone(ctx, parseFloat($('saSelect').value)) : null;
            if (drone) { drone.setLevel(0.35); drone.start(); }
            const started = Date.now();
            const timer = setInterval(() => { btn.textContent = `■ Stop (${fmtTime((Date.now() - started) / 1000)})`; }, 250);

            recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
            recorder.onstop = async () => {
                clearInterval(timer);
                stream.getTracks().forEach(t => t.stop());
                if (drone) drone.stop();
                guideRecording = null;
                btn.classList.remove('recording');
                btn.textContent = '● Record again';
                const wav = await recordingToWav(new Blob(chunks, { type: recorder.mimeType }), ctx);
                recordedGuide = wav;
                const preview = $('recordPreview');
                if (preview.src) URL.revokeObjectURL(preview.src);
                preview.src = URL.createObjectURL(wav.blob);
                preview.classList.remove('hidden');
            };
            recorder.start(1000);
            guideRecording = { recorder };
            btn.classList.add('recording');
            btn.textContent = '■ Stop (0:00)';
        } catch (err) {
            flash(err.name === 'NotAllowedError' ? 'Microphone permission is needed to record.' : err.message);
        }
    });

    $('assignmentForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        let file;
        if (activeSource === 'record') {
            if (guideRecording) { flash('Stop the recording first.'); return; }
            if (!recordedGuide) { flash('Record the exercise first (or switch to Upload file).'); return; }
            file = new File([recordedGuide.blob], `guide.${recordedGuide.extension}`, { type: recordedGuide.blob.type });
        } else {
            file = $('guideFile').files[0];
            if (!file) { flash('Choose an audio file to upload.'); return; }
        }

        const fd = new FormData();
        fd.append('title', form.title.value);
        fd.append('notes', form.notes.value);
        fd.append('sa_hz', $('saSelect').value);
        fd.append('level', form.level.value);
        fd.append('full_song', activeSource === 'upload' && $('fullSongToggle').checked ? 'true' : 'false');
        fd.append('audio', file);

        const btn = $('createAssignmentBtn');
        btn.disabled = true;
        btn.textContent = 'Publishing…';
        try {
            const a = await api(`/api/teacher/${encodeURIComponent(teacherToken)}/assignments`, { method: 'POST', body: fd });
            flash(a.status === 'processing'
                ? 'Published. Separating the vocals now; it goes live for students when done.'
                : 'Exercise published. Your students can practise it now.', true);
            form.reset();
            fillSaSelect($('saSelect'));
            recordedGuide = null;
            $('recordPreview').classList.add('hidden');
            $('recordGuideBtn').textContent = '● Record';
            loadTeacher(teacherToken);
        } catch (err) {
            flash(err.message);
        } finally {
            btn.disabled = false;
            btn.textContent = 'Publish exercise';
        }
    });

    // --- Review ----------------------------------------------------------

    let review = null;

    async function openReview(takeId) {
        let take;
        try {
            take = await api(`/api/teacher/${encodeURIComponent(teacherToken)}/takes/${takeId}`);
        } catch (err) { flash(err.message); return; }

        const summary = take.summary || {};
        const notes = (summary.notes || []).map(n => ({ ...n }));
        const frames = (take.frames || []).map(([t, f]) => ({ t, f: f || null }));
        review = {
            take, notes, frames,
            speed: summary.speed || 1,
            saHz: summary.sa_hz || 220,
            range: laneRange(notes),
        };

        $('rTitle').textContent = summary.title || 'Take';
        $('rMeta').textContent = `${take.student_name} · ${timeAgo(take.created)} · ${fmtTime(take.duration)}`
            + `${take.score != null ? ` · ${take.score}%` : ''}${review.speed !== 1 ? ` · practised at ${review.speed}×` : ''}`;
        renderTips($('rTips'), summary);
        renderComments();
        const audio = $('rAudio');
        audio.src = API + take.audio_url;
        $('reviewPanel').classList.remove('hidden');
        $('reviewPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
        requestAnimationFrame(drawReview);
    }

    function drawReview() {
        if (!review || $('reviewPanel').classList.contains('hidden')) return;
        const audio = $('rAudio');
        // Take time is wall-clock; note times are media time (scaled by practice speed).
        const playhead = audio.currentTime * review.speed;
        drawLane($('reviewLane'), { ...review, playhead, past: 3, future: 5, fullTrace: true });
        $('commentBtn').textContent = `Comment at ${fmtTime(audio.currentTime)}`;
        if (!audio.paused) requestAnimationFrame(drawReview);
    }

    ['play', 'seeked', 'timeupdate', 'loadedmetadata'].forEach(ev => $('rAudio').addEventListener(ev, () => requestAnimationFrame(drawReview)));
    window.addEventListener('resize', () => { requestAnimationFrame(drawReview); });

    function renderComments() {
        $('rComments').replaceChildren(...review.take.comments.map(c => el('li', {},
            el('button', {
                class: 'time-link', type: 'button', text: fmtTime(c.time_sec),
                onclick: () => { $('rAudio').currentTime = c.time_sec; $('rAudio').play().catch(() => {}); },
            }),
            el('span', { text: c.text }))));
    }

    $('commentForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!review) return;
        const input = e.currentTarget.text;
        try {
            review.take.comments = await api(
                `/api/teacher/${encodeURIComponent(teacherToken)}/takes/${review.take.id}/comments`,
                { json: { time_sec: $('rAudio').currentTime, text: input.value } });
            input.value = '';
            renderComments();
            loadTeacher(teacherToken);
        } catch (err) { flash(err.message); }
    });

    $('closeReviewBtn').addEventListener('click', () => {
        $('rAudio').pause();
        $('reviewPanel').classList.add('hidden');
        review = null;
    });

    function renderTips(container, summary) {
        const tips = summary.tips || [];
        if (!summary.total) {
            container.replaceChildren(el('p', { text: 'No melody was scored for this take.' }));
        } else if (tips.length) {
            container.replaceChildren(...tips.map(t => el('p', { text: `• ${t.text}` })));
        } else {
            container.replaceChildren(el('p', {
                text: summary.score >= 80 ? '• Clean pass. Every swara was mostly on pitch.' : '• No single swara stands out. Work on holding each note steady.',
            }));
        }
    }

    // ------------------------------------------------------------------
    // Student
    // ------------------------------------------------------------------

    let studentToken = null;
    let studentData = null;

    async function loadStudent(token) {
        studentToken = token;
        try {
            studentData = await api(`/api/student/${encodeURIComponent(token)}`);
        } catch (err) {
            showLanding();
            flash(err.message);
            return;
        }
        showView('studentView');
        remember('student', token, studentData.studio.name);
        renderStudent();
    }

    function renderStudent() {
        const d = studentData;
        $('sGreeting').textContent = `Hello, ${d.student.name}`;
        $('sStudio').textContent = `${d.studio.name} · teacher ${d.studio.teacher_name}`;

        const takesBy = {};
        for (const t of d.takes) (takesBy[t.assignment_id] = takesBy[t.assignment_id] || []).push(t);

        const ready = d.assignments.filter(a => a.status === 'ready');
        $('sAssignments').replaceChildren(...ready.map(a => {
            const mine = takesBy[a.id] || [];
            const best = mine.length ? Math.max(...mine.map(t => t.score ?? 0)) : null;
            const feedback = mine.reduce((n, t) => n + t.comments.length, 0);
            return el('li', {
                class: 'item clickable', tabindex: '0', role: 'button',
                onclick: () => openPractice(a),
                onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPractice(a); } },
            },
            el('div', { class: 'item-main' },
                el('div', { class: 'item-title', text: a.title }),
                el('div', { class: 'item-sub', text: `${LEVEL_LABEL[a.level]} · Sa ${saLabel(a.sa_hz)} · ${mine.length} take${mine.length === 1 ? '' : 's'} sent` })),
            feedback ? el('span', { class: 'chip info', text: `💬 ${feedback}` }) : null,
            best != null ? scoreChip(best) : el('span', { class: 'chip', text: 'New' }));
        }));
        $('sAssignmentsEmpty').classList.toggle('hidden', ready.length > 0);

        const titles = Object.fromEntries(d.assignments.map(a => [a.id, a.title]));
        $('sTakes').replaceChildren(...d.takes.map(t => el('li', { class: 'item' },
            el('div', { class: 'item-main' },
                el('div', { class: 'item-title', text: titles[t.assignment_id] || 'Exercise' }),
                el('div', { class: 'item-sub', text: `${timeAgo(t.created)} · ${fmtTime(t.duration)}` }),
                t.comments.length ? el('ul', { class: 'item-comments' },
                    t.comments.map(c => el('li', { text: `${fmtTime(c.time_sec)}: ${c.text}` }))) : null,
                el('audio', { controls: true, preload: 'none', src: API + t.audio_url, class: 'full-width' })),
            scoreChip(t.score))));
        $('sTakesEmpty').classList.toggle('hidden', d.takes.length > 0);
    }

    // --- Practice session ----------------------------------------------

    let P = null; // current practice state

    function makeAudio(url) {
        const a = new Audio();
        a.crossOrigin = 'anonymous';
        a.preload = 'auto';
        a.src = API + url;
        return a;
    }

    async function openPractice(assignment) {
        closePractice();
        P = {
            assignment,
            saHz: assignment.sa_hz,
            tolerance: assignment.tolerance,
            notes: [],
            range: laneRange([]),
            frames: [],
            guide: makeAudio(assignment.guide_url),
            backing: assignment.backing_url ? makeAudio(assignment.backing_url) : null,
            running: false,
            take: null,
            result: null,
        };
        const panel = $('practicePanel');
        panel.classList.remove('hidden');
        $('pTitle').textContent = assignment.title;
        $('pNotes').textContent = assignment.notes || '';
        $('pLevel').textContent = `${LEVEL_LABEL[assignment.level]} · ±${assignment.tolerance}¢ counts as on the note`;
        $('pSa').textContent = saLabel(assignment.sa_hz);
        $('backingVolRow').classList.toggle('hidden', !P.backing);
        $('pResults').classList.add('hidden');
        $('startPracticeBtn').disabled = true;
        $('stopPracticeBtn').disabled = true;
        $('pTarget').textContent = '—';
        $('pYou').textContent = '—';
        $('pCents').textContent = '';
        const overlay = $('laneOverlay');
        overlay.classList.remove('hidden');
        overlay.textContent = 'Loading the melody…';
        panel.scrollIntoView({ behavior: 'smooth', block: 'start' });

        const mine = P;
        try {
            const melody = await analyzeMelody(assignment.guide_url, assignment.sa_hz,
                pct => { if (P === mine) overlay.textContent = `Reading your teacher's melody… ${pct}%`; });
            if (P !== mine) return;
            P.notes = melody.notes;
            P.range = laneRange(P.notes);
            if (P.notes.length) overlay.classList.add('hidden');
            else overlay.textContent = "Couldn't find a clear melody in this recording. You can still practise, but it won't be scored.";
            $('startPracticeBtn').disabled = false;
            drawLane($('practiceLane'), { notes: P.notes, frames: [], playhead: 0, saHz: P.saHz, range: P.range });
        } catch (err) {
            if (P === mine) overlay.textContent = err.message;
        }
    }

    function closePractice() {
        if (!P) return;
        if (P.running) stopPractice(false);
        P.guide.pause();
        if (P.backing) P.backing.pause();
        if (P.drone) P.drone.stop();
        P = null;
        $('practicePanel').classList.add('hidden');
    }

    $('closePracticeBtn').addEventListener('click', closePractice);

    function connectPlayers() {
        const ctx = audioCtx();
        if (!P.guideGain) {
            P.guideGain = ctx.createGain();
            ctx.createMediaElementSource(P.guide).connect(P.guideGain);
            P.guideGain.connect(ctx.destination);
        }
        if (P.backing && !P.backingGain) {
            P.backingGain = ctx.createGain();
            ctx.createMediaElementSource(P.backing).connect(P.backingGain);
            P.backingGain.connect(ctx.destination);
        }
        applyMixer();
    }

    function applyMixer() {
        if (!P) return;
        if (P.guideGain) P.guideGain.gain.value = $('guideVol').value / 100;
        if (P.backingGain) P.backingGain.gain.value = $('backingVol').value / 100;
        if (P.drone) P.drone.setLevel($('droneVol').value / 100);
    }

    ['guideVol', 'backingVol', 'droneVol'].forEach(id => $(id).addEventListener('input', applyMixer));

    $('pSpeed').addEventListener('change', () => {
        if (!P) return;
        const rate = parseFloat($('pSpeed').value);
        P.guide.playbackRate = rate;
        if (P.backing) P.backing.playbackRate = rate;
    });

    async function countIn() {
        const box = $('countdown');
        box.classList.remove('hidden');
        for (const n of ['3', '2', '1']) {
            box.textContent = n;
            await new Promise(r => setTimeout(r, 800));
        }
        box.classList.add('hidden');
    }

    $('startPracticeBtn').addEventListener('click', async () => {
        if (!P || P.running) return;
        const ctx = audioCtx();
        try {
            await ctx.resume();
            P.mic = { stream: await navigator.mediaDevices.getUserMedia(singingMicConstraints(true)) };
        } catch (err) {
            flash(err.name === 'NotAllowedError' ? 'Microphone permission is needed to practise.' : err.message);
            return;
        }
        P.mic.source = ctx.createMediaStreamSource(P.mic.stream);
        P.mic.analyser = ctx.createAnalyser();
        P.mic.analyser.fftSize = 2048;
        P.mic.buf = new Float32Array(P.mic.analyser.fftSize);
        P.mic.source.connect(P.mic.analyser);

        connectPlayers();
        if (P.drone) P.drone.stop();
        P.drone = createDrone(ctx, P.saHz);
        applyMixer();
        P.drone.start();

        $('startPracticeBtn').disabled = true;
        $('stopPracticeBtn').disabled = false;
        $('pResults').classList.add('hidden');
        P.running = true;
        P.frames = [];
        P.display = null;

        await countIn(); // the drone gives the learner their Sa first
        if (!P || !P.running) return;

        // Record the mic only: the teacher wants to hear the student clearly.
        P.chunks = [];
        P.recorder = new MediaRecorder(P.mic.stream);
        P.recorder.ondataavailable = e => { if (e.data.size) P.chunks.push(e.data); };
        P.recorder.start(1000);
        P.startedAt = performance.now();

        const rate = parseFloat($('pSpeed').value);
        for (const a of [P.guide, P.backing]) {
            if (!a) continue;
            a.currentTime = 0;
            a.playbackRate = rate;
            a.play().catch(() => {});
        }
        P.guide.onended = () => { if (P && P.running) stopPractice(true); };
        practiceLoop();
    });

    $('stopPracticeBtn').addEventListener('click', () => { if (P && P.running) stopPractice(true); });

    function practiceLoop() {
        if (!P || !P.running) return;
        const ctx = audioCtx();
        const t = P.guide.currentTime;

        P.mic.analyser.getFloatTimeDomainData(P.mic.buf);
        const f = detectPitch(P.mic.buf, ctx.sampleRate);
        P.frames.push({ t, f });

        // Keep the backing track locked to the guide.
        if (P.backing && !P.backing.paused && Math.abs(P.backing.currentTime - t) > 0.12) P.backing.currentTime = t;

        // "Sing" box: current note, or the next one coming up
        const current = P.notes.find(n => n.start <= t && t <= n.end);
        const upcoming = current ? null : P.notes.find(n => n.start > t && n.start - t < 1.5);
        $('pTarget').textContent = current ? current.label : upcoming ? `→ ${upcoming.label}` : '—';

        // "You" box, lightly smoothed for readability
        if (f) {
            P.display = P.display ? P.display * 0.7 + f * 0.3 : f;
            const info = swaraForFrequency(P.display, P.saHz);
            $('pYou').textContent = info ? info.label : '—';
            const centsEl = $('pCents');
            const ref = current || P.notes.find(n => Math.abs(n.start - t) < 0.3);
            if (ref) {
                const c = Math.round(pitchClassCentsOffset(P.display, ref.hz));
                centsEl.textContent = Math.abs(c) <= P.tolerance ? '✓ on the note'
                    : c > 0 ? `▼ ${c}¢ high` : `▲ ${-c}¢ low`;
                centsEl.className = `now-cents ${Math.abs(c) <= P.tolerance ? 'on' : Math.abs(c) <= 2 * P.tolerance ? 'near' : 'off'}`;
            } else {
                centsEl.textContent = '';
                centsEl.className = 'now-cents';
            }
        } else {
            P.display = null;
            $('pYou').textContent = '—';
            $('pCents').textContent = '';
            $('pCents').className = 'now-cents';
        }

        drawLane($('practiceLane'), { notes: P.notes, frames: P.frames, playhead: t, saHz: P.saHz, range: P.range });
        P.raf = requestAnimationFrame(practiceLoop);
    }

    async function stopPractice(showResult) {
        const S = P;
        S.running = false;
        cancelAnimationFrame(S.raf);
        S.guide.pause();
        if (S.backing) S.backing.pause();
        S.guide.onended = null;
        if (S.drone) { S.drone.stop(); S.drone = null; }
        $('countdown').classList.add('hidden');
        $('startPracticeBtn').disabled = false;
        $('stopPracticeBtn').disabled = true;

        const recorder = S.recorder;
        const stopped = recorder && recorder.state !== 'inactive'
            ? new Promise(r => { recorder.onstop = r; recorder.stop(); }) : Promise.resolve();
        await stopped;
        if (S.mic) {
            S.mic.source.disconnect();
            S.mic.stream.getTracks().forEach(t => t.stop());
        }
        if (!showResult || !recorder || P !== S) return;

        // Score only the notes the learner reached before stopping.
        const lastT = S.frames.length ? S.frames[S.frames.length - 1].t : 0;
        const reached = S.notes.filter(n => n.start < lastT - SING_LATENCY);
        const voiced = S.frames.filter(p => p.f).length;
        S.result = scoreTake(reached, S.frames, { tolerance: S.tolerance, latency: SING_LATENCY });

        const wav = await recordingToWav(new Blob(S.chunks, { type: recorder.mimeType }), audioCtx());
        S.take = { ...wav, duration: wav.duration || (performance.now() - S.startedAt) / 1000 };
        if (P !== S) return;

        // Colour the lane by result and park the playhead at the start.
        const resultByStart = new Map(S.result.notes.map(n => [n.start, n.result]));
        S.notes = S.notes.map(n => ({ ...n, result: resultByStart.get(n.start) }));
        drawLane($('practiceLane'), { notes: S.notes, frames: S.frames, playhead: Math.min(lastT, 2.5), saHz: S.saHz, range: S.range, fullTrace: true });
        S.notes = S.notes.map(({ result, ...n }) => n);

        $('pScore').textContent = S.result.total ? S.result.score : '–';
        $('pCounts').replaceChildren(
            el('span', { class: 'chip good', text: `${S.result.hit} on note` }),
            el('span', { class: 'chip mid', text: `${S.result.near} close` }),
            el('span', { class: 'chip low', text: `${S.result.missed} off` }),
            el('span', { class: 'chip', text: `${S.result.silent} not sung` }));
        if (voiced < 10) {
            $('pTips').replaceChildren(el('p', { text: "• We couldn't hear you. Check that the right microphone is selected and allowed." }));
        } else {
            renderTips($('pTips'), S.result);
        }
        const takeAudio = $('pTakeAudio');
        if (takeAudio.src) URL.revokeObjectURL(takeAudio.src);
        takeAudio.src = URL.createObjectURL(S.take.blob);
        $('sendTakeBtn').disabled = false;
        $('sendStatus').textContent = '';
        $('pResults').classList.remove('hidden');
        $('pResults').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    $('sendTakeBtn').addEventListener('click', async () => {
        if (!P || !P.take || !P.result) return;
        const btn = $('sendTakeBtn');
        btn.disabled = true;
        $('sendStatus').textContent = 'Sending…';

        // Compact pitch trace for the teacher (one point every ~20 ms).
        const frames = [];
        let lastKept = -1;
        for (const p of P.frames) {
            if (p.t - lastKept < 0.02) continue;
            lastKept = p.t;
            frames.push([Math.round(p.t * 100) / 100, p.f ? Math.round(p.f * 10) / 10 : 0]);
        }
        const summary = {
            title: P.assignment.title,
            sa_hz: P.saHz,
            speed: parseFloat($('pSpeed').value),
            score: P.result.score, total: P.result.total,
            hit: P.result.hit, near: P.result.near, missed: P.result.missed, silent: P.result.silent,
            tips: P.result.tips,
            notes: P.result.notes.map(n => ({
                start: Math.round(n.start * 100) / 100, end: Math.round(n.end * 100) / 100,
                semitone: n.semitone, label: n.label, name: n.name, hz: n.hz, result: n.result, medianCents: n.medianCents,
            })),
        };

        const fd = new FormData();
        fd.append('audio', new File([P.take.blob], `take.${P.take.extension}`, { type: P.take.blob.type }));
        fd.append('duration', String(P.take.duration));
        if (P.result.total) fd.append('score', String(P.result.score));
        fd.append('summary', JSON.stringify(summary));
        fd.append('frames', JSON.stringify(frames));
        try {
            await api(`/api/student/${encodeURIComponent(studentToken)}/assignments/${P.assignment.id}/takes`, { method: 'POST', body: fd });
            $('sendStatus').textContent = 'Sent to your teacher ✓';
            studentData = await api(`/api/student/${encodeURIComponent(studentToken)}`);
            renderStudent();
        } catch (err) {
            btn.disabled = false;
            $('sendStatus').textContent = '';
            flash(err.message);
        }
    });

    window.addEventListener('resize', () => {
        if (P && !P.running) drawLane($('practiceLane'), { notes: P.notes, frames: P.frames, playhead: 0, saHz: P.saHz, range: P.range });
    });

    route();
})();
