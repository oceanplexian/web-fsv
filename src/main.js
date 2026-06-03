import * as THREE from '/vendor/three/build/three.module.js';
import { OrbitControls } from '/vendor/three/examples/jsm/controls/OrbitControls.js';
import { buildLayout } from './layout.js';
import { buildScene } from './scene.js';
import { makeSky, makeGround } from './sky.js';
import { preloadCharset } from './labels.js';
import { makeHalo, positionHalo } from './halo.js';
import { colorForHaEntity } from './colors.js';

const $ = (sel) => document.querySelector(sel);
const status = (msg) => { $('#status').textContent = msg; };

// Pre-load sound effects so playback is immediate. Each play() clones the
// buffer so back-to-back nav clicks don't cut each other off.
const sfx = {
  nav: new Audio('/assets/sounds/beep_low_shifted.mp3'),
  toggle: new Audio('/assets/sounds/beep_low.mp3'),
};
for (const a of Object.values(sfx)) { a.preload = 'auto'; a.volume = 0.18; }
function playSfx(name) {
  const src = sfx[name];
  if (!src) return;
  const a = src.cloneNode();
  a.volume = src.volume;
  a.play().catch(() => {}); // ignore autoplay-block errors
}

// Background music — gapless looped with crossfade. Browsers gate audio behind
// a user gesture, so we kick off on the first interaction of any kind.
const BG_URL = '/assets/sounds/background_96k.mp3';
const BG_VOL = 0.25;
const BG_XFADE_S = 3.0;
let bgCtx = null, bgBuf = null, bgStarted = false;

// Pre-load the buffer immediately. Playback waits until the context becomes
// runnable (either it was already, or a user gesture resumes it).
async function initBg() {
  if (bgCtx) return;
  bgCtx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const r = await fetch(BG_URL);
    const arr = await r.arrayBuffer();
    bgBuf = await bgCtx.decodeAudioData(arr);
    console.log(`[bg] loaded ${bgBuf.duration.toFixed(1)}s, ctx=${bgCtx.state}`);
  } catch (e) { console.error('[bg] load failed:', e); }
}

async function startBg() {
  if (bgStarted) return;
  if (!bgCtx) await initBg();
  if (!bgBuf) return;
  if (bgCtx.state === 'suspended') {
    try { await bgCtx.resume(); } catch {}
    if (bgCtx.state !== 'running') { console.log('[bg] still suspended, waiting for gesture'); return; }
  }
  bgStarted = true;
  console.log('[bg] starting');
  scheduleBgIteration(bgCtx.currentTime + 0.05);
  // If audio was allowed without a gesture (site sound permission granted),
  // the splash never blocked anything — drop it automatically.
  document.getElementById('splash')?.classList.add('hidden');
  setTimeout(() => document.getElementById('splash')?.remove(), 700);
}

function scheduleBgIteration(startAt) {
  if (!bgCtx || !bgBuf) return;
  const src = bgCtx.createBufferSource();
  src.buffer = bgBuf;
  const gain = bgCtx.createGain();
  src.connect(gain).connect(bgCtx.destination);
  const dur = bgBuf.duration;
  const xf = Math.min(BG_XFADE_S, dur / 3);
  gain.gain.setValueAtTime(0, startAt);
  gain.gain.linearRampToValueAtTime(BG_VOL, startAt + xf);
  gain.gain.setValueAtTime(BG_VOL, startAt + dur - xf);
  gain.gain.linearRampToValueAtTime(0, startAt + dur);
  src.start(startAt);
  src.stop(startAt + dur + 0.05);
  // Overlap: next iteration begins during the fadeout of this one.
  const nextStart = startAt + dur - xf;
  setTimeout(() => scheduleBgIteration(nextStart),
             Math.max(0, (dur - xf - 1) * 1000));
}

