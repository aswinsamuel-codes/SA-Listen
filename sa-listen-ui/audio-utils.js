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

/* Browser audio helpers shared by the main page and the practice studio. */

/**
 * Mic settings for singing. Browser noise suppression treats sustained
 * notes as noise and AGC pumps the level, so both stay off. Echo
 * cancellation is only useful when the music plays through speakers.
 */
function singingMicConstraints(onHeadphones = true) {
    return {
        audio: {
            echoCancellation: !onHeadphones,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 1,
        },
    };
}

/** 16-bit PCM WAV encoder for an AudioBuffer (mono or stereo). */
function encodeWav(audioBuffer) {
    const channels = Math.min(2, audioBuffer.numberOfChannels);
    const sampleRate = audioBuffer.sampleRate;
    const frames = audioBuffer.length;
    const dataSize = frames * channels * 2;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    const writeString = (offset, s) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)); };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);          // fmt chunk size
    view.setUint16(20, 1, true);           // PCM
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * channels * 2, true);
    view.setUint16(32, channels * 2, true);
    view.setUint16(34, 16, true);          // bits per sample
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    const data = [];
    for (let c = 0; c < channels; c++) data.push(audioBuffer.getChannelData(c));
    let offset = 44;
    for (let i = 0; i < frames; i++) {
        for (let c = 0; c < channels; c++) {
            const s = Math.max(-1, Math.min(1, data[c][i]));
            view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
            offset += 2;
        }
    }
    return new Blob([buffer], { type: 'audio/wav' });
}

/** Convert a MediaRecorder blob to WAV; falls back to the original blob. */
async function recordingToWav(blob, audioContext) {
    try {
        const decoded = await audioContext.decodeAudioData(await blob.arrayBuffer());
        return { blob: encodeWav(decoded), extension: 'wav', duration: decoded.duration };
    } catch (e) {
        console.warn('Could not convert recording to WAV, keeping original format:', e);
        const extension = (blob.type || '').includes('mp4') ? 'm4a' : 'webm';
        return { blob, extension, duration: null };
    }
}
