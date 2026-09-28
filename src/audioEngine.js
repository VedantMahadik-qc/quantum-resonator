// Web Audio analysis engine. Three interchangeable inputs (synthesized demo
// beat, microphone, user file) all feed one AnalyserNode; updateAudioData()
// reduces its spectrum to bass/mid/treble/energy in 0..1.
//
// Routing:
//   source ──► analyser                       (always — drives the visuals)
//   source ──► output ──► speakers            (beat/file only; never the mic,
//                     └──► recordDest          to avoid feedback)

const FFT_SIZE = 512;
const BASS_HZ = [20, 250];
const MID_HZ = [250, 4000];
const TREBLE_HZ = [4000, 16000];

let ctx = null;
let analyser = null;
let output = null;
let recordDest = null;
let freqData = null;
let timeData = null;

let mode = 'none'; // 'none' | 'beat' | 'mic' | 'file'
let stopCurrent = null;
let sensitivity = 1.0;

function ensureContext() {
  if (ctx) return ctx;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  analyser = ctx.createAnalyser();
  analyser.fftSize = FFT_SIZE;
  analyser.smoothingTimeConstant = 0.7;
  freqData = new Uint8Array(analyser.frequencyBinCount);
  timeData = new Uint8Array(analyser.fftSize);

  output = ctx.createGain();
  output.gain.value = 0.9;
  output.connect(ctx.destination);
  recordDest = ctx.createMediaStreamDestination();
  output.connect(recordDest);
  return ctx;
}

async function begin(newMode) {
  ensureContext();
  if (ctx.state === 'suspended') await ctx.resume();
  stop();
  mode = newMode;
}

export function stop() {
  if (stopCurrent) {
    stopCurrent();
    stopCurrent = null;
  }
  mode = 'none';
}

export function getMode() {
  return mode;
}

export function setSensitivity(value) {
  sensitivity = value;
}

// Audio track of whatever is audible (beat/file), for muxing into recordings.
export function getAudioStream() {
  ensureContext();
  return recordDest.stream;
}

// ---------------------------------------------------------------------------
// a) Demo beat: 120 BPM kick / snare / hat / bassline, synthesized with a
//    lookahead scheduler so timing stays tight regardless of frame rate.
// ---------------------------------------------------------------------------

let noiseBuffer = null;
function getNoiseBuffer() {
  if (noiseBuffer) return noiseBuffer;
  noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return noiseBuffer;
}

function playKick(bus, t) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.setValueAtTime(150, t);
  osc.frequency.exponentialRampToValueAtTime(42, t + 0.14);
  gain.gain.setValueAtTime(1.0, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
  osc.connect(gain).connect(bus);
  osc.start(t);
  osc.stop(t + 0.5);

  // Filtered-noise click on the transient for punch.
  const click = ctx.createBufferSource();
  click.buffer = getNoiseBuffer();
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 1200;
  const cg = ctx.createGain();
  cg.gain.setValueAtTime(0.5, t);
  cg.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
  click.connect(lp).connect(cg).connect(bus);
  click.start(t);
  click.stop(t + 0.05);
}

function playSnare(bus, t) {
  const noise = ctx.createBufferSource();
  noise.buffer = getNoiseBuffer();
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1800;
  bp.Q.value = 0.8;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.55, t);
  ng.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
  noise.connect(bp).connect(ng).connect(bus);
  noise.start(t);
  noise.stop(t + 0.22);

  const tone = ctx.createOscillator();
  tone.type = 'triangle';
  tone.frequency.setValueAtTime(220, t);
  const tg = ctx.createGain();
  tg.gain.setValueAtTime(0.35, t);
  tg.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
  tone.connect(tg).connect(bus);
  tone.start(t);
  tone.stop(t + 0.12);
}

function playHat(bus, t, open) {
  const noise = ctx.createBufferSource();
  noise.buffer = getNoiseBuffer();
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 7500;
  const g = ctx.createGain();
  const len = open ? 0.18 : 0.045;
  g.gain.setValueAtTime(open ? 0.22 : 0.16, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + len);
  noise.connect(hp).connect(g).connect(bus);
  noise.start(t);
  noise.stop(t + len + 0.02);
}