// Splash-screen Enter button handles the gesture for us. Also retry on any
// interaction in case the splash was already dismissed (e.g. on refresh after
// the user granted site sound permission).
const splash = document.getElementById('splash');
const splashBtn = document.getElementById('splashEnter');
function dismissSplash() {
  if (!splash) return;
  splash.classList.add('hidden');
  setTimeout(() => splash.remove(), 700);
  startBg();
}
splashBtn?.addEventListener('click', dismissSplash);
window.addEventListener('keydown', e => {
  if (splash && !splash.classList.contains('hidden') &&
      (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape')) {
    dismissSplash();
  }
});
// Try to autoplay on load — works after Chrome's "allow sound" site permission.
startBg();

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 4000);
camera.position.set(40, 30, 50);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
// Lower damping = camera trails behind the mouse on right-drag rotate, giving
// the rotation that weighty "I'm dragging mass" feel from real fsv.
controls.dampingFactor = 0.008;
controls.rotateSpeed = 0.55;
controls.zoomSpeed = 0.6;
controls.target.set(0, 2, 0);
controls.maxPolarAngle = Math.PI / 2 - 0.02;
controls.minDistance = 2;
controls.maxDistance = 1500;
// Left drag is reserved for our fsv-style "fly" gesture. Right drag still
// orbits, mouse wheel zooms.
controls.mouseButtons = {
  LEFT: null,
  MIDDLE: THREE.MOUSE.DOLLY,
  RIGHT: THREE.MOUSE.ROTATE,
};

scene.add(makeSky());
scene.add(makeGround());

// Dark Jurassic-Park-FSN scene: a single warm rim light + a low ambient so
// platforms read as solid coral / cyan against the black ground.
const sun = new THREE.DirectionalLight(0xfff0d8, 1.0);
sun.position.set(40, 80, 30);
scene.add(sun);
scene.add(new THREE.AmbientLight(0xffffff, 0.45));
scene.add(new THREE.HemisphereLight(0x1a3018, 0x000000, 0.25));

// Persistent selection halo (re-positioned per click).
const halo = makeHalo();
scene.add(halo);

let currentSceneGroup = null;
let pickables = [];
let cameraAnim = null;
let tour = null;            // active cinematic auto-flyby (curved, looping)
let tourEnabled = false;    // whether to start the tour on load (see init)
let selectedBox = null;
let currentRootData = null;
let currentRootPath = null;
let currentLayout = null;
let expandInFlight = new Set(); // absPaths currently being fetched

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

function clearScene(preserveCamera = false) {
  if (!currentSceneGroup) return;
  scene.remove(currentSceneGroup);
  currentSceneGroup.traverse(o => {
    if (o.geometry && o.geometry !== sharedGeoCache) o.geometry.dispose?.();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) { m.map?.dispose?.(); m.dispose?.(); }
    }
  });
  currentSceneGroup = null;
  pickables = [];
  if (!preserveCamera) {
    selectedBox = null;
    halo.visible = false;
  }
}
const sharedGeoCache = new THREE.BoxGeometry(1, 1, 1);

// Walks the scanned tree adding `_absPath` to every node so we can re-fetch
// its subtree later when the user expands a truncated directory.
function attachAbsPaths(node, parentAbsPath, isRoot=false) {
  node._absPath = isRoot ? parentAbsPath : `${parentAbsPath}/${node.name}`.replace(/\/+/g, '/');
  for (const c of node.children || []) attachAbsPaths(c, node._absPath);
}

function rebuildSceneFromTree(preserveCamera = false) {
  const layout = buildLayout(currentRootData);
  currentLayout = layout;
  clearScene(preserveCamera);
  const { group, pickables: p } = buildScene(layout);
  currentSceneGroup = group;
  pickables = p;
  scene.add(group);
  return layout;
}

async function loadAndRender(targetPath, maxDepth = 2) {
  await preloadCharset();
  status(`Scanning ${targetPath}…`);
  const url = `/scan?path=${encodeURIComponent(targetPath)}&maxDepth=${maxDepth}&maxEntries=20000`;
  const t0 = performance.now();
  let payload;
  try {
    const r = await fetch(url);
    payload = await r.json();
    if (!r.ok || payload.error) throw new Error(payload.error || `HTTP ${r.status}`);
  } catch (e) {
    status(`Scan failed: ${e.message}`);
    return;
  }
  const tScan = ((performance.now() - t0) / 1000).toFixed(2);
  status(`Laying out ${payload.scanned} entries…`);

  currentRootData = payload.tree;
  currentRootPath = payload.root;
  attachAbsPaths(currentRootData, currentRootPath, true);

  const layout = rebuildSceneFromTree();

  if (tourEnabled) {
    // Cinematic auto-flyby instead of a static frame. Plays until the first
    // canvas click / scroll / arrow-key (see stopTour).
    startTour();
  } else {
    const root = layout.boxes[0];
    const cx = root.x + root.w / 2, cz = root.z + root.d / 2;
    // Cinematic framing: pulled back enough to read the surrounding rooms, with
    // a low ~14° elevation so the horizon sits near the top of the viewport.
    const span = Math.max(root.w, root.d) * 1.1;
    flyCamera(
      new THREE.Vector3(cx, span * 0.6, cz + span * 2.4),
      new THREE.Vector3(cx, root.yBase + root.height * 0.5, cz),
      2.4,
    );
  }

  status(
    `${payload.root}  ·  ${payload.scanned} entries  ·  scan ${tScan}s` +
    (payload.truncated ? '  · TRUNCATED' : '')
  );
}

