window.addEventListener('load', () => {
    const results = document.getElementById('results');

    function log(message, passed) {
        const div = document.createElement('div');
        div.className = 'test-case ' + (passed ? 'pass' : 'fail');
        div.textContent = (passed ? 'PASS: ' : 'FAIL: ') + message;
        results.appendChild(div);
    }

    function assert(condition, message) {
        log(message, condition);
    }

    // Test frequencyToNoteName
    if (typeof frequencyToNoteName === 'function') {
        assert(frequencyToNoteName(440) === 'A4', '440Hz should be A4');
        assert(frequencyToNoteName(261.63) === 'C4', '261.63Hz should be C4');
        assert(frequencyToNoteName(880) === 'A5', '880Hz should be A5');
        assert(frequencyToNoteName(null) === null, 'null input should return null');
    } else {
        assert(false, 'frequencyToNoteName is not defined globally');
    }

    // Test frequencyToCentsOffset
    if (typeof frequencyToCentsOffset === 'function') {
        assert(Math.abs(frequencyToCentsOffset(440, 440)) < 0.1, '440Hz vs 440Hz should be 0 cents');
        assert(Math.abs(frequencyToCentsOffset(880, 440) - 1200) < 0.1, '880Hz vs 440Hz should be 1200 cents');
        assert(Math.abs(frequencyToCentsOffset(220, 440) + 1200) < 0.1, '220Hz vs 440Hz should be -1200 cents');
    } else {
        assert(false, 'frequencyToCentsOffset is not defined globally');
    }

    // Test detectPitch (mock data)
    if (typeof detectPitch === 'function') {
        const sampleRate = 44100;
        const frequency = 440;
        const size = 2048;
        const buffer = new Float32Array(size);
        // Generate sine wave
        for (let i = 0; i < size; i++) {
            buffer[i] = Math.sin(2 * Math.PI * frequency * i / sampleRate);
        }

        const detected = detectPitch(buffer, sampleRate);
        // Allow some error margin
        if (detected) {
            assert(Math.abs(detected - frequency) < 5, `Sine 440Hz detected as ${detected.toFixed(2)}Hz`);
        } else {
            assert(false, 'Sine 440Hz detection failed (returned null)');
        }

        // Test silence
        const silence = new Float32Array(size).fill(0);
        const detectedSilence = detectPitch(silence, sampleRate);
        assert(detectedSilence === null, 'Silence should return null');

    } else {
        assert(false, 'detectPitch is not defined globally');
    }
});
