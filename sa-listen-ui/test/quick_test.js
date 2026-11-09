/*
 * Pitch helper tests. Run either way:
 *   - Browser: open test/quick_test.html
 *   - Node:    node sa-listen-ui/test/quick_test.js
 */
(function () {
    const isNode = typeof window === 'undefined';
    const lib = isNode ? require('../pitch.js') : window;
    const { detectPitch, frequencyToCentsOffset, pitchClassCentsOffset, frequencyToNoteName } = lib;

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

        if (isNode) {
            console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) failed.`);
            process.exitCode = failures === 0 ? 0 : 1;
        }
    }

    if (isNode) run();
    else window.addEventListener('load', run);
})();
