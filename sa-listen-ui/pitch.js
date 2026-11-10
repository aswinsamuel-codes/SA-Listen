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

/* ------------------------------------------------------------------------
 * Sa-relative (Indian) helpers and note-level scoring
 * --------------------------------------------------------------------- */

// Hindustani shorthand: lower case = komal (flat), m = shuddha Ma, M = tivra Ma.
const SWARA_SHORT = ['S', 'r', 'R', 'g', 'G', 'm', 'M', 'P', 'd', 'D', 'n', 'N'];
const SWARA_LONG = ['Sa', 'komal Re', 'Re', 'komal Ga', 'Ga', 'Ma', 'tivra Ma', 'Pa', 'komal Dha', 'Dha', 'komal Ni', 'Ni'];

/** Frequency of a note name like "C#3" (A4 = 440 Hz). */
function noteNameToFrequency(name) {
    const m = /^([A-G])(#?)(-?\d)$/.exec(name || '');
    if (!m) return null;
    const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]] + (m[2] ? 1 : 0);
    const midi = (Number(m[3]) + 1) * 12 + base;
    return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * Describe a frequency relative to the singer's Sa (tonic).
 * Octave dots follow the usual convention: dot below = mandra (lower),
 * dot above = tara (upper) saptak.
 */
function swaraForFrequency(freq, saHz) {
    if (!freq || !saHz || !isFinite(freq)) return null;
    const semis = 12 * Math.log2(freq / saHz);
    const nearest = Math.round(semis);
    const pc = ((nearest % 12) + 12) % 12;
    const octave = Math.floor(nearest / 12);
    const dots = octave < 0 ? '̣'.repeat(-octave) : '̇'.repeat(octave);
    return {
        semitone: nearest,
        swara: SWARA_SHORT[pc],
        name: SWARA_LONG[pc],
        octave,
        label: SWARA_SHORT[pc] + dots,
        cents: Math.round((semis - nearest) * 100),
    };
}

/**
 * Pitch contour of a mono signal: [{ t: seconds, f: Hz | null }].
 * Pass a signal resampled to ~11 kHz for speed; vocal fundamentals sit
 * well below that Nyquist limit.
 */
function pitchContour(samples, sampleRate, frameSize = 1024, hop = 128) {
    const frames = [];
    const frame = new Float32Array(frameSize);
    for (let start = 0; start + frameSize <= samples.length; start += hop) {
        frame.set(samples.subarray(start, start + frameSize));
        frames.push({ t: (start + frameSize / 2) / sampleRate, f: detectPitch(frame, sampleRate) });
    }
    return frames;
}

/**
 * Split a contour into sung notes relative to Sa.
 * Frames are median-smoothed, snapped to the nearest semitone, and runs
 * of the same semitone (allowing short unvoiced gaps) become notes.
 * Returns [{ start, end, semitone, hz, label, name }].
 */
function segmentNotes(contour, saHz, opts = {}) {
    const minDuration = opts.minDuration ?? 0.12;
    const maxGap = opts.maxGap ?? 0.08;
    const smoothWidth = opts.smoothWidth ?? 5;

    // Semitones from Sa per frame (null when unvoiced)
    const semis = contour.map(p => (p.f ? 12 * Math.log2(p.f / saHz) : null));

    // Median filter over voiced neighbours to tame jitter and short slides
    const half = Math.floor(smoothWidth / 2);
    const snapped = semis.map((v, i) => {
        if (v === null) return null;
        const window = [];
        for (let j = i - half; j <= i + half; j++) {
            if (j >= 0 && j < semis.length && semis[j] !== null) window.push(semis[j]);
        }
        window.sort((a, b) => a - b);
        return Math.round(window[Math.floor(window.length / 2)]);
    });

    const notes = [];
    let current = null;
    for (let i = 0; i < contour.length; i++) {
        const t = contour[i].t;
        const s = snapped[i];
        if (s === null) continue;
        if (current && current.semitone === s && t - current.lastT <= maxGap) {
            current.lastT = t;
            continue;
        }
        if (current) notes.push(current);
        current = { start: t, lastT: t, semitone: s };
    }
    if (current) notes.push(current);

    const frameStep = contour.length > 1 ? contour[1].t - contour[0].t : 0;
    return notes
        .map(n => ({ start: n.start, end: n.lastT + frameStep, semitone: n.semitone }))
        .filter(n => n.end - n.start >= minDuration)
        .map(n => {
            const hz = saHz * Math.pow(2, n.semitone / 12);
            const info = swaraForFrequency(hz, saHz);
            return { ...n, hz, label: info.label, name: info.name };
        });
}

