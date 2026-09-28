import './style.css';
import { createScene } from './scene.js';
import { probeEngine, generateQuantumShader } from './mothShader.js';
import * as audioEngine from './audioEngine.js';
import { recordCanvas } from './recorder.js';

const canvas = document.getElementById('scene-canvas');
const apiKeyInput = document.getElementById('api-key');
const meshSelect = document.getElementById('geometry-select');
const reflectanceInput = document.getElementById('reflectance');
const absorptionInput = document.getElementById('absorption');
const layersInput = document.getElementById('layers');
const incomingRaysInput = document.getElementById('incoming-rays');
const styleSelect = document.getElementById('style');
const interactionInput = document.getElementById('interaction');
const autoRotateInput = document.getElementById('auto-rotate');
const synthesizeBtn = document.getElementById('synthesize-btn');
const statusBadge = document.getElementById('status-badge');
const statusText = document.getElementById('status-text');
const fpsBadge = document.getElementById('fps-badge');
const errorMsg = document.getElementById('error-msg');

const STORAGE_KEY = 'moth-atlas-api-key';
const ENGINE_RESOLUTION = 60; // fixed; not exposed in the UI

// --- audio dock elements ---
const beatBtn = document.getElementById('beat-btn');
const micBtn = document.getElementById('mic-btn');
const fileBtn = document.getElementById('file-btn');
const fileInput = document.getElementById('file-input');
const sensitivityInput = document.getElementById('sensitivity');
const sensitivityVal = document.getElementById('sensitivity-val');
const audioMsg = document.getElementById('audio-msg');
const meterBass = document.getElementById('m-bass');
const meterMid = document.getElementById('m-mid');
const meterTreble = document.getElementById('m-treble');
const meterEnergy = document.getElementById('m-energy');

// --- record elements ---
const recordBtn = document.getElementById('record-btn');
const recBadge = document.getElementById('rec-badge');
const recRing = document.getElementById('rec-ring');
const recCount = document.getElementById('rec-count');
const RING_CIRCUMFERENCE = 2 * Math.PI * 19;
recRing.style.strokeDasharray = String(RING_CIRCUMFERENCE);

// Latest raw audio reading, refreshed once per animation frame below and
// handed to the scene as-is; the scene does its own smoothing internally.
let latestAudio = { bass: 0, mid: 0, treble: 0, energy: 0 };

const scene = createScene(canvas, {
  onFps: (fps) => {
    fpsBadge.textContent = `${fps} FPS`;
    if (statusBadge.dataset.state === 'compiled') {
      statusText.textContent = `QUANTUM BSDF: SHADER COMPILED (${fps} FPS)`;
    }
  },
  getAudioLevels: () => latestAudio,
});

// --- audio meters / analysis loop (independent of the scene's own rAF) ---
function audioTick() {
  latestAudio = audioEngine.updateAudioData();
  meterBass.style.width = `${latestAudio.bass * 100}%`;
  meterMid.style.width = `${latestAudio.mid * 100}%`;
  meterTreble.style.width = `${latestAudio.treble * 100}%`;
  meterEnergy.style.width = `${latestAudio.energy * 100}%`;
  requestAnimationFrame(audioTick);
}
requestAnimationFrame(audioTick);

function setActiveAudioButton(mode) {
  beatBtn.classList.toggle('active', mode === 'beat');
  micBtn.classList.toggle('active', mode === 'mic');
  fileBtn.classList.toggle('active', mode === 'file');
  beatBtn.textContent = mode === 'beat' ? '⏹ Stop Beat' : '▶ Play Beat';
}

function setAudioError(message) {
  audioMsg.textContent = message || '';
}

beatBtn.addEventListener('click', async () => {
  setAudioError('');
  if (audioEngine.getMode() === 'beat') {
    audioEngine.stop();
    setActiveAudioButton('none');
    return;
  }
  try {
    await audioEngine.playBeat();
    setActiveAudioButton('beat');
  } catch (err) {
    setAudioError(err.message || 'Could not start the demo beat.');
  }
});

micBtn.addEventListener('click', async () => {
  setAudioError('');
  try {
    await audioEngine.startMic();
    setActiveAudioButton('mic');
  } catch (err) {
    setAudioError('Microphone access failed: ' + (err.message || 'permission denied.'));
  }
});

fileBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  setAudioError('');
  try {
    await audioEngine.playFile(file);
    setActiveAudioButton('file');
  } catch (err) {
    setAudioError(err.message || 'Could not play that file.');
  }
  fileInput.value = '';
});

sensitivityInput.addEventListener('input', () => {
  const v = parseFloat(sensitivityInput.value);
  sensitivityVal.textContent = v.toFixed(2);
  audioEngine.setSensitivity(v);
});

// --- 1-click video recorder ---
let recording = false;

