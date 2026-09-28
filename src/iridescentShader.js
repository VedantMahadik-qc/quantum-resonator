// Default thin-film iridescent Fresnel material — renders immediately,
// with no dependency on any external service. Uniform names mirror the
// Moth Atlas engine's own params (reflectance/absorption/interaction) so the
// same dock sliders drive a believable preview before synthesis completes.
export const iridescentUniforms = {
  uTime: { value: 0 },
  uReflectance: { value: 0.2 },
  uAbsorption: { value: 0.5 },
  uInteraction: { value: 1.0 },
  uCameraPos: { value: [0, 0, 5] },
};

// Audio-driven vertex vibration, shared by the fallback and quantum vertex
// stages. Expects uAudioBass and uTime uniforms.
export const audioDisplacementChunk = /* glsl */ `
  uniform float uAudioBass;
  uniform float uTime;

  vec3 audioDisplace(vec3 p, vec3 n) {
    return p + n * (uAudioBass * 0.18 * sin(p.y * 8.0 + uTime * 6.0));
  }
`;

// Shared by the fallback material and (unless the Moth engine supplies its
// own) the quantum material — outputs everything either fragment stage
// needs: the normal, world position, and view direction.
export const iridescentVertexShader = /* glsl */ `
  ${audioDisplacementChunk}
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  varying vec3 vViewDir;

  void main() {
    vNormal = normalize(normalMatrix * normal);
    vec3 displacedPos = audioDisplace(position, normal);
    vec4 worldPos = modelMatrix * vec4(displacedPos, 1.0);
    vWorldPos = worldPos.xyz;
    vViewDir = normalize(cameraPosition - worldPos.xyz);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

export const iridescentFragmentShader = /* glsl */ `
  uniform float uTime;
  uniform float uReflectance;
  uniform float uAbsorption;
  uniform float uInteraction;
  uniform float uThickness;
  uniform float uAudioBass;
  uniform vec3 uCameraPos;

  varying vec3 vNormal;
  varying vec3 vWorldPos;
  varying vec3 vViewDir;

  // Approximate thin-film interference: shifts hue with view angle + film thickness (nm).
  vec3 thinFilm(float cosTheta, float thicknessNm, float phaseShift) {
    float ior = 1.33 + uReflectance * 0.5;
    float opticalPath = 2.0 * ior * thicknessNm * cosTheta;
    vec3 wavelengths = vec3(650.0, 550.0, 450.0); // R, G, B nm
    vec3 phase = (2.0 * 3.14159265 * opticalPath) / wavelengths + phaseShift;
    return 0.5 + 0.5 * cos(phase);
  }

  void main() {
    vec3 norm = normalize(vNormal);
    vec3 viewDir = normalize(vViewDir);
    float cosTheta = clamp(dot(norm, viewDir), 0.0, 1.0);

    float fresnel = pow(1.0 - cosTheta, 5.0 * (0.4 + uReflectance * 0.6));
    // Film thickness in nanometers, in the ~200-700nm range that produces visible interference colors.
    float thicknessNm = uThickness + 420.0 * uReflectance + 60.0 * sin(uTime * 0.4 + vWorldPos.x * 2.0);

    // Spatial phase so the interference pattern varies across flat facets
    // and cavities too, not just with view angle — this is what keeps color
    // wrapping the whole body instead of only the silhouette rim.
    float spatialPhase = dot(vWorldPos, vec3(0.8, 1.2, 0.6)) * 1.5;
    vec3 filmColor = thinFilm(cosTheta, thicknessNm, uInteraction + spatialPhase);

    // Two-point specular interference highlights so lit faces shimmer too.
    vec3 lightDir1 = normalize(vec3(1.5, 2.0, 2.5));
    vec3 lightDir2 = normalize(vec3(-2.0, -1.0, -1.5));
    vec3 H1 = normalize(lightDir1 + viewDir);
    vec3 H2 = normalize(lightDir2 + viewDir);
    float spec1 = pow(max(dot(norm, H1), 0.0), 32.0);
    float spec2 = pow(max(dot(norm, H2), 0.0), 16.0);
    vec3 specColor = thinFilm(cosTheta, thicknessNm, uInteraction + spatialPhase + 2.1) * (spec1 * 0.9 + spec2 * 0.6);

    // Deep charcoal/slate base so the interference colors pop against it,
    // darkening further with absorption. Audio never brightens this.
    vec3 baseColor = mix(vec3(0.03, 0.03, 0.045), vec3(0.01, 0.01, 0.015), clamp(uAbsorption, 0.0, 1.0));
    vec3 rimColor = vec3(0.6, 0.85, 1.0) * pow(fresnel, 3.5);

    vec3 finalColor = mix(baseColor, filmColor, 0.75);
    finalColor += specColor;
    // Audio drives vertex displacement/phase elsewhere; here it only nudges
    // the rim glow, never the overall surface brightness.
    finalColor += rimColor * (0.6 + uAudioBass * 0.3);

    gl_FragColor = vec4(clamp(finalColor, 0.0, 1.0), 1.0);
  }
`;
