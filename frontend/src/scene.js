/**
 * Three.js scene, VRM avatar loading, moon environment, 3D menus, and render loop.
 * This is the largest module — it owns the entire 3D world.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, VRMHumanBoneName, VRMExpressionPresetName } from '@pixiv/three-vrm';
import { VRButton } from 'three/examples/jsm/webxr/VRButton.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import gsap from 'gsap';
import * as state from './state.js';

// ─── Utilities ───

function computeMeshBounds(root) {
    const box = new THREE.Box3();
    let hasMesh = false;
    root.traverse((obj) => {
        if (!obj || !obj.isMesh) return;
        const geom = obj.geometry;
        if (!geom) return;
        if (!geom.boundingBox) { try { geom.computeBoundingBox(); } catch {} }
        const bb = geom.boundingBox;
        if (!bb) return;
        const worldBB = bb.clone();
        worldBB.applyMatrix4(obj.matrixWorld);
        if (!hasMesh) { box.copy(worldBB); hasMesh = true; } else { box.union(worldBB); }
    });
    return hasMesh ? box : new THREE.Box3().setFromObject(root);
}

function fitGlbToView(root, camera) {
    try { root.updateWorldMatrix(true, true); } catch {}
    const box = computeMeshBounds(root);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    root.position.x -= center.x;
    root.position.y -= center.y;
    root.position.z -= center.z;
    const fov = camera.fov * (Math.PI / 180);
    const maxDim = Math.max(size.x, size.y, size.z);
    const distance = (maxDim * 0.5) / Math.tan(fov * 0.5);
    const margin = 1.35;
    const cameraZ = Math.max(0.35, distance * margin);
    camera.position.set(0, 0, cameraZ);
    camera.near = Math.max(0.01, distance / 100);
    camera.far = Math.max(1000, distance * 100);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
}

function getVrmBone(boneName) {
    try {
        if (!state.vrm || !state.vrm.humanoid) return null;
        return state.vrm.humanoid.getNormalizedBoneNode(boneName) || null;
    } catch { return null; }
}

// ─── VRM Relaxed Pose ───

function applyVrmRelaxedPose() {
    const RELAX = {
        upperArmZ: 1.15, upperArmX: -0.15,
        lowerArmZ: 0.20, lowerArmX: -0.10,
        handZ: 0.05,
    };
    const lUpper = getVrmBone(VRMHumanBoneName.LeftUpperArm);
    const rUpper = getVrmBone(VRMHumanBoneName.RightUpperArm);
    const lFore  = getVrmBone(VRMHumanBoneName.LeftLowerArm);
    const rFore  = getVrmBone(VRMHumanBoneName.RightLowerArm);
    const lHand  = getVrmBone(VRMHumanBoneName.LeftHand);
    const rHand  = getVrmBone(VRMHumanBoneName.RightHand);

    if (lUpper) { lUpper.rotation.z += RELAX.upperArmZ; lUpper.rotation.x += RELAX.upperArmX; }
    if (rUpper) { rUpper.rotation.z += -RELAX.upperArmZ; rUpper.rotation.x += RELAX.upperArmX; }
    if (lFore)  { lFore.rotation.z += RELAX.lowerArmZ; lFore.rotation.x += RELAX.lowerArmX; }
    if (rFore)  { rFore.rotation.z += -RELAX.lowerArmZ; rFore.rotation.x += RELAX.lowerArmX; }
    if (lHand)  { lHand.rotation.z += RELAX.handZ; }
    if (rHand)  { rHand.rotation.z += -RELAX.handZ; }

    try { state.vrm.scene.updateWorldMatrix(true, true); } catch {}
}

// ─── Moon Environment ───

function createMoonEnvironment(scene) {
    scene.fog = new THREE.FogExp2(0x03050d, 0.015);
    scene.background = new THREE.Color(0x03050d);

    // Stars
    const starsGeometry = new THREE.BufferGeometry();
    const starsMaterial = new THREE.PointsMaterial({ color: 0xffffff, size: 0.05 });
    const verts = [];
    for (let i = 0; i < 5000; i++) {
        verts.push((Math.random() - 0.5) * 50, (Math.random() - 0.5) * 50, (Math.random() - 0.5) * 50);
    }
    starsGeometry.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    scene.add(new THREE.Points(starsGeometry, starsMaterial));

    // Sun + earthshine
    const sunLight = new THREE.DirectionalLight(0xfff8f0, 3.0);
    sunLight.position.set(-12, 20, -20);
    scene.add(sunLight);
    const earthshine = new THREE.DirectionalLight(0x446688, 0.15);
    earthshine.position.set(0, 5, 10);
    scene.add(earthshine);

    // Floor
    const floorGeo = new THREE.PlaneGeometry(600, 600, 1, 1);
    const floorMat = new THREE.MeshStandardMaterial({ color: 0xb0ae9f, roughness: 1.0, metalness: 0.0 });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0;
    scene.add(floor);

    // Craters
    const craterRimMat = new THREE.MeshStandardMaterial({ color: 0x8a8880, roughness: 1.0 });
    const craterFloorMat = new THREE.MeshStandardMaterial({ color: 0x6e6c62, roughness: 1.0 });
    [
        { x: 6, z: -8, r: 1.2 }, { x: -10, z: -5, r: 0.7 },
        { x: 14, z: 3, r: 2.5 }, { x: -18, z: 10, r: 1.8 },
        { x: 3, z: 15, r: 0.5 }, { x: -6, z: -14, r: 3.0 },
        { x: 22, z: -12, r: 1.0 }, { x: -25, z: -8, r: 2.0 },
    ].forEach((c) => {
        const rimGeo = new THREE.TorusGeometry(c.r, c.r * 0.22, 8, 32);
        const rim = new THREE.Mesh(rimGeo, craterRimMat);
        rim.rotation.x = -Math.PI / 2;
        rim.position.set(c.x, 0.02, c.z);
        scene.add(rim);
        const cFloorGeo = new THREE.CircleGeometry(c.r * 0.9, 24);
        const cFloor = new THREE.Mesh(cFloorGeo, craterFloorMat);
        cFloor.rotation.x = -Math.PI / 2;
        cFloor.position.set(c.x, -0.05, c.z);
        scene.add(cFloor);
    });

    // Mountains
    const mountainMat = new THREE.MeshStandardMaterial({ color: 0x7a7868, roughness: 1.0 });
    for (let i = 0; i < 36; i++) {
        const angle = (i / 36) * Math.PI * 2 + (Math.random() - 0.5) * 0.15;
        const radius = 90 + Math.random() * 40;
        const height = 8 + Math.random() * 18;
        const width = 8 + Math.random() * 24;
        for (let j = 0; j < 2; j++) {
            const peakGeo = new THREE.ConeGeometry(width * (0.5 + j * 0.35), height * (1.0 - j * 0.4), 6 + Math.floor(Math.random() * 4));
            const peak = new THREE.Mesh(peakGeo, mountainMat);
            peak.position.set(Math.cos(angle) * (radius + j * 4), height * (0.3 - j * 0.1), Math.sin(angle) * (radius + j * 4));
            peak.rotation.y = Math.random() * Math.PI;
            peak.scale.set(1, 0.7 + Math.random() * 0.6, 1);
            scene.add(peak);
        }
    }

    // Boulders
    const boulderColors = [0x8a8878, 0x6e6c60, 0x9a9888];
    for (let i = 0; i < 55; i++) {
        const r = 1.5 + Math.random() * 22;
        const a = Math.random() * Math.PI * 2;
        if (r < 1.2) continue;
        const h = 0.04 + Math.random() * 0.35;
        const bGeo = new THREE.SphereGeometry(h, 4 + Math.floor(Math.random() * 4), 3);
        const bMat = new THREE.MeshStandardMaterial({ color: boulderColors[Math.floor(Math.random() * 3)], roughness: 1.0 });
        const rock = new THREE.Mesh(bGeo, bMat);
        rock.position.set(Math.cos(a) * r, h * 0.5, Math.sin(a) * r);
        rock.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
        rock.scale.set(1 + Math.random() * 0.8, 0.5 + Math.random() * 0.7, 1 + Math.random() * 0.8);
        scene.add(rock);
    }

    // Earth in sky
    const earthGeo = new THREE.SphereGeometry(8, 48, 48);
    const earthCanvas = document.createElement('canvas');
    earthCanvas.width = 512; earthCanvas.height = 256;
    const ec = earthCanvas.getContext('2d');
    const oceanGrad = ec.createLinearGradient(0, 0, 512, 256);
    oceanGrad.addColorStop(0, '#0a2a6e'); oceanGrad.addColorStop(1, '#0d3d8f');
    ec.fillStyle = oceanGrad; ec.fillRect(0, 0, 512, 256);
    ec.fillStyle = '#2d6e2a';
    [[80,80,55,40],[180,100,80,55],[290,110,60,45],[120,140,40,30],[350,80,35,25],[200,50,45,30]].forEach(([x,y,w,h]) => {
        ec.beginPath(); ec.ellipse(x,y,w,h,Math.random(),0,Math.PI*2); ec.fill();
    });
    ec.fillStyle = 'rgba(255,255,255,0.6)';
    [[60,60,70,18],[200,80,90,22],[350,100,65,20],[100,160,80,15],[280,50,75,18]].forEach(([x,y,w,h]) => {
        ec.beginPath(); ec.ellipse(x,y,w,h,0,0,Math.PI*2); ec.fill();
    });
    const earthTexture = new THREE.CanvasTexture(earthCanvas);
    const earthMat = new THREE.MeshStandardMaterial({ map: earthTexture, roughness: 0.6, metalness: 0.1 });
    const earth = new THREE.Mesh(earthGeo, earthMat);
    earth.position.set(25, 35, -80);
    earth.rotation.z = 0.4;
    scene.add(earth);
    window._earthMesh = earth;
}

// ─── 3D Holographic Menu ───

function createMenuButton(text, yPos, id) {
    const canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 512, 128);

    // Glass background
    ctx.fillStyle = 'rgba(10, 15, 25, 0.4)';
    ctx.beginPath();
    ctx.moveTo(40, 10); ctx.lineTo(472, 10);
    ctx.quadraticCurveTo(492, 10, 492, 30); ctx.lineTo(492, 98);
    ctx.quadraticCurveTo(492, 118, 472, 118); ctx.lineTo(40, 118);
    ctx.quadraticCurveTo(20, 118, 20, 98); ctx.lineTo(20, 30);
    ctx.quadraticCurveTo(20, 10, 40, 10);
    ctx.closePath(); ctx.fill();

    // Glowing border
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0, 255, 204, 0.8)';
    ctx.shadowColor = 'rgba(0, 255, 204, 0.9)';
    ctx.shadowBlur = 12;
    ctx.stroke();

    // Text
    ctx.fillStyle = '#ffffff';
    ctx.shadowBlur = 8;
    ctx.font = '600 32px "Outfit", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (ctx.letterSpacing !== undefined) ctx.letterSpacing = '3px';
    ctx.fillText(text.toUpperCase(), 256, 66);

    const texture = new THREE.CanvasTexture(canvas);
    const mat = new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false });
    const geo = new THREE.PlaneGeometry(0.85, 0.2125);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = yPos;
    mesh.userData = { id };
    return mesh;
}

function create3DMenus(scene) {
    window.gameMenu = new THREE.Group();
    window.gameMenu.position.set(0.6, 1.2, 0.1);
    window.gameMenu.rotation.y = -0.35;
    window.gameMenu.scale.set(0.5, 0.5, 0.5);

    const items = [
        ["Let's Chat", 0.6, 'chat'],
        ['Discover Moon', 0.3, 'moon'],
        ['Discover Solar System', 0.0, 'solar'],
        ['Discover ISS', -0.3, 'iss'],
        ['Discover JWST', -0.6, 'jwst'],
    ];
    items.forEach(([t, y, id]) => window.gameMenu.add(createMenuButton(t, y, id)));
    window.gameMenu.visible = false;
    scene.add(window.gameMenu);

    // Back menu
    window.backMenu = new THREE.Group();
    window.backMenu.position.copy(window.gameMenu.position);
    window.backMenu.rotation.copy(window.gameMenu.rotation);
    window.backMenu.scale.copy(window.gameMenu.scale);
    window.backMenu.add(createMenuButton('Back to Menu', 0.0, 'main'));
    window.backMenu.visible = false;
    scene.add(window.backMenu);
}

function getVisibleMenuChildren() {
    const children = [];
    if (window.gameMenu && window.gameMenu.visible) children.push(...window.gameMenu.children);
    if (window.backMenu && window.backMenu.visible) children.push(...window.backMenu.children);
    return children;
}

function setupMenuRaycasting(camera, renderer) {
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    // Mouse hover
    window.addEventListener('mousemove', (e) => {
        const targets = getVisibleMenuChildren();
        if (targets.length === 0) return;
        mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
        mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
        raycaster.setFromCamera(mouse, camera);
        targets.forEach((t) => { t.scale.set(1, 1, 1); if (t.material) t.material.opacity = 0.85; });
        const intersects = raycaster.intersectObjects(targets);
        if (intersects.length > 0) {
            intersects[0].object.scale.set(1.1, 1.1, 1.1);
            if (intersects[0].object.material) intersects[0].object.material.opacity = 1.0;
            document.body.style.cursor = 'pointer';
        } else {
            document.body.style.cursor = 'default';
        }
    });

    // Mouse click
    window.addEventListener('click', (e) => {
        const targets = getVisibleMenuChildren();
        if (targets.length === 0) return;
        if (e.target.id === 'startBtn') return;
        mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
        mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
        raycaster.setFromCamera(mouse, camera);
        const intersects = raycaster.intersectObjects(targets);
        if (intersects.length > 0) {
            const id = intersects[0].object.userData.id;
            if (window.handleMenuSelection) window.handleMenuSelection(id);
        }
    });

    // VR Controllers
    [0, 1].forEach((idx) => {
        const controller = renderer.xr.getController(idx);
        state.threeScene.add(controller);
        const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -2)]);
        controller.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffffff })));
        controller.addEventListener('select', () => {
            const targets = getVisibleMenuChildren();
            if (targets.length === 0) return;
            const mat = new THREE.Matrix4().identity().extractRotation(controller.matrixWorld);
            const rayc = new THREE.Raycaster();
            rayc.ray.origin.setFromMatrixPosition(controller.matrixWorld);
            rayc.ray.direction.set(0, 0, -1).applyMatrix4(mat);
            const intersects = rayc.intersectObjects(targets);
            if (intersects.length > 0) {
                const id = intersects[0].object.userData.id;
                if (window.handleMenuSelection) window.handleMenuSelection(id);
            }
        });
    });
}

// ─── Human Motion Physics Engine ───

const humanMotion = {
    targets: {},
    states: {},
    _spare: null,
    randn() {
        if (this._spare != null) { const v = this._spare; this._spare = null; return v; }
        let u = 0, v = 0;
        while (u === 0) u = Math.random();
        while (v === 0) v = Math.random();
        const mag = Math.sqrt(-2.0 * Math.log(u));
        this._spare = mag * Math.sin(2.0 * Math.PI * v);
        return mag * Math.cos(2.0 * Math.PI * v);
    },
};

const PHYS = {
    hips:     { fHz: 0.8,  zeta: 0.95, ouTheta: 0.8,  ouSigma: { x: 0.010, y: 0.015, z: 0.010 }, limits: { x: [-0.05, 0.05], y: [-0.10, 0.10], z: [-0.05, 0.05] } },
    leg:      { fHz: 0.9,  zeta: 0.98, ouTheta: 1.0,  ouSigma: { x: 0.005, y: 0.005, z: 0.005 }, limits: { x: [-0.05, 0.05], y: [-0.05, 0.05], z: [-0.05, 0.05] } },
    torso:    { fHz: 1.1,  zeta: 0.85, ouTheta: 0.9,  ouSigma: { x: 0.035, y: 0.030, z: 0.025 }, limits: { x: [-0.18, 0.18], y: [-0.30, 0.30], z: [-0.10, 0.10] } },
    head:     { fHz: 1.8,  zeta: 0.80, ouTheta: 1.2,  ouSigma: { x: 0.055, y: 0.050, z: 0.030 }, limits: { x: [-0.35, 0.35], y: [-0.55, 0.55], z: [-0.25, 0.25] } },
    upperArm: { fHz: 0.95, zeta: 0.98, ouTheta: 1.3,  ouSigma: { x: 0.006, y: 0.006, z: 0.004 }, limits: { x: [-0.55, 0.22], y: [-0.28, 0.28], z: [-0.25, 0.25] } },
    lowerArm: { fHz: 1.10, zeta: 0.95, ouTheta: 1.3,  ouSigma: { x: 0.008, y: 0.008, z: 0.008 }, limits: { x: [-0.90, 0.45], y: [-0.50, 0.50], z: [-0.50, 0.50] } },
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ─── Gesture System (GSAP-based) ───

export function startGesture(ev) {
    const id = ev.id || null;
    if (id && id === state.lastGestureId) return;
    state.setLastGestureId(id);

    const name = ev.name || '';
    const allowed = new Set(['wave', 'nod', 'shake', 'shrug']);
    if (!allowed.has(name)) return;
    if (state.dom.gesture) state.dom.gesture.textContent = name;

    const head  = getVrmBone(VRMHumanBoneName.Head) || getVrmBone(VRMHumanBoneName.Neck);
    const torso = getVrmBone(VRMHumanBoneName.Chest) || getVrmBone(VRMHumanBoneName.Spine);
    const rUpper = getVrmBone(VRMHumanBoneName.RightUpperArm);
    const rFore  = getVrmBone(VRMHumanBoneName.RightLowerArm);
    const rHand  = getVrmBone(VRMHumanBoneName.RightHand);
    const lUpper = getVrmBone(VRMHumanBoneName.LeftUpperArm);

    const bonesToKill = [head, torso, rUpper, rFore, rHand, lUpper].filter(Boolean);
    if (bonesToKill.length > 0) gsap.killTweensOf(bonesToKill.map((b) => b.rotation));

    if (name === 'wave' && rUpper && rFore && rHand && state.vrmBaseRotations) {
        const ub = state.vrmBaseRotations[VRMHumanBoneName.RightUpperArm];
        const fb = state.vrmBaseRotations[VRMHumanBoneName.RightLowerArm];
        const hb = state.vrmBaseRotations[VRMHumanBoneName.RightHand];
        if (ub && fb && hb) {
            window.isGesturing = true;
            const tl = gsap.timeline();
            tl.eventCallback('onComplete', () => { window.isGesturing = false; });
            tl.to(rUpper.rotation, { z: ub.z - 1.2, x: ub.x - 0.4, duration: 0.4, ease: 'power2.out' }, 0);
            tl.to(rFore.rotation, { x: fb.x - 0.4, duration: 0.4, ease: 'power2.out' }, 0);
            tl.to(rHand.rotation, { y: hb.y + 0.6, duration: 0.2, ease: 'sine.inOut', yoyo: true, repeat: 5 }, 0.2);
            tl.to([rUpper.rotation, rFore.rotation, rHand.rotation], {
                x: (i) => (i === 0 ? ub.x : i === 1 ? fb.x : hb.x),
                y: (i) => (i === 0 ? ub.y : i === 1 ? fb.y : hb.y),
                z: (i) => (i === 0 ? ub.z : i === 1 ? fb.z : hb.z),
                duration: 0.5, ease: 'power2.inOut',
            });
        }
    } else if (name === 'nod' && head && state.vrmBaseRotations) {
        const hb = state.vrmBaseRotations[VRMHumanBoneName.Head] || state.vrmBaseRotations[VRMHumanBoneName.Neck];
        if (hb) {
            window.isGesturing = true;
            gsap.to(head.rotation, { x: hb.x - 0.25, duration: 0.15, ease: 'sine.inOut', yoyo: true, repeat: 3,
                onComplete: () => gsap.to(head.rotation, { x: hb.x, duration: 0.2, onComplete: () => (window.isGesturing = false) }) });
        }
    } else if (name === 'shake' && head && state.vrmBaseRotations) {
        const hb = state.vrmBaseRotations[VRMHumanBoneName.Head] || state.vrmBaseRotations[VRMHumanBoneName.Neck];
        if (hb) {
            window.isGesturing = true;
            gsap.to(head.rotation, { y: hb.y + 0.35, duration: 0.15, ease: 'sine.inOut', yoyo: true, repeat: 3,
                onComplete: () => gsap.to(head.rotation, { y: hb.y, duration: 0.2, onComplete: () => (window.isGesturing = false) }) });
        }
    } else if (name === 'shrug' && torso && lUpper && rUpper && state.vrmBaseRotations) {
        const tb  = state.vrmBaseRotations[VRMHumanBoneName.Chest] || state.vrmBaseRotations[VRMHumanBoneName.Spine];
        const lub = state.vrmBaseRotations[VRMHumanBoneName.LeftUpperArm];
        const rub = state.vrmBaseRotations[VRMHumanBoneName.RightUpperArm];
        if (tb && lub && rub) {
            window.isGesturing = true;
            const tl = gsap.timeline();
            tl.eventCallback('onComplete', () => { window.isGesturing = false; });
            tl.to(torso.rotation, { x: tb.x - 0.15, duration: 0.3, ease: 'power1.inOut' }, 0);
            tl.to(lUpper.rotation, { z: lub.z + 0.4, duration: 0.3, ease: 'power1.inOut' }, 0);
            tl.to(rUpper.rotation, { z: rub.z - 0.4, duration: 0.3, ease: 'power1.inOut' }, 0);
            tl.to([torso.rotation, lUpper.rotation, rUpper.rotation], {
                x: (i) => (i === 0 ? tb.x : i === 1 ? lub.x : rub.x),
                z: (i) => (i === 0 ? tb.z : i === 1 ? lub.z : rub.z),
                duration: 0.4, ease: 'power1.inOut', delay: 0.5,
            });
        }
    }
}

// ─── Main Setup ─── 

export async function setupVrmScene() {
    try { THREE.ColorManagement.enabled = true; } catch {}

    const renderer = new THREE.WebGLRenderer({ canvas: state.dom.canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.setClearColor(0x222222, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.xr.enabled = true;
    document.body.appendChild(VRButton.createButton(renderer));

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.01, 1000);

    const ambient = new THREE.AmbientLight(0xffffff, 0.9);
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
    keyLight.position.set(1, 2, 3);
    scene.add(ambient, keyLight);

    state.setRenderer(renderer);
    state.setScene(scene);
    state.setCamera(camera);

    // Build environment
    createMoonEnvironment(scene);
    create3DMenus(scene);
    setupMenuRaycasting(camera, renderer);

    // Load VRM
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync(state.MODEL_URL);
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.removeUnnecessaryJoints(gltf.scene);

    const vrm = gltf.userData.vrm;
    if (!vrm) throw new Error('VRM loader did not produce a vrm instance');

    try { VRMUtils.rotateVRM0(vrm); } catch {}
    state.setVrm(vrm);
    applyVrmRelaxedPose();

    scene.add(vrm.scene);
    state.dom.loading.style.display = 'none';
    fitGlbToView(vrm.scene, camera);

    // Orbit controls
    window.controls = new OrbitControls(camera, renderer.domElement);
    window.controls.target.set(0, 0.8, 0);
    window.controls.enableDamping = true;
    window.controls.dampingFactor = 0.05;
    window.controls.enablePan = false;
    window.controls.minDistance = 0.5;
    window.controls.maxDistance = 6.0;

    // Cache base rotations
    const baseRotations = {};
    [
        VRMHumanBoneName.Hips, VRMHumanBoneName.Spine, VRMHumanBoneName.Chest,
        VRMHumanBoneName.Neck, VRMHumanBoneName.Head,
        VRMHumanBoneName.LeftUpperArm, VRMHumanBoneName.RightUpperArm,
        VRMHumanBoneName.LeftLowerArm, VRMHumanBoneName.RightLowerArm,
        VRMHumanBoneName.LeftHand, VRMHumanBoneName.RightHand,
        VRMHumanBoneName.LeftUpperLeg, VRMHumanBoneName.RightUpperLeg,
    ].forEach((k) => {
        const b = getVrmBone(k);
        if (b) baseRotations[k] = { x: b.rotation.x, y: b.rotation.y, z: b.rotation.z };
    });
    state.setVrmBaseRotations(baseRotations);

    // Mouth control
    const mouthMode = (vrm.expressionManager && typeof vrm.expressionManager.setValue === 'function') ? 'expression' : null;
    state.setVrmMouthMode(mouthMode);
    state.dom.param.textContent = mouthMode ? 'vrm:expression:aa' : '(no mouth controller)';

    // Resize
    window.addEventListener('resize', () => {
        renderer.setSize(window.innerWidth, window.innerHeight, false);
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        if (state.vrm && state.vrm.scene) fitGlbToView(state.vrm.scene, camera);
    });

    // ─── Render Loop ───
    renderer.setAnimationLoop(() => {
        // Smooth speech
        const vRaw = state.mouthValue;
        let sl = state.speechLevel;
        sl = vRaw > sl ? sl * 0.75 + vRaw * 0.25 : sl * 0.88 + vRaw * 0.12;
        state.setSpeechLevel(sl);
        state.dom.speech.textContent = sl.toFixed(3);

        const t = performance.now() * 0.001;
        const s = Math.max(0, Math.min(1, sl));
        const dt = Math.min(0.05, Math.max(0.001, state.clock.getDelta()));

        // Mouth
        if (state.vrmMouthMode === 'expression') {
            try { state.vrm.expressionManager.setValue(VRMExpressionPresetName.Aa, s); } catch {}
        }

        // Expression overlay
        if (state.vrmMouthMode === 'expression' && state.activeExpression) {
            const nowS = performance.now() * 0.001;
            const u = (nowS - state.activeExpression.startS) / Math.max(0.001, state.activeExpression.durationS);
            if (u >= 1.0) {
                state.setActiveExpression(null);
            } else {
                const env = Math.sin(Math.min(1.0, u) * Math.PI);
                const v = Math.max(0, Math.min(1, state.activeExpression.value * env));
                const preset = { happy: VRMExpressionPresetName.Happy, sad: VRMExpressionPresetName.Sad, angry: VRMExpressionPresetName.Angry, relaxed: VRMExpressionPresetName.Relaxed, surprised: VRMExpressionPresetName.Surprised }[state.activeExpression.name];
                try { if (preset) state.vrm.expressionManager.setValue(preset, v); } catch {}
            }
        }

        // Human motion physics
        const ouStep = (x, theta, sigma) => x + (-theta * x) * dt + sigma * Math.sqrt(dt) * humanMotion.randn();
        const ensure = (key, base) => {
            if (!humanMotion.targets[key]) humanMotion.targets[key] = { ox: 0, oy: 0, oz: 0 };
            if (!humanMotion.states[key]) humanMotion.states[key] = { x: base.x, y: base.y, z: base.z, vx: 0, vy: 0, vz: 0 };
        };
        const stepSecondOrder = (st, target, fHz, zeta) => {
            const w = 2.0 * Math.PI * fHz;
            const k = w * w;
            const c = 2.0 * zeta * w;
            st.vx += (k * (target.x - st.x) - c * st.vx) * dt;
            st.vy += (k * (target.y - st.y) - c * st.vy) * dt;
            st.vz += (k * (target.z - st.z) - c * st.vz) * dt;
            st.x += st.vx * dt; st.y += st.vy * dt; st.z += st.vz * dt;
        };
        const driveBone = (boneEnum, fallbackEnum, opts) => {
            const bone = getVrmBone(boneEnum) || (fallbackEnum ? getVrmBone(fallbackEnum) : null);
            if (!bone || !state.vrmBaseRotations) return;
            const key = bone === getVrmBone(boneEnum) ? boneEnum : fallbackEnum;
            if (!key || !state.vrmBaseRotations[key]) return;
            const base = state.vrmBaseRotations[key];
            ensure(key, base);
            const tgt = humanMotion.targets[key];
            const st = humanMotion.states[key];
            tgt.ox = ouStep(tgt.ox, opts.ouTheta, opts.ouSigmaX);
            tgt.oy = ouStep(tgt.oy, opts.ouTheta, opts.ouSigmaY);
            tgt.oz = ouStep(tgt.oz, opts.ouTheta, opts.ouSigmaZ);
            const target = { x: base.x + opts.baseOffset.x + tgt.ox, y: base.y + opts.baseOffset.y + tgt.oy, z: base.z + opts.baseOffset.z + tgt.oz };
            stepSecondOrder(st, target, opts.fHz, opts.zeta);
            if (opts.limits) {
                st.x = base.x + clamp(st.x - base.x, opts.limits.x[0], opts.limits.x[1]);
                st.y = base.y + clamp(st.y - base.y, opts.limits.y[0], opts.limits.y[1]);
                st.z = base.z + clamp(st.z - base.z, opts.limits.z[0], opts.limits.z[1]);
            }
            bone.rotation.x = st.x; bone.rotation.y = st.y; bone.rotation.z = st.z;
        };

        if (!window.isGesturing) {
            const talk = s;
            const breathe = 0.012 + 0.010 * (0.5 + 0.5 * Math.sin(t * 1.2));
            const micro = 0.008;

            driveBone(VRMHumanBoneName.Hips, null, { baseOffset: { x: 0.015 * Math.sin(t * 0.8), y: 0.010 * Math.sin(t * 0.6), z: 0.005 * Math.sin(t * 1.0) }, ...PHYS.hips, ouSigmaX: PHYS.hips.ouSigma.x, ouSigmaY: PHYS.hips.ouSigma.y, ouSigmaZ: PHYS.hips.ouSigma.z });
            driveBone(VRMHumanBoneName.LeftUpperLeg, null, { baseOffset: { x: 0, y: 0, z: 0.015 * Math.sin(t * 0.7) }, ...PHYS.leg, ouSigmaX: PHYS.leg.ouSigma.x, ouSigmaY: PHYS.leg.ouSigma.y, ouSigmaZ: PHYS.leg.ouSigma.z });
            driveBone(VRMHumanBoneName.RightUpperLeg, null, { baseOffset: { x: 0, y: 0, z: -(0.015 * Math.sin(t * 0.7)) }, ...PHYS.leg, ouSigmaX: PHYS.leg.ouSigma.x, ouSigmaY: PHYS.leg.ouSigma.y, ouSigmaZ: PHYS.leg.ouSigma.z });
            driveBone(VRMHumanBoneName.Chest, VRMHumanBoneName.Spine, { baseOffset: { x: breathe * Math.sin(t * 1.3) + 0.04 * talk * Math.sin(t * 3.1), y: micro * Math.sin(t * 0.9) + 0.03 * talk * Math.sin(t * 2.4), z: micro * Math.sin(t * 0.7) }, ...PHYS.torso, ouSigmaX: PHYS.torso.ouSigma.x, ouSigmaY: PHYS.torso.ouSigma.y, ouSigmaZ: PHYS.torso.ouSigma.z });
            driveBone(VRMHumanBoneName.Head, VRMHumanBoneName.Neck, { baseOffset: { x: micro * Math.sin(t * 1.6) + 0.05 * talk * Math.sin(t * 2.9), y: micro * Math.sin(t * 1.1) + 0.04 * talk * Math.sin(t * 3.3), z: micro * Math.sin(t * 0.8) }, ...PHYS.head, ouSigmaX: PHYS.head.ouSigma.x, ouSigmaY: PHYS.head.ouSigma.y, ouSigmaZ: PHYS.head.ouSigma.z });
            driveBone(VRMHumanBoneName.LeftUpperArm, null, { baseOffset: { x: -0.08 * talk + micro * Math.sin(t * 0.75), y: 0.02 * Math.sin(t * 0.70 + 0.7) + 0.03 * talk * Math.sin(t * 1.7 + 0.3), z: 0.01 * talk * Math.sin(t * 1.9) + 0.006 * Math.sin(t * 0.95) }, ...PHYS.upperArm, ouSigmaX: PHYS.upperArm.ouSigma.x, ouSigmaY: PHYS.upperArm.ouSigma.y, ouSigmaZ: PHYS.upperArm.ouSigma.z });
            driveBone(VRMHumanBoneName.RightUpperArm, null, { baseOffset: { x: -0.08 * talk + micro * Math.sin(t * 0.80), y: -0.02 * Math.sin(t * 0.70 + 0.7) - 0.03 * talk * Math.sin(t * 1.7 + 0.3), z: -(0.01 * talk * Math.sin(t * 1.9)) - 0.006 * Math.sin(t * 0.95) }, ...PHYS.upperArm, ouSigmaX: PHYS.upperArm.ouSigma.x, ouSigmaY: PHYS.upperArm.ouSigma.y, ouSigmaZ: PHYS.upperArm.ouSigma.z });
            driveBone(VRMHumanBoneName.LeftLowerArm, null, { baseOffset: { x: -0.12 * talk * (0.6 + 0.4 * Math.sin(t * 4.2)), y: 0.018 * Math.sin(t * 0.95 + 1.2) + 0.025 * talk * Math.sin(t * 3.0 + 0.9), z: 0.01 * Math.sin(t * 0.85 + 0.2) }, ...PHYS.lowerArm, ouSigmaX: PHYS.lowerArm.ouSigma.x, ouSigmaY: PHYS.lowerArm.ouSigma.y, ouSigmaZ: PHYS.lowerArm.ouSigma.z });
            driveBone(VRMHumanBoneName.RightLowerArm, null, { baseOffset: { x: -0.12 * talk * (0.6 + 0.4 * Math.sin(t * 4.2)), y: -0.018 * Math.sin(t * 0.95 + 1.2) - 0.025 * talk * Math.sin(t * 3.0 + 0.9), z: -0.01 * Math.sin(t * 0.85 + 0.2) }, ...PHYS.lowerArm, ouSigmaX: PHYS.lowerArm.ouSigma.x, ouSigmaY: PHYS.lowerArm.ouSigma.y, ouSigmaZ: PHYS.lowerArm.ouSigma.z });
        } else {
            // Sync physics state during GSAP gestures
            [VRMHumanBoneName.Hips, VRMHumanBoneName.Chest, VRMHumanBoneName.Spine, VRMHumanBoneName.Head, VRMHumanBoneName.Neck,
                VRMHumanBoneName.LeftUpperArm, VRMHumanBoneName.RightUpperArm, VRMHumanBoneName.LeftLowerArm, VRMHumanBoneName.RightLowerArm,
                VRMHumanBoneName.LeftHand, VRMHumanBoneName.RightHand, VRMHumanBoneName.LeftUpperLeg, VRMHumanBoneName.RightUpperLeg,
            ].forEach((k) => {
                const b = getVrmBone(k);
                if (!b || !state.vrmBaseRotations || !state.vrmBaseRotations[k]) return;
                ensure(k, state.vrmBaseRotations[k]);
                const st = humanMotion.states[k];
                st.x = b.rotation.x; st.y = b.rotation.y; st.z = b.rotation.z;
                st.vx = 0; st.vy = 0; st.vz = 0;
                humanMotion.targets[k].ox = 0; humanMotion.targets[k].oy = 0; humanMotion.targets[k].oz = 0;
            });
        }

        try { state.vrm.update(dt); } catch {}
        if (window.controls) window.controls.update();
        if (window._earthMesh) window._earthMesh.rotation.y += dt * 0.05;
        if (state.currentHologram) state.currentHologram.rotation.y += dt * 0.5;
        if (window.gameMenu && window.gameMenu.visible) window.gameMenu.position.y = 1.2 + Math.sin(t * 1.5) * 0.015;
        if (window.backMenu && window.backMenu.visible) window.backMenu.position.y = 1.2 + Math.sin(t * 1.5) * 0.015;
        if (state.vrm && state.vrm.scene && !state.vrm.scene._gsapYActive) state.vrm.scene.position.y = 0;

        renderer.render(scene, camera);
    });
}