function layoutBounds(boxes) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const b of boxes) {
    if (b.x < minX) minX = b.x;
    if (b.x + b.w > maxX) maxX = b.x + b.w;
    if (b.z < minZ) minZ = b.z;
    if (b.z + b.d > maxZ) maxZ = b.z + b.d;
  }
  return Math.max(maxX - minX, maxZ - minZ);
}

function flyCamera(toPos, toTarget, durationSec = 1.2) {
  tour = null;          // any deliberate camera move ends the auto-flyby
  _flyVel.set(0, 0, 0); // canned flight overrides any inertial coast
  cameraAnim = {
    fromPos: camera.position.clone(),
    toPos: toPos.clone(),
    fromTarget: controls.target.clone(),
    toTarget: toTarget.clone(),
    start: performance.now(),
    duration: durationSec * 1000,
  };
}

function tickCameraAnim(now) {
  if (!cameraAnim) return;
  let t = (now - cameraAnim.start) / cameraAnim.duration;
  if (t >= 1) t = 1;
  // ease in-out cubic
  const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  camera.position.lerpVectors(cameraAnim.fromPos, cameraAnim.toPos, e);
  controls.target.lerpVectors(cameraAnim.fromTarget, cameraAnim.toTarget, e);
  if (t === 1) cameraAnim = null;
}

// ---- Cinematic auto-flyby tour --------------------------------------------
// A smooth, looping CatmullRom orbit whose radius AND height oscillate around
// the loop, so the camera swoops in and out / rises and dips instead of tracing
// a flat circle — a curved, dramatic flythrough. Runs until the first user
// interaction (canvas click, scroll, or arrow keys).
function startTour() {
  if (!currentLayout || !currentLayout.boxes.length) { tour = null; return; }
  const root = currentLayout.boxes[0];
  const cx = root.x + root.w / 2, cz = root.z + root.d / 2;
  const span = Math.max(layoutBounds(currentLayout.boxes), 20);
  const yLook = root.yBase + root.height * 0.5;
  const N = 8;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const t = i / N;
    const a = Math.PI / 2 + t * Math.PI * 2;                      // begin at the front (+z)
    // Low, zoomed-in weave: start close to the root and skim just above the
    // platforms, swinging a little farther + higher around the back and
    // returning. Much tighter and lower than a wide overview orbit.
    const r = span * (0.38 - 0.12 * Math.cos(t * Math.PI * 2));   // ~0.26..0.50 span — close in
    const h = span * (0.09 - 0.04 * Math.cos(t * Math.PI * 2));   // ~0.05..0.13 span — low altitude
    pts.push(new THREE.Vector3(cx + Math.cos(a) * r, yLook + h, cz + Math.sin(a) * r));
  }
  const curve = new THREE.CatmullRomCurve3(pts, true, 'catmullrom', 0.5);
  cameraAnim = null;
  _flyVel.set(0, 0, 0);
  tour = { curve, lookAt: new THREE.Vector3(cx, yLook, cz), start: performance.now(), duration: 36 };
}

function stopTour() {
  tour = null;
}

function tickTour(now) {
  if (!tour) return;
  const u = ((now - tour.start) / 1000 / tour.duration) % 1; // looped, arc-length param
  camera.position.copy(tour.curve.getPointAt(u));
  controls.target.copy(tour.lookAt);
}