function playBass(bus, t, freq, dur) {
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(freq, t);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 6;
  lp.frequency.setValueAtTime(900, t);
  lp.frequency.exponentialRampToValueAtTime(160, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.28, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  osc.connect(lp).connect(g).connect(bus);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

function playPad(bus, t, freqs, dur) {
  for (const f of freqs) {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.05, t + dur * 0.3);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(bus);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }
}

// A minor → F → C → G, one bar each.
const BASS_ROOTS = [55.0, 43.65, 65.41, 49.0];
const PAD_CHORDS = [
  [220.0, 261.63, 329.63],
  [174.61, 220.0, 261.63],
  [196.0, 261.63, 329.63],
  [196.0, 246.94, 293.66],
];
const BASS_PATTERN = [1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0];

const STATIC_TRACK_URL = '/moth-audio.mp3';

// Tries to stream the static Moth track through `bus`; resolves a stop
// function on success, or null if the file is missing/fails to load so the
// caller can fall back to the synthesized beat.
async function tryStaticTrack(bus) {
  // A dev server with no matching static file (e.g. Vite with no public/
  // asset present) commonly answers with a 200 HTML fallback page rather
  // than a 404 — an <audio> element's error event does not reliably fire
  // for that, so check the real content type before ever touching the DOM.
  try {
    const head = await fetch(STATIC_TRACK_URL, { method: 'HEAD' });
    const contentType = head.headers.get('content-type') || '';
    if (!head.ok || !contentType.startsWith('audio/')) return null;
  } catch {
    return null;
  }

  return new Promise((resolve) => {
    const el = new Audio(STATIC_TRACK_URL);
    el.loop = true;
    let settled = false;

    // Belt-and-suspenders: never let playBeat() hang, no matter what the
    // media element does.
    const timeout = setTimeout(() => finish(null), 4000);

    const finish = (stopFn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      el.removeEventListener('canplaythrough', onReady);
      el.removeEventListener('error', onError);
      resolve(stopFn);
    };

    const onReady = async () => {
      try {
        const source = ctx.createMediaElementSource(el);
        source.connect(bus);
        await el.play();
        finish(() => {
          el.pause();
          source.disconnect();
        });
      } catch {
        finish(null);
      }
    };
    const onError = () => finish(null);

    el.addEventListener('canplaythrough', onReady, { once: true });
    el.addEventListener('error', onError, { once: true });
  });
}

export async function playBeat() {
  await begin('beat');

  const bus = ctx.createGain();
  bus.gain.value = 0.8;
  bus.connect(analyser);
  bus.connect(output);

  const fileStop = await tryStaticTrack(bus);
  if (fileStop) {
    stopCurrent = fileStop;
    return;
  }

  // Fallback: no static track available — synthesize the demo beat instead,
  // still through the same bus (so it reaches the analyser identically).
  const bpm = 120;
  const sixteenth = 60 / bpm / 4;
  let step = 0;
  let nextTime = ctx.currentTime + 0.05;

  function schedule() {
    while (nextTime < ctx.currentTime + 0.12) {
      const s = step % 16;
      const bar = Math.floor(step / 16) % 4;
      if (s % 4 === 0) playKick(bus, nextTime);
      if (s === 4 || s === 12) playSnare(bus, nextTime);
      if (s % 2 === 0) playHat(bus, nextTime, s === 14);
      if (BASS_PATTERN[s]) playBass(bus, nextTime, BASS_ROOTS[bar], sixteenth * 2);
      if (s === 0) playPad(bus, nextTime, PAD_CHORDS[bar], sixteenth * 16);
      nextTime += sixteenth;
      step += 1;
    }
  }
  schedule();
  const timer = setInterval(schedule, 25);

  stopCurrent = () => {
    clearInterval(timer);
    const t = ctx.currentTime;
    bus.gain.setValueAtTime(bus.gain.value, t);
    bus.gain.linearRampToValueAtTime(0, t + 0.08);
    setTimeout(() => bus.disconnect(), 150);
  };
}

// ---------------------------------------------------------------------------
// b) Microphone
// ---------------------------------------------------------------------------

export async function startMic() {
  ensureContext(); // create inside the click gesture, before the permission prompt
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  await begin('mic');
  const source = ctx.createMediaStreamSource(stream);
  source.connect(analyser); // analysis only — not routed to speakers
  stopCurrent = () => {
    source.disconnect();
    stream.getTracks().forEach((track) => track.stop());
  };
}

// ---------------------------------------------------------------------------
// c) User audio file
// ---------------------------------------------------------------------------

export async function playFile(file) {
  await begin('file');
  const url = URL.createObjectURL(file);
  const el = new Audio(url);
  el.loop = true;
  const source = ctx.createMediaElementSource(el);
  source.connect(analyser);
  source.connect(output);
  await el.play();
  stopCurrent = () => {
    el.pause();
    source.disconnect();
    URL.revokeObjectURL(url);
  };
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

const SILENT = Object.freeze({ bass: 0, mid: 0, treble: 0, energy: 0 });

function bandAverage([lowHz, highHz]) {
  const binHz = ctx.sampleRate / analyser.fftSize;
  const start = Math.max(1, Math.floor(lowHz / binHz));
  const end = Math.min(freqData.length - 1, Math.ceil(highHz / binHz));
  let sum = 0;
  for (let i = start; i <= end; i++) sum += freqData[i];
  return sum / ((end - start + 1) * 255);
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

export function updateAudioData() {
  if (!ctx || mode === 'none') return SILENT;

  analyser.getByteFrequencyData(freqData);
  analyser.getByteTimeDomainData(timeData);

  let sumSq = 0;
  for (let i = 0; i < timeData.length; i++) {
    const v = (timeData[i] - 128) / 128;
    sumSq += v * v;
  }
  const rms = Math.sqrt(sumSq / timeData.length);

  // Higher bands carry less energy in typical music, so they get more gain.
  return {
    bass: clamp01(bandAverage(BASS_HZ) * 1.1 * sensitivity),
    mid: clamp01(bandAverage(MID_HZ) * 1.6 * sensitivity),
    treble: clamp01(bandAverage(TREBLE_HZ) * 2.8 * sensitivity),
    energy: clamp01(rms * 2.5 * sensitivity),
  };
}
