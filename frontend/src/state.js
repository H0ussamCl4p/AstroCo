/**
 * Shared application state — single source of truth for cross-module data.
 * Each module imports only what it needs from here.
 */

// ─── Renderer / Scene / Camera ───
export let threeRenderer = null;
export let threeScene = null;
export let threeCamera = null;

export const setRenderer = (r) => { threeRenderer = r; };
export const setScene    = (s) => { threeScene = s; };
export const setCamera   = (c) => { threeCamera = c; };

// ─── VRM Avatar ───
export let vrm = null;
export let vrmBaseRotations = null;
export let vrmMouthMode = null;

export const setVrm              = (v) => { vrm = v; };
export const setVrmBaseRotations = (r) => { vrmBaseRotations = r; };
export const setVrmMouthMode     = (m) => { vrmMouthMode = m; };

// ─── GLB (non-VRM) fallback state ───
export let glbRoot = null;
export let glbMouth = null;
export let glbBones = null;
export let glbBoneBase = null;
export let glbJawBase = null;
export let glbRootBase = null;
export let glbRigInfo = null;

export const setGlbRoot     = (v) => { glbRoot = v; };
export const setGlbMouth    = (v) => { glbMouth = v; };
export const setGlbBones    = (v) => { glbBones = v; };
export const setGlbBoneBase = (v) => { glbBoneBase = v; };
export const setGlbJawBase  = (v) => { glbJawBase = v; };
export const setGlbRootBase = (v) => { glbRootBase = v; };
export const setGlbRigInfo  = (v) => { glbRigInfo = v; };

// ─── Live2D state ───
export let live2dApp = null;
export let currentLive2dModel = null;
export let live2dMouthParamId = null;

export const setLive2dApp         = (v) => { live2dApp = v; };
export const setCurrentLive2dModel = (v) => { currentLive2dModel = v; };
export const setLive2dMouthParamId = (v) => { live2dMouthParamId = v; };

// ─── Mouth / Audio values ───
export let mouthValue = 0.0;
export let speechLevel = 0.0;

export const setMouthValue  = (v) => { mouthValue = v; };
export const setSpeechLevel = (v) => { speechLevel = v; };

// ─── Gesture / Expression state ───
export let activeGesture = null;
export let lastGestureId = null;
export let activeExpression = null;
export let lastExpressionId = null;

export const setActiveGesture    = (v) => { activeGesture = v; };
export const setLastGestureId    = (v) => { lastGestureId = v; };
export const setActiveExpression = (v) => { activeExpression = v; };
export const setLastExpressionId = (v) => { lastExpressionId = v; };

// ─── WebSocket ───
export let ws = null;
export const setWs = (v) => { ws = v; };

// ─── Audio Context ───
export let audioCtx = null;
export let analyser = null;
export let dataArray = null;
export let analyserConnected = false;
export let nextAudioTime = 0;

export const setAudioCtx         = (v) => { audioCtx = v; };
export const setAnalyser          = (v) => { analyser = v; };
export const setDataArray         = (v) => { dataArray = v; };
export const setAnalyserConnected = (v) => { analyserConnected = v; };
export const setNextAudioTime     = (v) => { nextAudioTime = v; };

// ─── Clock (shared across animation) ───
let _lastClockS = performance.now() * 0.001;
export const clock = {
    getDelta() {
        const nowS = performance.now() * 0.001;
        const dt = nowS - _lastClockS;
        _lastClockS = nowS;
        return dt;
    },
};

// ─── Model URL ───
export const MODEL_URL = '/models/space-avatar.vrm';

// ─── Hologram state ───
export let currentHologram = null;
export const setCurrentHologram = (v) => { currentHologram = v; };

// ─── DOM Elements ───
export const dom = {
    canvas:     null,
    wsStatus:   null,
    vol:        null,
    speech:     null,
    param:      null,
    rig:        null,
    gesture:    null,
    caption:    null,
    loading:    null,
    startOverlay: null,
    startBtn:   null,
    chatOverlay: null,
    chatInput:  null,
    chatSendBtn: null,
};

export function cacheDom() {
    dom.canvas       = document.getElementById('canvas');
    dom.wsStatus     = document.getElementById('wsStatus');
    dom.vol          = document.getElementById('vol');
    dom.speech       = document.getElementById('speech');
    dom.param        = document.getElementById('param');
    dom.rig          = document.getElementById('rig');
    dom.gesture      = document.getElementById('gesture');
    dom.caption      = document.getElementById('caption');
    dom.loading      = document.getElementById('loading');
    dom.startOverlay = document.getElementById('startOverlay');
    dom.startBtn     = document.getElementById('startBtn');
    dom.chatOverlay  = document.getElementById('chatOverlay');
    dom.chatInput    = document.getElementById('chatInput');
    dom.chatSendBtn  = document.getElementById('chatSendBtn');
}
