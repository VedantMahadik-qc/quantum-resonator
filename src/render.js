// Offline renderer: drives the same scene as the live app frame by frame, with
// saved entanglement-shader-v1 results (public/quantum/<style>.zip) as materials
// and pre-analysed audio bands (public/render/bands.json, tools/audio_bands.py).
// tools/render_video.mjs calls window.__frame(i) and screenshots each frame.
import { createScene } from './scene.js';
import { parseShaderZip } from './mothShader.js';

const W = 1920;
const H = 1080;
const FPS = 30;
const MAIN_STYLE = new URLSearchParams(location.search).get('main') || 'frustrated';
const DROP_STYLE = new URLSearchParams(location.search).get('drop2') || 'peaked';
const STYLES = ['peaked', 'frustrated', 'constrained', 'frustrated_neg'];
const STYLE_LABEL = {
  peaked: 'peaked',
  frustrated: 'frustrated',
  constrained: 'constrained',
  frustrated_neg: 'frustrated, interaction −1',
};

// Section starts in Superposition (seconds), from 02_audible/superposition/compose.py.
const S = { build: 6.857, drop1: 20.571, quantum: 27.429, brk: 34.286, build2: 41.143,
            gap: 46.975, drop2: 47.78, end: 60.58, track: 74.58 };
const OUTRO = 6.0;
const TOTAL = S.track + OUTRO;

const $ = (id) => document.getElementById(id);
const scene = createScene($('c'), { manual: true, width: W, height: H });
const bands = (await (await fetch('/render/bands.json')).json()).frames;

const shaders = {};
for (const style of STYLES) {
  try {
    const res = await fetch(`/quantum/${style}.zip`);
    if (res.ok) shaders[style] = await parseShaderZip(await res.arrayBuffer());
  } catch (err) {
    console.warn('no shader for', style, err.message);
  }
}
const loaded = Object.keys(shaders);

let currentStyle = null;
let currentGeo = null;
function useStyle(style) {
  if (!shaders[style]) style = loaded[0];
  if (!style || style === currentStyle) return;
  scene.applyQuantumShader(shaders[style]);
  currentStyle = style;
}
function useGeo(kind) {
  if (kind === currentGeo) return;
  scene.setMesh(kind);
  currentGeo = kind;
}

function plan(t) {
  // Which geometry/material/caption each part of the track gets.
  if (t < S.build) return { geo: 'geodesicSphere', style: MAIN_STYLE, title: true };
  if (t < S.drop1) {
    const i = Math.min(STYLES.length - 1, Math.floor(((t - S.build) / (S.drop1 - S.build)) * STYLES.length));
    return { geo: 'torusknot23', style: STYLES[i], sec: ['BUILD', 'four quantum materials from Atlas'], luts: true };
  }
  if (t < S.quantum) return { geo: 'torusknot35', style: MAIN_STYLE, sec: ['DROP 1', 'bass drives film thickness + ripple'] };
  if (t < S.brk) return { geo: 'torusknot35', style: MAIN_STYLE, sec: ['DROP 1', 'the hook decoheres (Blur Jazz)'] };
  if (t < S.build2) return { geo: 'kleinTorus', style: 'frustrated_neg', sec: ['BREAK', 'Retrocausal Echo takes over'] };
  if (t < S.gap) return { geo: 'quantumIcosahedron', style: 'constrained', sec: ['BUILD 2', '140 → 150 BPM'] };
  if (t < S.drop2) return { geo: 'quantumIcosahedron', style: 'constrained', black: true };
  if (t < S.end) return { geo: 'torusknot35', style: DROP_STYLE, sec: ['FINAL DROP', 'bass thickens the quantum film'] };
  if (t < S.track) return { geo: 'geodesicSphere', style: MAIN_STYLE, sec: ['END', 'the echo carries it out'] };
  return { geo: 'geodesicSphere', style: MAIN_STYLE, outro: true };
}

const ease = (x) => { x = Math.min(Math.max(x, 0), 1); return x * x * (3 - 2 * x); };
let angle = 0.4;
let lutStyle = null;

window.__info = { frames: Math.round(TOTAL * FPS), fps: FPS, loaded, total: TOTAL };

window.__frame = (i) => {
  const t = i / FPS;
  const p = plan(t);
  const lv = bands[Math.min(i, bands.length - 1)] || [0, 0, 0, 0];
  const levels = t < S.track ? { bass: lv[0], mid: lv[1], treble: lv[2], energy: lv[3] }
                             : { bass: 0, mid: 0, treble: 0, energy: 0 };
  useGeo(p.geo);
  useStyle(p.style);

  // Camera: orbit speed follows the energy of each section; drops push in on the bass.
  const hot = (t >= S.drop1 && t < S.brk) || (t >= S.drop2 && t < S.end);
  const speed = hot ? 0.55 : t >= S.build2 && t < S.gap ? 0.25 + 0.6 * (t - S.build2) / (S.gap - S.build2) : 0.18;
  angle += speed / FPS;
  const dist = (t < S.drop1 ? 7.4 - 0.8 * ease((t - S.build) / (S.drop1 - S.build)) : hot ? 6.6 : 7.0)
    - (hot ? levels.bass * 0.45 : 0) + (t >= S.track ? 1.5 * ease((t - S.track) / 2) : 0);
  scene.camera.position.set(Math.sin(angle) * dist, 0.9 + 1.6 * Math.sin(angle * 0.37), Math.cos(angle) * dist);
  scene.camera.lookAt(0, 0, 0);
  const mesh = scene.getMesh();
  mesh.rotation.y += (hot ? 0.012 : 0.004) + levels.energy * 0.01;
  mesh.rotation.x = 0.25 * Math.sin(t * 0.21);
  mesh.visible = !p.black;

  scene.step(1 / FPS, levels);

  // Overlays.
  $('title').style.opacity = p.title ? ease(t / 1.0) * ease((S.build - t) / 0.8) : 0;
  const sec = $('section');
  sec.style.opacity = p.sec ? 1 : 0;
  if (p.sec) { sec.children[0].textContent = p.sec[0]; sec.children[1].textContent = p.sec[1]; }
  $('style').style.opacity = !p.outro && !p.black && currentStyle ? 1 : 0;
  $('style').textContent = currentStyle ? `entanglement-shader-v1 · style: ${STYLE_LABEL[currentStyle]}` : '';
  $('luts').style.opacity = p.luts ? 1 : 0;
  if (p.luts && currentStyle !== lutStyle) {
    $('lutR').src = `/quantum/${currentStyle}_R.png`;
    $('lutT').src = `/quantum/${currentStyle}_T.png`;
    lutStyle = currentStyle;
  }
  const footOn = !p.outro && !p.title && !p.black;
  $('foot').style.opacity = footOn ? 1 : 0;
  $('foot2').style.opacity = footOn ? 1 : 0;
  $('outro').style.opacity = p.outro ? ease((t - S.track) / 1.0) * ease((TOTAL - t) / 1.0) : 0;
  return t;
};

window.__ready = true;