function pickBoxAt(clientX, clientY) {
  mouse.x = (clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObjects(pickables, false);
  return hits.length ? hits[0].object.userData.box : null;
}

// Distance-based duration so short hops feel snappy and big jumps glide. Same
// idea as fsv's MAPV_CAMERA_MIN_PAN_TIME / _MAX_PAN_TIME (camera.c:40-41).
const PAN_MIN_S = 2.2;
const PAN_MAX_S = 5.0;
function panDuration(fromTarget, toTarget) {
  const d = fromTarget.distanceTo(toTarget);
  return Math.max(PAN_MIN_S, Math.min(PAN_MAX_S, PAN_MIN_S + d / 60));
}

// Preserves the camera's current direction & distance from its target — the
// view "slides" to the new node instead of orbiting around to the canonical
// FSN angle every time.
function flyToBox(b) {
  const cx = b.x + b.w / 2, cz = b.z + b.d / 2;
  const cy = b.yBase + b.height;
  const newTarget = new THREE.Vector3(cx, cy, cz);
  const offset = camera.position.clone().sub(controls.target);
  flyCamera(newTarget.clone().add(offset), newTarget, panDuration(controls.target, newTarget));
}

// 'R' — reset camera to right-side-up FSN angle while preserving the current
// target and zoom distance.
const FSN_DIR = new THREE.Vector3(0, 0.5, 0.866); // straight-on, 30° elevation
let lastEscAt = 0;

// Cinematic default framing — same as the initial view on page load.
function frameDefault(durationSec = 2.0) {
  if (!currentLayout || !currentLayout.boxes.length) return;
  const root = currentLayout.boxes[0];
  const cx = root.x + root.w / 2, cz = root.z + root.d / 2;
  const span = Math.max(root.w, root.d) * 1.1;
  flyCamera(
    new THREE.Vector3(cx, span * 0.6, cz + span * 2.4),
    new THREE.Vector3(cx, root.yBase + root.height * 0.5, cz),
    durationSec,
  );
  selectedBox = null;
  halo.visible = false;
}

function frameRoot(durationSec = 1.6) {
  if (!currentLayout || !currentLayout.boxes.length) return;
  const root = currentLayout.boxes[0];
  const cx = root.x + root.w / 2, cz = root.z + root.d / 2;
  const span = Math.max(root.w, root.d) * 1.1;
  flyCamera(
    new THREE.Vector3(cx, span * 0.5, cz + span * 0.866),
    new THREE.Vector3(cx, root.yBase + root.height * 0.5, cz),
    durationSec,
  );
  selectedBox = root;
  positionHalo(halo, root);
}

function findParentNode(root, target) {
  for (const c of root.children || []) {
    if (c === target) return root;
    const r = findParentNode(c, target);
    if (r) return r;
  }
  return null;
}

function boxForNode(node) {
  if (!currentLayout || !node) return null;
  return currentLayout.boxes.find(b => b.kind === 'platform' && b.node === node) || null;
}

function navigateToNode(node) {
  const b = boxForNode(node);
  if (!b) return;
  selectedBox = b;
  positionHalo(halo, b);
  flyToBox(b);
}

// Spatial arrow nav: pick the platform whose screen-space position is most
// strongly in the pressed direction relative to the currently-selected box.
const _projVec = new THREE.Vector3();
function projectToScreen(b) {
  _projVec.set(b.x + b.w / 2, b.yBase + b.height, b.z + b.d / 2);
  _projVec.project(camera);
  return { x: _projVec.x, y: _projVec.y };
}
function navigateArrow(key) {
  if (!currentLayout) return;
  if (!selectedBox) { playSfx('nav'); frameRoot(); return; }
  const dir = { ArrowRight: [1,0], ArrowLeft: [-1,0], ArrowUp: [0,1], ArrowDown: [0,-1] }[key];
  if (!dir) return;
  const here = projectToScreen(selectedBox);
  let best = null, bestScore = Infinity;
  for (const b of currentLayout.boxes) {
    if (b.kind !== 'platform' || b === selectedBox) continue;
    const p = projectToScreen(b);
    const dx = p.x - here.x, dy = p.y - here.y;
    // Forward = component along pressed dir; perp = component across it.
    const forward = dx * dir[0] + dy * dir[1];
    if (forward <= 0) continue; // must be on the side of the pressed direction
    const perp = Math.abs(dx * -dir[1] + dy * dir[0]);
    // Weighted distance: penalize off-axis more than on-axis, so a slightly
    // diagonal but much closer neighbor still wins.
    const score = forward + perp * 2.5;
    if (score < bestScore) { bestScore = score; best = b; }
  }
  if (best) {
    playSfx('nav');
    selectedBox = best;
    positionHalo(halo, best);
    flyOver(best);
  }
}

// Like flyToBox, but resize the camera distance to fit the new box. Preserves
// the current viewing *direction* so arrow nav doesn't snap to top-down.
function flyOver(b) {
  const cx = b.x + b.w / 2, cz = b.z + b.d / 2;
  const cy = b.yBase + b.height;
  const newTarget = new THREE.Vector3(cx, cy, cz);
  // Pull back generously so neighboring platforms remain in frame — better
  // for arrow-key cycling than tight per-folder framing.
  const frame = Math.min(80, Math.max(b.w, b.d) * 3.0 + 6);
  const fov = camera.fov * Math.PI / 180;
  const dist = (frame / 2) / Math.tan(fov / 2);
  const dir = camera.position.clone().sub(controls.target);
  if (dir.lengthSq() < 1e-6) dir.set(0, 1, 1);
  dir.normalize();
  flyCamera(newTarget.clone().add(dir.multiplyScalar(dist)), newTarget, panDuration(controls.target, newTarget));
}

window.addEventListener('keydown', (ev) => {
  if (ev.target && ['INPUT', 'TEXTAREA'].includes(ev.target.tagName)) return;
  if (ev.key === 'r' || ev.key === 'R') {
    const dist = camera.position.distanceTo(controls.target);
    const target = controls.target.clone();
    flyCamera(target.clone().add(FSN_DIR.clone().multiplyScalar(dist)), target, 1.4);
    return;
  }
  if (ev.key === 'Escape') {
    ev.preventDefault();
    const now = performance.now();
    if (now - lastEscAt < 500) {
      frameDefault();
      lastEscAt = 0;
    } else {
      playSfx('nav');
      frameRoot();
      lastEscAt = now;
    }
    return;
  }
  if (ev.key === 'Enter') {
    ev.preventDefault();
    if (selectedBox) {
      playSfx('toggle');
      flyTopDown(selectedBox);
    }
    return;
  }
  if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown' ||
      ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
    ev.preventDefault();
    navigateArrow(ev.key);
    return;
  }
});

