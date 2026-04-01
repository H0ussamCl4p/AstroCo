/**
 * UI interactions: chat input, mic button, start overlay, menu selections.
 */
import * as state from './state.js';
import { sendMessage } from './websocket.js';
import { initAudioContext } from './audio.js';
import { handleMenuSelection } from './holograms.js';

/**
 * Wire up all DOM event listeners.
 */
export function initUI() {
    // Start button
    state.dom.startBtn.addEventListener('click', async () => {
        state.dom.startOverlay.style.display = 'none';
        initAudioContext();

        if (state.audioCtx.state === 'suspended') {
            await state.audioCtx.resume();
        }

        sendMessage('start_game');

        if (window.gameMenu) {
            window.gameMenu.visible = true;
        }
    });

    // Chat send button
    state.dom.chatSendBtn.addEventListener('click', () => {
        const text = state.dom.chatInput.value.trim();
        if (text) {
            sendMessage('user_text', { text, mode: 'chat' });
            state.dom.chatInput.value = '';
        }
    });

    // Chat enter key
    state.dom.chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') state.dom.chatSendBtn.click();
    });

    // Expose menu handler globally for raycaster
    window.handleMenuSelection = handleMenuSelection;

    // Create mic button
    createMicButton();
}

/**
 * Create the hold-to-talk microphone button.
 */
function createMicButton() {
    const micBtn = document.createElement('button');
    micBtn.innerText = '🎤 Hold to Talk';
    micBtn.className = 'mic-btn-modern';
    state.dom.chatOverlay.appendChild(micBtn);

    let mediaRecorder = null;
    let audioChunks = [];

    const resetMicBtn = () => {
        micBtn.innerText = '🎤 Hold to Talk';
        micBtn.style.background = '';
        micBtn.style.borderColor = '';
    };

    const stopRecording = () => {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
        }
        resetMicBtn();
    };

    micBtn.addEventListener('mousedown', async () => {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            alert('Microphone not supported on this browser context! Use localhost or HTTPS.');
            return;
        }

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
            audioChunks = [];

            mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) audioChunks.push(e.data);
            };

            mediaRecorder.onstop = () => {
                const blob = new Blob(audioChunks, { type: 'audio/webm' });
                const reader = new FileReader();
                reader.readAsDataURL(blob);
                reader.onloadend = () => {
                    const b64 = reader.result.split(',')[1];
                    sendMessage('voice_audio', { b64, mode: 'chat' });
                    if (state.dom.caption) {
                        state.dom.caption.textContent = 'Processing speech locally...';
                    }
                };
                stream.getTracks().forEach((t) => t.stop());
            };

            mediaRecorder.start();
            micBtn.innerText = '🛑 Listening...';
            micBtn.style.background = 'rgba(255, 34, 34, 0.4)';
            micBtn.style.borderColor = 'rgba(255, 34, 34, 0.8)';
        } catch (e) {
            console.error('Mic access denied', e);
            resetMicBtn();
        }
    });

    micBtn.addEventListener('mouseup', stopRecording);
    micBtn.addEventListener('mouseleave', stopRecording);
}
