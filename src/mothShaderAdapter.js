// Best-effort adapter that turns whatever GLSL Moth Atlas returns into a
// valid Three.js fragment shader. We don't control this source, so this is
// deliberately defensive: strip anything WebGL/GLSL ES can't compile, and
// guarantee the surface ends up opaque (alpha = 1.0) so a shader that
// "compiles" can't still render as an invisible/black mesh.

const MAIN_RE = /void\s+main\s*\(\s*\)\s*\{/;

export function adaptMothFragmentShader(rawSource) {
  let src = rawSource
    // Desktop GLSL version directives ("#version 330 core") aren't valid in
    // WebGL/GLSL ES and silently break rendering in some drivers.
    .replace(/^\s*#version[^\n]*\n/m, '')
    // Let Three's own injected precision qualifier win instead of a
    // conflicting one from the returned source.
    .replace(/^\s*precision\s+(lowp|mediump|highp)\s+float\s*;\s*$/gm, '')
    // WebGL2-style `in` varyings -> the `varying` syntax Three's default
    // (non-GLSL3) ShaderMaterial pipeline expects.
    .replace(/^\s*in\s+(vec[234]|float|int)\s+(\w+)\s*;\s*$/gm, 'varying $1 $2;')
    // GLSL ES 300 / desktop `texture(sampler, uv)` -> the `texture2D(...)`
    // Three's default (GLSL ES 100) ShaderMaterial pipeline requires.
    .replace(/\btexture\s*\(/g, 'texture2D(');

  // Redirect layout-qualified MRT outputs into plain local variables we can
  // recombine into gl_FragColor ourselves (WebGL1-style ShaderMaterial only
  // has a single fragment output).
  const outputNames = [];
  src = src.replace(
    /layout\s*\(\s*location\s*=\s*\d+\s*\)\s*out\s+vec4\s+(\w+)\s*;/g,
    (_, name) => {
      outputNames.push(name);
      return `vec4 ${name};`;
    }
  );

  if (MAIN_RE.test(src)) {
    // Standalone shader: rename its main() (GLSL reserves identifiers with
    // "__") so we can wrap it and control the final output ourselves.
    const renamed = src.replace(/void\s+main\s*\(\s*\)/, 'void mothMain()');
    return `${renamed}
void main() {
  mothMain();
  ${buildOutputCombine(outputNames)}
}
`;
  }

  // No main(): treat this as a BSDF/utility function library and synthesize
  // an entry point that feeds it the surface normal/view vector we have.
  const fn = findEntryFunction(src);
  if (!fn) {
    throw new Error('Quantum shader has no main() and no callable function was found to wrap.');
  }

  const args = fn.params.map(guessArgument).join(', ');
  const call = `${fn.name}(${args})`;
  const colorExpr = fn.returnType === 'vec4' ? call : `vec4(${call}, 1.0)`;

  return `
uniform vec3 uCameraPos;
uniform float uReflectance;
uniform float uAbsorption;
uniform float uInteraction;
uniform float uTime;
varying vec3 vNormal;
varying vec3 vViewDir;
varying vec3 vWorldPos;

${src}

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(vViewDir);
  gl_FragColor = clamp(${colorExpr}, 0.0, 1.0);
  gl_FragColor.a = 1.0;
}
`;
}

// Shades the surface with Moth's own outputs. outReflectance is the quantum
// stack's reflectance per RGB wavelength (sampled from R_lut at this view angle and
// film thickness), so it is used as the visible colour of the surface under a soft
// key light, with a specular glint and grazing-angle sheen in the same colour.
// outTransmittance (T_lut) shows up as light passing through on the back-lit side.
// The quantum bands are pastel (chroma ~0.2), so chroma is widened around the
// luminance by FILM_CHROMA (2.3) for display; hue and angle dependence are unchanged.
// (An earlier version used R only as a Fresnel term on a near-black base, which
// hid the quantum colours everywhere except tiny highlights.)
const FILM_COMBINE = /* glsl */ `
  const float FILM_CHROMA = 2.3;
  vec3 N = normalize(vNormal);
  vec3 V = normalize(vViewDir);
  vec3 L = normalize(vec3(1.2, 1.8, 1.5));
  vec3 H = normalize(L + V);

  vec3 R = max(outReflectance.rgb, 0.0);
  vec3 T = max(outTransmittance.rgb, 0.0);
  float lum = dot(R, vec3(0.299, 0.587, 0.114));
  vec3 film = max(mix(vec3(lum), R, FILM_CHROMA), 0.0);

  float NdotL = dot(N, L);
  float NdotV = max(dot(N, V), 0.0);
  float wrapped = clamp((NdotL + 0.6) / 1.6, 0.0, 1.0);
  float glint = pow(max(dot(N, H), 0.0), 90.0);
  float rim = pow(1.0 - NdotV, 3.0);

  vec3 color = film * (0.16 + 0.62 * wrapped)
             + film * glint * 1.4
             + film * rim * 0.45
             + T * (0.55 * max(-NdotL, 0.0) + 0.25 * rim);
  gl_FragColor = vec4(clamp(color, 0.0, 2.0), 1.0);
`;

function buildOutputCombine(outputNames) {
  if (outputNames.includes('outReflectance') && outputNames.includes('outTransmittance')) {
    return FILM_COMBINE;
  }
  if (outputNames.length > 0) {
    const sum = outputNames.map((n) => `${n}.rgb`).join(' + ');
    return `gl_FragColor = vec4(clamp(${sum}, 0.0, 1.0), 1.0);`;
  }
  return 'gl_FragColor.a = 1.0;';
}

function findEntryFunction(src) {
  const match = src.match(/(vec3|vec4)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*\{/);
  if (!match) return null;
  const [, returnType, name, paramList] = match;
  const params = paramList
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  return { returnType, name, params };
}

function guessArgument(param) {
  const p = param.toLowerCase();
  if (p.includes('normal')) return 'N';
  if (p.includes('view') || p.includes('eye')) return 'V';
  if (p.includes('world') || p.includes('pos')) return 'vWorldPos';
  if (p.includes('light')) return 'normalize(vec3(0.5, 0.7, 0.6))';
  if (p.includes('rough')) return 'uReflectance';
  if (p.includes('absorp')) return 'uAbsorption';
  if (p.includes('interact') || p.includes('phase') || p.includes('eta') || p.includes('ior')) return 'uInteraction';
  if (p.includes('time')) return 'uTime';
  if (p.startsWith('vec3')) return 'vec3(1.0)';
  if (p.startsWith('vec2')) return 'vec2(0.0)';
  if (p.startsWith('int')) return '1';
  return '0.5';
}
