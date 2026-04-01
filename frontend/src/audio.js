/**
 * Audio playback & volume analysis for lip-sync.
 */
import * as state from './state.js';

/**
 * Decode base64 WAV and schedule it for gapless playback.
 */
export async function playWav(wav_b64) {
    if (!state.audioCtx) return;

    try {
        if (state.audioCtx.state === 'suspended') {
            await state.audioCtx.resume();
        }

        const bytes = b64ToBytes(wav_b64);
        const audioData = await state.audioCtx.decodeAudioData(bytes.buffer);
        const source = state.audioCtx.createBufferSource();
        source.buffer = audioData;
        source.connect(state.analyser);

        // Only connect analyser → destination once
        if (!state.analyserConnected) {
            state.analyser.connect(state.audioCtx.destination);
            state.setAnalyserConnected(true);
        }

        const now = state.audioCtx.currentTime;
        let next = state.nextAudioTime;
        if (next < now) {
            next = now + 0.005; // tiny buffer to prevent click artifacts
        }
        source.start(next);
        state.setNextAudioTime(next + audioData.duration);
    } catch (err) {
        console.error('Audio playback error:', err);
        if (state.dom.caption) {
            state.dom.caption.textContent = '[Audio Error] ' + err.message;
        }
    }
}

/**
 * Init the AudioContext & AnalyserNode (must be called after user gesture).
 */
export function initAudioContext() {
    if (state.audioCtx) return;

    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256; // smaller = less latency for volume detection
    const dataArray = new Float32Array(analyser.frequencyBinCount);

    state.setAudioCtx(ctx);
    state.setAnalyser(analyser);
    state.setDataArray(dataArray);

    startVolumeLoop();
}

/**
 * Continuous loop that drives mouthValue from audio RMS.
 */
function startVolumeLoop() {
    const tick = () => {
        if (state.analyser && state.dataArray) {
            state.analyser.getFloatTimeDomainData(state.dataArray);
            let sum = 0;
            for (let i = 0; i < state.dataArray.length; i++) {
                sum += state.dataArray[i] * state.dataArray[i];
            }
            const rms = Math.sqrt(sum / state.dataArray.length);
            state.setMouthValue(Math.min(1.0, rms * 15.0));
            state.dom.vol.textContent = state.mouthValue.toFixed(3);
        }
        requestAnimationFrame(tick);
    };
    tick();
}

function b64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}