recordBtn.addEventListener('click', async () => {
  if (recording) return;
  recording = true;
  recordBtn.disabled = true;
  setAudioError('');

  autoRotateInput.checked = true;
  scene.setAutoRotate(true);
  if (audioEngine.getMode() === 'none') {
    try {
      await audioEngine.playBeat();
      setActiveAudioButton('beat');
    } catch (err) {
      setAudioError(err.message || 'Could not start the demo beat.');
    }
  }

  recBadge.hidden = false;
  recCount.textContent = '15';
  recRing.style.strokeDashoffset = String(RING_CIRCUMFERENCE);

  try {
    await recordCanvas(canvas, 15000, (fraction, msLeft) => {
      recRing.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - fraction));
      recCount.textContent = String(Math.max(0, Math.ceil(msLeft / 1000)));
    }, {
      audioStream: audioEngine.getAudioStream(),
      filename: 'quantum-resonator-showcase.webm',
    });
  } catch (err) {
    setAudioError(err.message || 'Recording failed.');
  } finally {
    recBadge.hidden = true;
    recording = false;
    recordBtn.disabled = false;
  }
});

// --- restore persisted API key ---
const savedKey = localStorage.getItem(STORAGE_KEY);
if (savedKey) apiKeyInput.value = savedKey;
apiKeyInput.addEventListener('input', () => {
  localStorage.setItem(STORAGE_KEY, apiKeyInput.value);
});

// --- controls ---
meshSelect.addEventListener('change', () => scene.setMesh(meshSelect.value));

function bindSlider(input, uniform, decimals = 2) {
  const valueEl = document.getElementById(`${input.id}-val`);
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    if (valueEl) valueEl.textContent = v.toFixed(decimals);
    if (uniform) scene.setUniform(uniform, v);
  });
}
bindSlider(reflectanceInput, 'uReflectance');
bindSlider(absorptionInput, 'uAbsorption');
bindSlider(interactionInput, 'uInteraction');
bindSlider(layersInput, null, 0);
bindSlider(incomingRaysInput, null, 0);

// incoming_rays must stay >= layers
layersInput.addEventListener('input', () => {
  const layers = parseInt(layersInput.value, 10);
  incomingRaysInput.min = String(layers);
  if (parseInt(incomingRaysInput.value, 10) < layers) {
    incomingRaysInput.value = String(layers);
    incomingRaysInput.dispatchEvent(new Event('input'));
  }
});

autoRotateInput.addEventListener('change', () => {
  scene.setAutoRotate(autoRotateInput.checked);
});

// --- status badge ---
function setStatus(state, text) {
  statusBadge.dataset.state = state;
  statusText.textContent = text;
}

function setError(message) {
  errorMsg.textContent = message || '';
}

const STATUS_LABELS = {
  submitting: 'QUANTUM BSDF: SUBMITTING JOB...',
  running: 'QUANTUM BSDF: RUNNING UNITARY CIRCUITS...',
  'fetching-result': 'QUANTUM BSDF: FETCHING RESULT...',
  downloading: 'QUANTUM BSDF: DOWNLOADING SHADER...',
};

// --- probe the engine schema once a key is available, non-blocking ---
if (savedKey) {
  probeEngine(savedKey)
    .then((schema) => {
      console.log('[Moth Atlas] entanglement-shader-v1 schema:', schema);
    })
    .catch((err) => {
      console.warn('[Moth Atlas] engine probe failed (fallback shader remains active):', err.message);
    });
}

function collectParams() {
  return {
    reflectance: parseFloat(reflectanceInput.value),
    absorption: parseFloat(absorptionInput.value),
    layers: parseInt(layersInput.value, 10),
    incoming_rays: parseInt(incomingRaysInput.value, 10),
    style: styleSelect.value,
    interaction: parseFloat(interactionInput.value),
    resolution: ENGINE_RESOLUTION,
  };
}

// --- synthesize button ---
let inFlight = false;

synthesizeBtn.addEventListener('click', async () => {
  if (inFlight) return;
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    setError('Enter a Moth Atlas API key first.');
    return;
  }

  inFlight = true;
  synthesizeBtn.disabled = true;
  setError('');
  setStatus('running', 'QUANTUM BSDF: RUNNING UNITARY CIRCUITS...');

  try {
    const shaderData = await generateQuantumShader(apiKey, collectParams(), {
      onStatus: (phase) => setStatus('running', STATUS_LABELS[phase] || STATUS_LABELS.running),
    });
    scene.applyQuantumShader(shaderData);
    setStatus('compiled', 'QUANTUM BSDF: SHADER COMPILED');
  } catch (err) {
    console.error('[Moth Atlas] synthesis failed:', err);
    setStatus('error', 'QUANTUM BSDF: ERROR — USING FALLBACK');
    setError(err.message || 'Unknown error contacting Moth Atlas.');
    scene.resetToFallback();
  } finally {
    inFlight = false;
    synthesizeBtn.disabled = false;
  }
});

setStatus('idle', 'QUANTUM BSDF: IDLE');
