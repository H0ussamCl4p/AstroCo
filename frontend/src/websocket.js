/**
 * WebSocket connection & message handling.
 */
import { VRMExpressionPresetName } from '@pixiv/three-vrm';
import * as state from './state.js';
import { playWav } from './audio.js';
import { startGesture } from './scene.js';

export function connectWebSocket() {
    const isHttps = window.location.protocol === 'https:';
    const wsProtocol = isHttps ? 'wss:' : 'ws:';
    const wsUrl = isHttps 
        ? `${wsProtocol}//${window.location.host}/ws`
        : `${wsProtocol}//${window.location.hostname}:8765`;

    const socket = new WebSocket(wsUrl);
    state.setWs(socket);

    socket.onopen = () => {
        console.log('Connected to VR backend!');
        state.dom.wsStatus.textContent = 'connected';
    };

    socket.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);

            if (msg.type === 'assistant_reply') {
                handleAssistantReply(msg);
            } else if (msg.type === 'pong') {
                console.log(`pong t=${msg.t}`);
            } else if (msg.type === 'error') {
                console.error(`Error: ${msg.error}`);
            } else if (msg.volume !== undefined) {
                const v = Math.max(0, Math.min(1, Number(msg.volume)));
                state.setMouthValue(v);
                state.dom.vol.textContent = v.toFixed(3);
            }

            if (msg.event) {
                handleEvent(msg.event);
            }
        } catch (err) {
            console.error('Bad msg', err);
        }
    };

    socket.onclose = () => {
        console.log('WebSocket Disconnected. Reconnecting...');
        state.dom.wsStatus.textContent = 'disconnected';
        setTimeout(connectWebSocket, 1000);
    };

    socket.onerror = () => {
        state.dom.wsStatus.textContent = 'error';
        console.error('WebSocket error');
    };
}

function handleAssistantReply(msg) {
    let text = msg.text || '';
    // Strip ALL bracket tags like [Happy], [Neutral], [Angry] etc.
    let actualText = text.replace(/\[.*?\]/g, '').trim();

    // Parse emotion tags for VRM expressions
    const emotionMatch = text.match(/\[(.*?)\]/);
    if (emotionMatch && state.vrm && state.vrm.expressionManager) {
        const emLabel = emotionMatch[1].toLowerCase();

        // Reset core expressions
        [
            VRMExpressionPresetName.neutral,
            VRMExpressionPresetName.happy,
            VRMExpressionPresetName.surprised,
            VRMExpressionPresetName.angry,
            VRMExpressionPresetName.relaxed,
        ].forEach((name) => {
            state.vrm.expressionManager.setValue(name, 0.0);
        });

        let preset = VRMExpressionPresetName.neutral;
        if (emLabel === 'happy' || emLabel === 'smile')
            preset = VRMExpressionPresetName.happy;
        else if (emLabel === 'surprised')
            preset = VRMExpressionPresetName.surprised;
        else if (emLabel === 'angry')
            preset = VRMExpressionPresetName.angry;
        else if (emLabel === 'thinking' || emLabel === 'relaxed')
            preset = VRMExpressionPresetName.relaxed;

        state.vrm.expressionManager.setValue(preset, 1.0);
    }

    if (state.dom.caption && actualText) {
        state.dom.caption.textContent = actualText;
    }

    if (msg.wav_b64) {
        playWav(msg.wav_b64).catch((e) => console.error('Audio playback error:', e));
    }
}

function handleEvent(ev) {
    if (!ev || !ev.type) return;

    if (ev.type === 'caption') {
        if (state.dom.caption) {
            state.dom.caption.textContent = String(ev.text || '');
        }
        return;
    }

    if (ev.type === 'gesture') {
        startGesture(ev);
        return;
    }

    if (ev.type === 'expression') {
        const id = ev.id || null;
        if (id && id === state.lastExpressionId) return;
        state.setLastExpressionId(id);

        const name = String(ev.name || '').toLowerCase();
        if (!name) return;

        const allowed = new Set(['happy', 'sad', 'angry', 'relaxed', 'surprised']);
        if (!allowed.has(name)) return;

        state.setActiveExpression({
            name,
            id,
            value: Math.max(0, Math.min(1, Number(ev.value ?? 0.6))),
            startS: performance.now() * 0.001,
            durationS: Math.max(0.6, Number(ev.duration || 1.6)),
        });
    }
}

export function sendMessage(type, data = {}) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type, ...data }));
    }
}
