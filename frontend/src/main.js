/**
 * Entry point — wires together all modules.
 * 
 * Module Architecture:
 * ┌─────────┐     ┌───────────┐     ┌─────────┐
 * │  main   │────>│   state   │<────│  scene  │
 * └────┬────┘     └─────┬─────┘     └────┬────┘
 *      │               │                │
 *      v               v                v
 * ┌─────────┐     ┌───────────┐     ┌─────────┐
 * │   ui    │     │ websocket │     │  audio  │
 * └─────────┘     └───────────┘     └─────────┘
 *                      │
 *                      v
 *                ┌───────────┐
 *                │ holograms │
 *                └───────────┘
 */
import './styles.css';
import { cacheDom } from './state.js';
import { setupVrmScene } from './scene.js';
import { connectWebSocket } from './websocket.js';
import { initUI } from './ui.js';

async function boot() {
    // 1. Cache all DOM element references
    cacheDom();

    // 2. Initialize the 3D scene (VRM, environment, menus)
    try {
        await setupVrmScene();
    } catch (err) {
        console.error('Failed to load model', err);
        document.getElementById('loading').innerText = 'Failed to load model. Check console.';
        return;
    }

    // 3. Connect to Python backend via WebSocket
    connectWebSocket();

    // 4. Wire up UI event listeners (start btn, chat, mic)
    initUI();
}

boot();
