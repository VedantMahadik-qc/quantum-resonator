import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  iridescentUniforms,
  iridescentVertexShader,
  iridescentFragmentShader,
} from './iridescentShader.js';
import { adaptMothFragmentShader } from './mothShaderAdapter.js';

const GEOMETRIES = {
  torusknot35: () => new THREE.TorusKnotGeometry(1.1, 0.32, 256, 32, 3, 5),
  torusknot23: () => new THREE.TorusKnotGeometry(1.2, 0.38, 200, 32, 2, 3),
  quantumIcosahedron: () => new THREE.IcosahedronGeometry(1.5, 0),
  geodesicSphere: () => new THREE.IcosahedronGeometry(1.6, 2),
  kleinTorus: () => new THREE.TorusGeometry(1.3, 0.55, 32, 100),
};
const DEFAULT_GEOMETRY = 'geodesicSphere';

// Base film thickness (nm) for each material; bass adds up to +350nm on top.
const FALLBACK_THICKNESS = 220.0;
const QUANTUM_THICKNESS = 500.0;
const BASS_THICKNESS_NM = 350.0;
// How far mids push the interference phase (added to uInteraction).
const MID_PHASE_SHIFT = 1.2;
// Exponential smoothing rate (1/s) for audio levels — higher = snappier.
const AUDIO_SMOOTHING = 14.0;
const BLOOM_BASE_STRENGTH = 0.35;

// Vibrant quantum spectral LUT for uRTexture/uTTexture: s (x) is phase,
// t (y) is angle, and both drive periodic interference waves through a
// deep-indigo / electric-cyan / emerald / gold / magenta palette instead of
// flat grayscale.
const SPECTRAL_PALETTE = [
  [0.25, 0.05, 0.55], // deep indigo
  [0.0, 0.85, 0.95], // electric cyan
  [0.05, 0.85, 0.45], // emerald green
  [0.95, 0.75, 0.15], // warm gold
  [0.85, 0.1, 0.65], // magenta
];

function samplePalette(t) {
  const n = SPECTRAL_PALETTE.length;
  const f = (((t % 1) + 1) % 1) * n;
  const i0 = Math.floor(f) % n;
  const i1 = (i0 + 1) % n;
  const frac = f - Math.floor(f);
  const c0 = SPECTRAL_PALETTE[i0];
  const c1 = SPECTRAL_PALETTE[i1];
  return [
    c0[0] + (c1[0] - c0[0]) * frac,
    c0[1] + (c1[1] - c0[1]) * frac,
    c0[2] + (c1[2] - c0[2]) * frac,
  ];
}