// Left-drag = fly. Quick-tap (no drag) = click-to-fly to node under cursor.
const FLY_CLICK_PX = 4;          // dragged less than this = treat as a click
const FLY_SPEED = 0.032;         // world units / second / pixel of drag
let dragStart = null, dragNow = null, dragMoved = 0;
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _move = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

// Any interaction with the scene (click, drag, right-drag, scroll) ends the
// auto-flyby and hands control to the user.
renderer.domElement.addEventListener('pointerdown', stopTour);
renderer.domElement.addEventListener('wheel', stopTour, { passive: true });

renderer.domElement.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return;
  dragStart = { x: ev.clientX, y: ev.clientY };
  dragNow   = { x: ev.clientX, y: ev.clientY };
  dragMoved = 0;
  renderer.domElement.setPointerCapture(ev.pointerId);
});

// Hover outline: a white wireframe cube reused across hovered boxes.
const hoverOutline = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
  new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false }),
);
hoverOutline.renderOrder = 998;
hoverOutline.visible = false;
scene.add(hoverOutline);

function setHoverBox(b) {
  if (!b) { hoverOutline.visible = false; return; }
  hoverOutline.scale.set(b.w * 1.01, b.height * 1.01, b.d * 1.01);
  hoverOutline.position.set(b.x + b.w / 2, b.yBase + b.height / 2, b.z + b.d / 2);
  hoverOutline.visible = true;
}

renderer.domElement.addEventListener('pointermove', (ev) => {
  if (dragStart) {
    dragNow = { x: ev.clientX, y: ev.clientY };
    const d = Math.hypot(dragNow.x - dragStart.x, dragNow.y - dragStart.y);
    if (d > dragMoved) dragMoved = d;
  }
  if (dragStart && dragMoved >= FLY_CLICK_PX) { setHoverBox(null); return; }
  setHoverBox(pickBoxAt(ev.clientX, ev.clientY));
});
renderer.domElement.addEventListener('pointerleave', () => setHoverBox(null));

