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
 * Pure pitch helpers (no DOM access). Loaded before script.js and exposed
 * globally so they can be unit tested from test/quick_test.html or Node.
 */

const PITCH_MIN_FREQUENCY = 50;   // Hz, below the lowest sung bass notes
const PITCH_MAX_FREQUENCY = 1000; // Hz, above a soprano's high C (C6 ≈ 1047 Hz is out of scope)
const PITCH_MIN_RMS = 0.01;       // Ignore frames quieter than this
const PITCH_MIN_CLARITY = 0.5;    // NSDF peak height required to trust a frame
const PITCH_PEAK_THRESHOLD = 0.9; // Pick the first peak within 90% of the best one

/**
 * Detect the fundamental frequency of a mono time-domain frame using the
 * McLeod Pitch Method (normalized square difference function + parabolic
 * interpolation). Returns a frequency in Hz, or null when the frame is too
 * quiet, unpitched, or outside the vocal range.
 *
 * Compared with picking the raw autocorrelation maximum, the NSDF is
 * normalized per lag (no bias toward short lags, which made low voices read
 * as ~1000 Hz) and the "first peak above threshold" rule avoids octave-down
 * errors. Parabolic interpolation removes the integer-lag quantization that
 * made high notes read 10-15 cents flat.
 */
function detectPitch(timeData, sampleRate) {
    const size = timeData.length;
    if (!size || !sampleRate) return null;

    // 1) Energy gate
    let energy = 0;
    for (let i = 0; i < size; i++) energy += timeData[i] * timeData[i];
    if (Math.sqrt(energy / size) < PITCH_MIN_RMS) return null;

    // Need enough overlap at the longest lag for a stable estimate.
    const minLag = Math.max(2, Math.floor(sampleRate / PITCH_MAX_FREQUENCY));
    const maxLag = Math.min(Math.ceil(sampleRate / PITCH_MIN_FREQUENCY), Math.floor(size * 0.6));
    if (maxLag <= minLag) return null;

    // 2) NSDF: n(tau) = 2 * r(tau) / m(tau), where m(tau) is the energy of
    //    the two overlapping windows. m is updated incrementally.
    const nsdf = new Float32Array(maxLag + 2);
    let m = 2 * energy;
    for (let tau = 0; tau <= maxLag + 1; tau++) {
        let r = 0;
        for (let i = 0; i < size - tau; i++) r += timeData[i] * timeData[i + tau];
        nsdf[tau] = m > 0 ? (2 * r) / m : 0;
        // Remove the samples that fall out of the overlap for the next lag.
        const a = timeData[size - 1 - tau];
        const b = timeData[tau];
        m -= a * a + b * b;
    }

    // 3) Key maxima: the highest point of each positive lobe after the
    //    first negative-going zero crossing.
    const peaks = [];
    let tau = 1;
    while (tau <= maxLag && nsdf[tau] > 0) tau++; // skip the zero-lag lobe
    while (tau <= maxLag) {
        while (tau <= maxLag && nsdf[tau] <= 0) tau++;
        let best = -1;
        while (tau <= maxLag && nsdf[tau] > 0) {
            if (best === -1 || nsdf[tau] > nsdf[best]) best = tau;
            tau++;
        }
        if (best !== -1 && best >= minLag) peaks.push(best);
    }
    if (peaks.length === 0) return null;

    let highest = 0;
    for (const p of peaks) highest = Math.max(highest, nsdf[p]);
    if (highest < PITCH_MIN_CLARITY) return null;

    const threshold = highest * PITCH_PEAK_THRESHOLD;
    const chosen = peaks.find(p => nsdf[p] >= threshold);

    // 4) Parabolic interpolation around the chosen lag for sub-sample accuracy.
    const y0 = nsdf[chosen - 1];
    const y1 = nsdf[chosen];
    const y2 = nsdf[chosen + 1];
    const denom = y0 - 2 * y1 + y2;
    const shift = denom !== 0 ? 0.5 * (y0 - y2) / denom : 0;
    const period = chosen + (Math.abs(shift) < 1 ? shift : 0);

    const frequency = sampleRate / period;
    if (frequency < PITCH_MIN_FREQUENCY || frequency > PITCH_MAX_FREQUENCY) return null;
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
 * Cents offset with octaves folded out, in the range [-600, 600).
 * Singing the right note in a different octave (e.g. a male voice an
 * octave below a female reference) counts as on pitch.
 */
function pitchClassCentsOffset(freq, targetFreq) {
    const cents = frequencyToCentsOffset(freq, targetFreq);
    return ((((cents + 600) % 1200) + 1200) % 1200) - 600;
}

/**
 * Map a frequency in Hz to a musical note name with octave (e.g. A4, C#3).
 */
function frequencyToNoteName(freq) {
    if (!freq || !isFinite(freq)) return null;

    const midi = 69 + Math.round(12 * Math.log2(freq / 440)); // A4 = MIDI 69
    if (midi < 0 || midi > 127) return null;

    const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    return `${noteNames[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { detectPitch, frequencyToCentsOffset, pitchClassCentsOffset, frequencyToNoteName };
}
