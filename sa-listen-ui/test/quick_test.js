/*
 * Pitch helper tests. Run either way:
 *   - Browser: open test/quick_test.html
 *   - Node:    node sa-listen-ui/test/quick_test.js
 */
(function () {
    const isNode = typeof window === 'undefined';
    const lib = isNode ? require('../pitch.js') : window;
    const {
        detectPitch, frequencyToCentsOffset, pitchClassCentsOffset, frequencyToNoteName,
        noteNameToFrequency, swaraForFrequency, pitchContour, segmentNotes, scoreTake,
    } = lib;

    let failures = 0;

    function log(message, passed) {
        if (!passed) failures++;
        const line = (passed ? 'PASS: ' : 'FAIL: ') + message;
        if (isNode) {
            console.log(line);
            return;
        }
        const div = document.createElement('div');
        div.className = 'test-case ' + (passed ? 'pass' : 'fail');
        div.textContent = line;
        document.getElementById('results').appendChild(div);
    }

    function assert(condition, message) {
        log(message, !!condition);
    }

    // A voice-like tone: fundamental plus a couple of harmonics.
    function tone(freq, sampleRate, size = 2048) {
        const buf = new Float32Array(size);
        for (let i = 0; i < size; i++) {
            const t = (2 * Math.PI * freq * i) / sampleRate;
            buf[i] = 0.5 * Math.sin(t) + 0.3 * Math.sin(2 * t + 1) + 0.15 * Math.sin(3 * t);
        }
        return buf;
    }

    function run() {
        // frequencyToNoteName
        assert(frequencyToNoteName(440) === 'A4', '440Hz should be A4');
        assert(frequencyToNoteName(261.63) === 'C4', '261.63Hz should be C4');
        assert(frequencyToNoteName(880) === 'A5', '880Hz should be A5');
        assert(frequencyToNoteName(82.41) === 'E2', '82.41Hz should be E2');
        assert(frequencyToNoteName(null) === null, 'null input should return null');

        // frequencyToCentsOffset
        assert(Math.abs(frequencyToCentsOffset(440, 440)) < 0.1, '440Hz vs 440Hz should be 0 cents');
        assert(Math.abs(frequencyToCentsOffset(880, 440) - 1200) < 0.1, '880Hz vs 440Hz should be 1200 cents');
        assert(Math.abs(frequencyToCentsOffset(220, 440) + 1200) < 0.1, '220Hz vs 440Hz should be -1200 cents');

        // pitchClassCentsOffset (octave-folded)
        assert(Math.abs(pitchClassCentsOffset(220, 440)) < 0.1, 'One octave down folds to 0 cents');
        assert(Math.abs(pitchClassCentsOffset(1760, 440)) < 0.1, 'Two octaves up folds to 0 cents');
        assert(Math.abs(pitchClassCentsOffset(445, 220) - 19.6) < 0.5, '445Hz vs 220Hz is ~+20 cents after folding');
        assert(pitchClassCentsOffset(415.3, 440) < -95, 'A semitone flat stays negative');

        // detectPitch across the vocal range at common mic sample rates
        for (const sampleRate of [44100, 48000]) {
            for (const freq of [55, 82.41, 110, 196, 261.63, 440, 659.25, 880, 987.77]) {
                const detected = detectPitch(tone(freq, sampleRate), sampleRate);
                const cents = detected ? frequencyToCentsOffset(detected, freq) : NaN;
                assert(detected && Math.abs(cents) < 5,
                    `${freq}Hz @ ${sampleRate} detected as ${detected ? detected.toFixed(2) : 'null'}Hz`);
            }
        }

        assert(detectPitch(new Float32Array(2048), 48000) === null, 'Silence should return null');

        let seed = 1;
        const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
        const noise = Float32Array.from({ length: 2048 }, rand);
        assert(detectPitch(noise, 48000) === null, 'White noise should return null');

        // --- Sa-relative helpers ---
        const sa = noteNameToFrequency('C#3');
        assert(Math.abs(sa - 138.59) < 0.01, 'C#3 should be 138.59 Hz');
        assert(swaraForFrequency(sa * 1.5, sa).swara === 'P', 'A fifth above Sa is Pa');
        assert(swaraForFrequency(sa * Math.pow(2, 3 / 12), sa).swara === 'g', 'Three semitones above Sa is komal Ga');
        assert(swaraForFrequency(sa / 2, sa).octave === -1, 'Half of Sa is mandra (lower) Sa');
        assert(swaraForFrequency(sa * 2, sa).octave === 1, 'Double Sa is tara (upper) Sa');

        // Synthetic exercise: S R G m P with vibrato, 0.5 s notes, 0.1 s gaps
        const sr = 11025, seq = [0, 2, 4, 5, 7];
        const sig = new Float32Array(Math.ceil(seq.length * 0.6 * sr));
        let phase = 0;
        for (let i = 0; i < sig.length; i++) {
            const t = i / sr, k = Math.floor(t / 0.6);
            if (k >= seq.length || t - k * 0.6 >= 0.5) continue;
            phase += 2 * Math.PI * sa * Math.pow(2, (seq[k] + 0.15 * Math.sin(2 * Math.PI * 5.5 * t)) / 12) / sr;
            sig[i] = 0.5 * Math.sin(phase) + 0.25 * Math.sin(2 * phase);
        }
        const contour = pitchContour(sig, sr);
        const notes = segmentNotes(contour, sa);
        assert(notes.map(n => n.swara || n.label).join(' ') === 'S R G m P',
            `Segments S R G m P (got ${notes.map(n => n.label).join(' ')})`);

        const late = contour.map(p => ({ t: p.t + 0.1, f: p.f ? p.f * 2 : null }));
        assert(scoreTake(notes, late).score === 100, 'Perfect take an octave up and 0.1 s late scores 100');
        const flatGa = contour.map(p => {
            if (!p.f) return { t: p.t + 0.1, f: null };
            const onGa = Math.round(12 * Math.log2(p.f / sa)) === 4;
            return { t: p.t + 0.1, f: onGa ? p.f * Math.pow(2, -0.7 / 12) : p.f };
        });
        const flatResult = scoreTake(notes, flatGa, { tolerance: 50 });
        assert(flatResult.notes[2].result !== 'hit' && flatResult.tips[0] && flatResult.tips[0].label === 'G',
            'A flat Ga is flagged in the tips');
        assert(scoreTake(notes, []).silent === notes.length, 'An empty take marks every note as not sung');

        if (isNode) {
            console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) failed.`);
            process.exitCode = failures === 0 ? 0 : 1;
        }
    }

    if (isNode) run();
    else window.addEventListener('load', run);
})();
