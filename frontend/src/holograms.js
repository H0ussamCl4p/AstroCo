/**
 * 3D Hologram spawning & menu-scene switching.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import gsap from 'gsap';
import * as state from './state.js';
import { sendMessage } from './websocket.js';

const ASSET_MAP = {
    moon:  '/assets/Galileo.glb',
    solar: '/assets/solar_system_animation/scene.gltf',
    iss:   '/assets/iss.glb',
    jwst:  '/assets/jwst.glb',
};

/**
 * Handle switching between menu scenes: main, chat, and hologram views.
 */
export function handleMenuSelection(sceneId) {
    // Remove current hologram
    if (state.currentHologram) {
        state.threeScene.remove(state.currentHologram);
        state.setCurrentHologram(null);
    }

    if (sceneId === 'main') {
        if (window.gameMenu) window.gameMenu.visible = true;
        if (window.backMenu) window.backMenu.visible = false;
        state.dom.chatOverlay.style.display = 'none';

        // Return character to center
        if (state.vrm) {
            gsap.to(state.vrm.scene.position, { x: 0, z: 0, duration: 1.5, ease: 'power2.inOut' });
        }
    } else {
        if (window.gameMenu) window.gameMenu.visible = false;
        if (window.backMenu) window.backMenu.visible = true;

        if (sceneId === 'chat') {
            state.dom.chatOverlay.style.display = 'flex';
            if (state.vrm) {
                gsap.to(state.vrm.scene.position, { x: 0, z: 0, duration: 1.5, ease: 'power2.inOut' });
            }
        } else {
            state.dom.chatOverlay.style.display = 'none';
            // Move character left to make room for hologram
            if (state.vrm) {
                gsap.to(state.vrm.scene.position, { x: -0.9, z: -0.5, duration: 1.5, ease: 'power2.inOut' });
            }
        }

        // Spawn hologram
        const targetAsset = ASSET_MAP[sceneId];
        if (targetAsset) {
            spawnHologram(targetAsset);
        }
    }

    sendMessage('menu_select', { scene: sceneId });
}

function spawnHologram(assetPath) {
    if (state.dom.caption) {
        state.dom.caption.textContent = 'Downloading Model... Please wait!';
    }

    const loader = new GLTFLoader();
    loader.load(assetPath, (gltf) => {
        if (state.dom.caption && state.dom.caption.textContent.includes('Downloading')) {
            state.dom.caption.textContent = '';
        }

        const model = gltf.scene || gltf.scenes[0];
        if (!model) return;

        if (state.currentHologram) {
            state.threeScene.remove(state.currentHologram);
        }

        // Auto-scale and center
        const box = new THREE.Box3().setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        const scale = maxDim > 0 ? 1.6 / maxDim : 1;

        model.position.set(-center.x * scale, -center.y * scale, -center.z * scale);
        model.scale.set(scale, scale, scale);

        const wrapper = new THREE.Group();
        wrapper.add(model);
        wrapper.position.set(0.3, 1.2, -0.5);

        state.setCurrentHologram(wrapper);
        state.threeScene.add(wrapper);

        // Hologram light
        if (!window.hologramLight) {
            window.hologramLight = new THREE.DirectionalLight(0xffffff, 4.0);
            window.hologramLight.position.set(0.5, 2, 2);
            state.threeScene.add(window.hologramLight);
        }
    });
}