// Defer single-click action so a dblclick can cancel it cleanly.
let pendingClick = null;
const CLICK_VS_DBL_DELAY = 220;

function flyTopDown(b) {
  const cx = b.x + b.w / 2, cz = b.z + b.d / 2;
  const cy = b.yBase + b.height;
  // Cap framed extent so a huge folder doesn't fly the camera into orbit;
  // instead we frame a 35-unit "section" of the folder you can pan around in.
  const frame = Math.min(60, Math.max(b.w, b.d) * 1.9 + 4);
  const fov = camera.fov * Math.PI / 180;
  const dist = (frame / 2) / Math.tan(fov / 2);
  const newTarget = new THREE.Vector3(cx, cy, cz);
  // Tiny z-offset so the camera isn't perfectly perpendicular (avoids
  // OrbitControls gimbal weirdness on subsequent rotations).
  const newPos = new THREE.Vector3(cx, cy + dist, cz + dist * 0.04);
  flyCamera(newPos, newTarget, panDuration(controls.target, newTarget));
}

async function expandNode(node) {
  if (!node || !node.truncated || expandInFlight.has(node._absPath)) return null;
  expandInFlight.add(node._absPath);
  status(`Loading ${node.name}…`);
  try {
    const r = await fetch(`/scan?path=${encodeURIComponent(node._absPath)}&maxDepth=2&maxEntries=10000`);
    const payload = await r.json();
    if (!r.ok || payload.error) throw new Error(payload.error || `HTTP ${r.status}`);
    // Splice fetched children in and clear truncated flag.
    node.children = payload.tree.children || [];
    node.totalSize = payload.tree.totalSize || node.totalSize;
    node.truncated = !!payload.truncated;
    for (const c of node.children) attachAbsPaths(c, node._absPath);
    rebuildSceneFromTree(true);
    status(`Expanded ${node.name}  ·  +${payload.scanned} entries`);
    // Find the new box for this node so caller can re-target the camera.
    return currentLayout.boxes.find(b => b.node === node) || null;
  } catch (e) {
    status(`Expand failed: ${e.message}`);
    return null;
  } finally {
    expandInFlight.delete(node._absPath);
  }
}

renderer.domElement.addEventListener('pointerup', (ev) => {
  if (ev.button !== 0 || !dragStart) return;
  try { renderer.domElement.releasePointerCapture(ev.pointerId); } catch {}
  if (dragMoved < FLY_CLICK_PX) {
    const x = ev.clientX, y = ev.clientY;
    if (pendingClick) clearTimeout(pendingClick);
    pendingClick = setTimeout(async () => {
      pendingClick = null;
      let b = pickBoxAt(x, y);
      if (b && b.kind === 'platform' && b.node.truncated) {
        const newBox = await expandNode(b.node);
        if (newBox) b = newBox;
      }
      if (b && b.kind === 'platform' && b !== selectedBox) playSfx('nav');
      selectedBox = b;
      positionHalo(halo, b);
      if (b) flyToBox(b);
    }, CLICK_VS_DBL_DELAY);
  }
  dragStart = null;
  dragNow = null;
});

// Flashes pulse the mesh's emissive color toward white, decaying each frame.
const flashing = new Set();
function flashBox(box, color = 0xffffff, durationMs = 600) {
  if (!box || !box.mesh) return;
  box.mesh.userData.flash = {
    color: new THREE.Color(color),
    start: performance.now(),
    duration: durationMs,
  };
  flashing.add(box);
}
function tickFlashes(now) {
  for (const box of flashing) {
    const m = box.mesh;
    const f = m?.userData.flash;
    if (!f) { flashing.delete(box); continue; }
    const t = (now - f.start) / f.duration;
    if (t >= 1) {
      m.material.emissive.setHex(0x000000);
      m.userData.flash = null;
      flashing.delete(box);
      continue;
    }
    // Sharp attack, exponential decay.
    const k = (1 - t) * Math.exp(-3 * t);
    m.material.emissive.copy(f.color).multiplyScalar(k);
  }
}

function recolorBoxFromState(box) {
  if (!box || !box.mesh || !box.node?.haEntityId) return;
  const c = colorForHaEntity(box.node);
  box.color = c;
  box.mesh.material.color.setHex(c);
}