/**
 * Score a take note by note.
 *  notes      - from segmentNotes (the target melody)
 *  userFrames - [{ t, f }] the singer's pitch at media time t
 *  tolerance  - cents counted as "on the note" (beginner ~50, advanced ~18)
 *  latency    - seconds the singer is expected to lag (mic + reaction)
 *
 * Octaves are folded out so any voice type can sing along. A note is a
 * "hit" when at least half of its duration is within tolerance, "near"
 * when within twice the tolerance, "missed" when sung but off, and
 * "silent" when barely sung.
 */
function scoreTake(notes, userFrames, opts = {}) {
    const tolerance = opts.tolerance ?? 50;
    const latency = opts.latency ?? 0.1;
    const frames = [...userFrames].sort((a, b) => a.t - b.t);

    let cursor = 0;
    const results = notes.map(note => {
        const from = note.start + latency;
        const to = note.end + latency;
        while (cursor < frames.length && frames[cursor].t < from) cursor++;
        let total = 0, voiced = 0, inTune = 0, close = 0;
        const offsets = [];
        for (let i = cursor; i < frames.length && frames[i].t <= to; i++) {
            total++;
            const f = frames[i].f;
            if (!f) continue;
            voiced++;
            const c = pitchClassCentsOffset(f, note.hz);
            offsets.push(c);
            if (Math.abs(c) <= tolerance) inTune++;
            if (Math.abs(c) <= tolerance * 2) close++;
        }
        offsets.sort((a, b) => a - b);
        const medianCents = offsets.length ? Math.round(offsets[Math.floor(offsets.length / 2)]) : null;

        let result;
        if (total === 0 || voiced / total < 0.25) result = 'silent';
        else if (inTune / total >= 0.5) result = 'hit';
        else if (close / total >= 0.5) result = 'near';
        else result = 'missed';
        return { ...note, result, medianCents };
    });

    const count = r => results.filter(n => n.result === r).length;
    const hit = count('hit'), near = count('near'), missed = count('missed'), silent = count('silent');
    const score = results.length ? Math.round(100 * (hit + 0.5 * near) / results.length) : 0;

    // Per-swara feedback: which swaras go wrong most, and in which direction
    const bySwara = {};
    for (const n of results) {
        const key = n.label;
        bySwara[key] = bySwara[key] || { label: key, name: n.name, total: 0, off: 0, cents: [] };
        bySwara[key].total++;
        if (n.result === 'near' || n.result === 'missed') {
            bySwara[key].off++;
            if (n.medianCents !== null) bySwara[key].cents.push(n.medianCents);
        }
    }
    const tips = Object.values(bySwara)
        .filter(s => s.off > 0 && s.off / s.total >= 0.4)
        .sort((a, b) => b.off / b.total - a.off / a.total)
        .slice(0, 3)
        .map(s => {
            const avg = s.cents.length ? s.cents.reduce((x, y) => x + y, 0) / s.cents.length : 0;
            const direction = avg > 0 ? 'sharp (too high)' : 'flat (too low)';
            return { label: s.label, name: s.name, missRate: s.off / s.total, avgCents: Math.round(avg),
                text: `${s.name} (${s.label}) was ${direction} in ${s.off} of ${s.total} notes${s.cents.length ? `, by about ${Math.abs(Math.round(avg))}¢` : ''}.` };
        });

    return { notes: results, hit, near, missed, silent, total: results.length, score, tips };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        detectPitch, frequencyToCentsOffset, pitchClassCentsOffset, frequencyToNoteName,
        noteNameToFrequency, swaraForFrequency, pitchContour, segmentNotes, scoreTake,
        SWARA_SHORT, SWARA_LONG,
    };
}
