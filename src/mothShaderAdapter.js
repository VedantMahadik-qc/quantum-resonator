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

// Stable, energy-conserving Cook-Torrance microfacet BRDF driven by Moth's
// own reflectance/transmittance outputs. The Smith geometric shadowing term
// (G) is what keeps this from blowing out to white at grazing angles — the
// previous version divided by (NdotL * NdotV) alone with no compensating
// term, which is the classic Cook-Torrance singularity at silhouette edges.
const COOK_TORRANCE_COMBINE = /* glsl */ `
  vec3 N = normalize(vNormal);
  vec3 V = normalize(vViewDir);
  vec3 L = normalize(vec3(1.2, 1.8, 1.5));
  vec3 H = normalize(L + V);

  float NdotL = max(dot(N, L), 0.0);
  float NdotV = max(dot(N, V), 0.001);
  float NdotH = max(dot(N, H), 0.0);

  // Quantum spectral Fresnel directly from Moth's lookup.
  vec3 F = clamp(outReflectance.rgb, 0.0, 1.0);

  // GGX normal distribution.
  float roughness = 0.25;
  float a = roughness * roughness;
  float a2 = a * a;
  float dDenom = (NdotH * NdotH * (a2 - 1.0) + 1.0);
  float D = a2 / (3.14159265 * dDenom * dDenom);

  // Smith geometric shadowing — prevents the edge blowout.
  float k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
  float gV = NdotV / (NdotV * (1.0 - k) + k);
  float gL = NdotL / (NdotL * (1.0 - k) + k);
  float G = gV * gL;

  vec3 specular = (D * G * F) / max(4.0 * NdotV, 0.001);

  vec3 baseAlbedo = vec3(0.04); // deep dark base
  vec3 diffuse = baseAlbedo * (vec3(1.0) - F) * NdotL;

  // Controlled edge Fresnel sheen, capped brightness.
  float fresnelFactor = pow(1.0 - NdotV, 4.0);
  vec3 edgeSheen = F * fresnelFactor * 0.45;

  vec3 backScatter = clamp(outTransmittance.rgb, 0.0, 1.0) * 0.12 * max(-dot(N, L), 0.0);

  vec3 finalColor = diffuse + specular * 1.2 + edgeSheen + backScatter;
  gl_FragColor = vec4(clamp(finalColor, 0.0, 1.0), 1.0);
`;

function buildOutputCombine(outputNames) {
  if (outputNames.includes('outReflectance') && outputNames.includes('outTransmittance')) {
    return COOK_TORRANCE_COMBINE;
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