// Optimistic predicted-next-state for instant UI feedback on toggle.
function predictNextState(s) {
  const cur = String(s ?? '').toLowerCase();
  if (cur === 'on')   return 'off';
  if (cur === 'off')  return 'on';
  if (cur === 'open') return 'closed';
  if (cur === 'closed') return 'open';
  if (cur === 'locked') return 'unlocked';
  if (cur === 'unlocked') return 'locked';
  if (cur === 'playing') return 'paused';
  if (cur === 'paused')  return 'playing';
  if (cur === 'docked')  return 'cleaning';
  // unknown / unavailable / scene timestamp — assume "on" so user sees feedback.
  return 'on';
}

async function toggleEntity(node) {
  const box = currentLayout?.boxes.find(b => b.node === node) || null;
  flashBox(box, 0xffffff, 700);
  playSfx('toggle');

  // Optimistic update — flip state and recolor immediately. Reconciled below
  // (and again on the next /ha/states poll) once HA confirms.
  const prevState = node.haState;
  node.haState = predictNextState(prevState);
  recolorBoxFromState(box);
  status(`Toggling ${node.name}…`);

  try {
    const r = await fetch(`/ha/toggle?entity=${encodeURIComponent(node.haEntityId)}`, { method: 'POST' });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
    try {
      const states = JSON.parse(j.response);
      const updated = Array.isArray(states) ? states.find(s => s.entity_id === node.haEntityId) : null;
      if (updated && updated.state !== node.haState) {
        node.haState = updated.state;
        recolorBoxFromState(box);
      }
    } catch {}
    status(`✓ ${node.haEntityId} → ${node.haState}`);
  } catch (e) {
    // Roll back optimistic flip on failure.
    node.haState = prevState;
    recolorBoxFromState(box);
    status(`Toggle failed: ${e.message}`);
  }
}

renderer.domElement.addEventListener('dblclick', async (ev) => {
  if (pendingClick) { clearTimeout(pendingClick); pendingClick = null; }
  let b = pickBoxAt(ev.clientX, ev.clientY);
  if (!b) return;
  // HA entity tile — toggle instead of zooming. Selection still updates.
  if (b.kind === 'file' && b.node.haEntityId) {
    selectedBox = b;
    positionHalo(halo, b);
    toggleEntity(b.node);
    return;
  }
  if (b.kind === 'platform' && b.node.truncated) {
    const newBox = await expandNode(b.node);
    if (newBox) b = newBox;
  }
  selectedBox = b;
  positionHalo(halo, b);
  flyTopDown(b);
});

// Inertial velocity carried over after the user releases a fly drag — gives
// the camera a cinematic "coast" instead of stopping dead.
const _flyVel = new THREE.Vector3();
const FLY_FRICTION = 1.4; // higher = stops sooner. ~0.5s to a near-halt.

function applyDragFly(dt) {
  const dtS = dt / 1000;
  if (dragStart && dragNow && dragMoved >= FLY_CLICK_PX) {
    // Cancel any auto-fly so user input wins.
    cameraAnim = null;
    const dx = dragNow.x - dragStart.x;
    const dy = dragNow.y - dragStart.y;
    camera.getWorldDirection(_fwd);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
    _fwd.normalize();
    _right.crossVectors(_fwd, _up).normalize();
    // Velocity (units / sec) — per-frame movement is velocity * dtS.
    const fwdRate   = -dy * FLY_SPEED;
    const rightRate =  dx * FLY_SPEED;
    _flyVel.copy(_fwd).multiplyScalar(fwdRate).addScaledVector(_right, rightRate);
    _move.copy(_flyVel).multiplyScalar(dtS);
    camera.position.add(_move);
    controls.target.add(_move);
  } else if (_flyVel.lengthSq() > 1e-6) {
    // Coast: exponential friction.
    _move.copy(_flyVel).multiplyScalar(dtS);
    camera.position.add(_move);
    controls.target.add(_move);
    const decay = Math.exp(-FLY_FRICTION * dtS);
    _flyVel.multiplyScalar(decay);
    if (_flyVel.lengthSq() < 1e-4) _flyVel.set(0, 0, 0);
  }
}

function formatBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