function createQuantumSpectralTexture(size = 128, offset = 0) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const t = y / (size - 1); // angle axis
    for (let x = 0; x < size; x++) {
      const s = x / (size - 1); // phase axis
      const i = (y * size + x) * 4;
      const wave = 0.5 + 0.5 * Math.sin(2 * Math.PI * (s * 4 + t * 2));
      const [r, g, b] = samplePalette(wave + s * 0.25 + t * 0.15 + offset);
      data[i] = Math.round(r * 255);
      data[i + 1] = Math.round(g * 255);
      data[i + 2] = Math.round(b * 255);
      data[i + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.needsUpdate = true;
  return texture;
}

// `manual: true` (offline renderer, see render.html) skips the rAF loop and the
// resize handling: the caller drives frames with step(dt, levels) at a fixed size.
export function createScene(canvas, { onFps, getAudioLevels, manual = false, width, height } = {}) {
  const W = width || window.innerWidth;
  const H = height || window.innerHeight;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x030106);
  scene.fog = new THREE.FogExp2(0x030106, 0.05);

  const camera = new THREE.PerspectiveCamera(
    45,
    W / H,
    0.1,
    100
  );
  camera.position.set(0, 0.6, 5.5);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: manual });
  renderer.setPixelRatio(manual ? 1 : Math.min(window.devicePixelRatio, 2));
  renderer.setSize(W, H);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.85;

  // --- studio IBL: gives the BRDF's specular/diffuse terms something to
  // read as "real" lighting instead of hard-coded directional lights only ---
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  pmremGenerator.compileEquirectangularShader();
  const roomEnv = new RoomEnvironment();
  scene.environment = pmremGenerator.fromScene(roomEnv, 0.04).texture;
  pmremGenerator.dispose();

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 1.2;
  controls.minDistance = 2.5;
  controls.maxDistance = 12;

  // --- post-processing: subtle bloom so iridescent fringes glow ---
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(W, H),
    0.35, // strength
    0.35, // radius
    0.88 // threshold — only specular rim highlights should bloom
  );
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass()); // tone mapping + sRGB conversion

  // --- 3-point studio lighting ---
  const keyLight = new THREE.DirectionalLight(0xbfe3ff, 2.2);
  keyLight.position.set(4, 5, 6);
  scene.add(keyLight);

  const rimLight = new THREE.DirectionalLight(0xb78bff, 1.6);
  rimLight.position.set(-5, -2, -4);
  scene.add(rimLight);

  const ambientLight = new THREE.AmbientLight(0x201a33, 1.0);
  scene.add(ambientLight);

  // --- cosmic backdrop (starfield) ---
  scene.add(createStarfield());

  // --- default reflectance/transmittance textures for the quantum shader ---
  const defaultRTexture = createQuantumSpectralTexture(128, 0);
  const defaultTTexture = createQuantumSpectralTexture(128, 0.5);

  // --- central artifact ---
  const uniforms = {
    uTime: { value: 0 },
    uReflectance: iridescentUniforms.uReflectance,
    uAbsorption: iridescentUniforms.uAbsorption,
    uInteraction: iridescentUniforms.uInteraction,
    uCameraPos: { value: camera.position.clone() },
    uAudioBass: { value: 0 },
    uThickness: { value: FALLBACK_THICKNESS },
  };

  // User-set values that audio modulates on top of each frame.
  let thicknessBase = FALLBACK_THICKNESS;
  let interactionBase = uniforms.uInteraction.value;
  const audio = { bass: 0, mid: 0, treble: 0, energy: 0 };

  const fallbackMaterial = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: iridescentVertexShader,
    fragmentShader: iridescentFragmentShader,
  });

  let currentMaterial = fallbackMaterial;
  let mesh = new THREE.Mesh(GEOMETRIES[DEFAULT_GEOMETRY](), currentMaterial);
  scene.add(mesh);

  function setMesh(kind) {
    const build = GEOMETRIES[kind] || GEOMETRIES[DEFAULT_GEOMETRY];
    const old = mesh.geometry;
    mesh.geometry = build();
    old.dispose();
  }

  function setUniform(name, value) {
    if (name === 'uInteraction') interactionBase = value;
    if (uniforms[name]) uniforms[name].value = value;
  }

  function setAutoRotate(enabled) {
    controls.autoRotate = enabled;
  }

  function resetToFallback() {
    if (currentMaterial !== fallbackMaterial) {
      currentMaterial.dispose();
    }
    currentMaterial = fallbackMaterial;
    mesh.material = currentMaterial;
    thicknessBase = FALLBACK_THICKNESS;
  }

  // Swap in a shader returned by the Moth Atlas engine. Falls back to the
  // built-in iridescent material on any compile error.
  function applyQuantumShader(shaderData) {
    if (!shaderData || !shaderData.fragmentShader) {
      throw new Error('Quantum shader payload had no fragment shader.');
    }

    const quantumUniforms = {
      uTime: { value: 0 },
      uReflectance: iridescentUniforms.uReflectance,
      uAbsorption: iridescentUniforms.uAbsorption,
      uInteraction: iridescentUniforms.uInteraction,
      uCameraPos: { value: camera.position.clone() },
      uRTexture: { value: defaultRTexture },
      uTTexture: { value: defaultTTexture },
      uThickness: { value: QUANTUM_THICKNESS },
      uAudioBass: uniforms.uAudioBass,
    };

    for (const [key, value] of Object.entries(shaderData.uniforms || {})) {
      quantumUniforms[key] = { value };
    }

    const material = new THREE.ShaderMaterial({
      uniforms: quantumUniforms,
      vertexShader: shaderData.vertexShader || iridescentVertexShader,
      fragmentShader: adaptMothFragmentShader(shaderData.fragmentShader),
    });

    // Try to compile against the real WebGL context so a bad GLSL payload
    // throws here instead of silently producing a black mesh. Three.js logs
    // detailed compiler errors to the console when this fails.
    const probeScene = new THREE.Scene();
    probeScene.add(new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.01), material));
    renderer.compile(probeScene, camera);
    const program = renderer.properties.get(material).currentProgram;
    if (program && program.diagnostics && !program.diagnostics.runnable) {
      material.dispose();
      throw new Error('Quantum shader failed to compile — see console for the GLSL compiler log.');
    }

    uniforms.uTime = quantumUniforms.uTime;
    uniforms.uReflectance = quantumUniforms.uReflectance;
    uniforms.uAbsorption = quantumUniforms.uAbsorption;
    uniforms.uInteraction = quantumUniforms.uInteraction;
    uniforms.uCameraPos = quantumUniforms.uCameraPos;
    uniforms.uRTexture = quantumUniforms.uRTexture;
    uniforms.uTTexture = quantumUniforms.uTTexture;
    uniforms.uThickness = quantumUniforms.uThickness;
    const payloadThickness = quantumUniforms.uThickness.value;
    thicknessBase = typeof payloadThickness === 'number' ? payloadThickness : QUANTUM_THICKNESS;

    if (currentMaterial !== fallbackMaterial) currentMaterial.dispose();
    currentMaterial = material;
    mesh.material = currentMaterial;
  }

  // --- resize ---
  function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
  }
  if (!manual) window.addEventListener('resize', onResize);

  // --- animation loop / fps ---
  const clock = new THREE.Clock();
  let frames = 0;
  let fpsAccum = 0;

  // One frame of simulation + render. `raw` = audio levels for this frame.
  function step(dt, raw) {
    uniforms.uTime.value += dt;
    uniforms.uCameraPos.value.copy(camera.position);

    // Frame-rate independent exponential smoothing toward the raw levels.
    if (raw) {
      const k = 1 - Math.exp(-AUDIO_SMOOTHING * dt);
      for (const key in audio) audio[key] += ((raw[key] ?? 0) - audio[key]) * k;
    }
    uniforms.uAudioBass.value = audio.bass;
    uniforms.uThickness.value = thicknessBase + audio.bass * BASS_THICKNESS_NM;
    uniforms.uInteraction.value = interactionBase + audio.mid * MID_PHASE_SHIFT;
    // Capped so bass alone can never push bloom above 0.5 (0.35 + 1.0*0.15).
    bloomPass.strength = BLOOM_BASE_STRENGTH + audio.bass * 0.15;

    if (!manual) controls.update();
    composer.render(dt);
  }

  function tick() {
    const dt = clock.getDelta();
    step(dt, getAudioLevels?.());

    frames += 1;
    fpsAccum += dt;
    if (fpsAccum >= 0.5) {
      onFps?.(Math.round(frames / fpsAccum));
      frames = 0;
      fpsAccum = 0;
    }

    requestAnimationFrame(tick);
  }
  if (!manual) requestAnimationFrame(tick);

  return {
    step,
    camera,
    getMesh: () => mesh,
    setMesh,
    setUniform,
    setAutoRotate,
    applyQuantumShader,
    resetToFallback,
    getAudioLevels: () => audio,
  };
}

function createStarfield() {
  const count = 1800;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const r = 20 + Math.random() * 60;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    color: 0xaebfff,
    size: 0.06,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.6,
  });
  return new THREE.Points(geometry, material);
}