$('#loadBtn').addEventListener('click', () => {
  const v = $('#pathInput').value.trim();
  if (v) loadAndRender(v);
});
$('#pathInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#loadBtn').click();
});

const haloClock = new THREE.Clock();
function loop() {
  requestAnimationFrame(loop);
  const now = performance.now();
  const dt = haloClock.getDelta() * 1000; // ms
  tickTour(now);
  applyDragFly(dt);
  tickCameraAnim(now);
  tickFlashes(now);

  // Hard-clamp the orbit target above the ground (defense in depth on top of
  // maxPolarAngle, in case panning ever drags it under).
  if (controls.target.y < 0.1) controls.target.y = 0.1;

  controls.update();

  // Animate halo + billboard the floating root title.
  halo.userData.volMat.uniforms.time.value = performance.now() / 1000;
  // Fade halo as the camera tilts toward straight-down — it just reads as a ring.
  if (selectedBox) {
    const dy = camera.position.y - controls.target.y;
    const dxz = Math.hypot(camera.position.x - controls.target.x, camera.position.z - controls.target.z);
    const elevation = Math.atan2(dy, Math.max(dxz, 1e-4)); // rad, 0 = level, π/2 = top-down
    const FADE_START = 55 * Math.PI / 180;
    const FADE_END   = 80 * Math.PI / 180;
    const t = Math.min(1, Math.max(0, (elevation - FADE_START) / (FADE_END - FADE_START)));
    halo.userData.volMat.uniforms.opacity.value = 1 - t;
    halo.visible = t < 1;
  }
  if (currentSceneGroup) {
    currentSceneGroup.traverse(o => {
      if (o.userData?.faceCamera) o.lookAt(camera.position);
    });
  }
  renderer.render(scene, camera);
}
loop();

// Poll HA for state changes and recolor tiles whose state changed. Light flash
// on each change so the user sees the update.
let haPollTimer = null;
async function pollHaStates() {
  try {
    const r = await fetch('/ha/states');
    if (!r.ok) return;
    const map = await r.json();
    if (!currentLayout) return;
    for (const b of currentLayout.boxes) {
      const id = b.node?.haEntityId;
      if (!id) continue;
      const next = map[id];
      if (next == null || next === b.node.haState) continue;
      b.node.haState = next;
      recolorBoxFromState(b);
      flashBox(b, 0x7af0ff, 350); // subtle cyan pulse — distinguishes from user toggle (white)
    }
  } catch {}
}
function startHaPolling() {
  if (haPollTimer) return;
  haPollTimer = setInterval(pollHaStates, 3000);
}

const params = new URLSearchParams(location.search);
const initialDepth = Math.min(8, Math.max(1, +params.get('maxDepth') || 2));

(async () => {
  let source = 'demo';
  try { source = (await (await fetch('/config')).json()).source || 'demo'; } catch {}
  // Auto-flyby tour: on by default in demo mode, off elsewhere. Override with
  // ?tour=1 / ?tour=0.
  const tourParam = params.get('tour');
  tourEnabled = tourParam != null ? tourParam !== '0' : (source === 'demo');
  if (source === 'hass') {
    // Home Assistant mode: rooms are areas, tiles are devices, double-click toggles.
    document.title = 'fsv — Home Assistant';
    $('#pathInput').value = 'Home Assistant';
    $('#pathInput').disabled = true;
    $('#loadBtn').textContent = 'refresh';
    $('#loadBtn').onclick = () => loadAndRender('Home Assistant', initialDepth);
    loadAndRender('Home Assistant', initialDepth);
    startHaPolling();
  } else if (source === 'files') {
    // Local mode (FSV_SOURCE=files): fly through a real directory on the host.
    const initial = params.get('path') || '~';
    $('#pathInput').value = initial;
    loadAndRender(initial, initialDepth);
  } else {
    // Demo mode: the server serves the bundled Isla Nublar / InGen tree and
    // ignores the requested path, so present it as a fixed address.
    document.title = 'fsv — Isla Nublar';
    $('#pathInput').value = 'isla-nublar:/';
    $('#pathInput').readOnly = true;
    $('#loadBtn').textContent = 'replay';
    $('#loadBtn').onclick = () => loadAndRender('isla-nublar:/', initialDepth);
    loadAndRender('isla-nublar:/', initialDepth);
  }
})();
