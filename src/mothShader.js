import * as THREE from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';

// Integration with Moth Atlas's `entanglement-shader-v1` engine.
// NOTE: this talks to a third-party API (api.mothquantum.com) that this codebase
// cannot verify or control. Every call is defensive — the caller (scene.js/main.js)
// always has a working fallback shader and must not assume this succeeds.

const BASE = '/moth-api/api/v1';
const ENGINE = 'entanglement-shader-v1';
const RESULT_GLSL_FILENAME = 'entanglement_texture.glsl';
const R_LUT_FILENAME = 'R_lut.hdr';
const T_LUT_FILENAME = 'T_lut.hdr';

export async function probeEngine(apiKey) {
  const res = await fetch(`${BASE}/engines/${ENGINE}`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
  });
  if (!res.ok) {
    throw new Error(`Engine probe failed: ${res.status} ${await safeText(res)}`);
  }
  return res.json();
}

export async function generateQuantumShader(apiKey, params, { onStatus, signal } = {}) {
  if (!apiKey) throw new Error('Missing Moth Atlas API key.');

  onStatus?.('submitting');
  const submitRes = await fetch(`${BASE}/engines/${ENGINE}/process`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ params: params || {} }),
    signal,
  });

  if (!submitRes.ok) {
    throw new Error(`Job submission failed: ${submitRes.status} ${await safeText(submitRes)}`);
  }

  const submitData = await submitRes.json();
  const jobId = submitData.jobId ?? submitData.job_id ?? submitData.id;
  if (!jobId) throw new Error('Job submission response did not include a job id.');

  onStatus?.('running');
  const jobData = await pollJob(jobId, apiKey, { signal });
  console.log('[Moth Atlas] job status response:', jobData);

  onStatus?.('fetching-result');
  const resultRes = await fetch(`${BASE}/jobs/${jobId}/result`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  });
  if (!resultRes.ok) {
    throw new Error(`Fetching result failed: ${resultRes.status} ${await safeText(resultRes)}`);
  }
  const resultData = await resultRes.json();
  console.log('[Moth Atlas] job result response:', resultData);

  let downloadUrl =
    resultData.download_url ||
    resultData.url ||
    resultData.result?.url ||
    resultData.result?.download_url ||
    resultData.outputs?.find((o) => o.slot === 'result' || o.name === 'result')?.url ||
    resultData.outputs?.[0]?.url;

  // If the result returns an asset id instead of an inline URL, resolve it.
  if (!downloadUrl) {
    const assetId =
      resultData.output_asset_id ||
      resultData.outputs?.find((o) => o.slot === 'result')?.output_asset_id ||
      resultData.outputs?.[0]?.output_asset_id ||
      jobData.outputs?.[0]?.output_asset_id;

    if (assetId) {
      const dlRes = await fetch(`${BASE}/assets/${assetId}/download`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal,
      });
      if (dlRes.ok) {
        const dlData = await dlRes.json();
        console.log('[Moth Atlas] asset download response:', dlData);
        downloadUrl = dlData.download_url || dlData.url;
      }
    }
  }

  if (!downloadUrl) throw new Error('Result response did not include a download URL.');

  onStatus?.('downloading');
  const assetRes = await fetchZip(downloadUrl, signal);
  if (!assetRes.ok) throw new Error(`Downloading shader asset failed: ${assetRes.status}`);

  return parseShaderZip(await assetRes.arrayBuffer());
}

// Turn an entanglement-shader-v1 result ZIP into { fragmentShader, uniforms }.
// Used for live API results and for saved results bundled with the app
// (public/quantum/*.zip, loaded by the offline renderer).
export async function parseShaderZip(arrayBuffer) {
  const { default: JSZip } = await import('jszip');
  const archive = await JSZip.loadAsync(arrayBuffer);
  console.log('[Moth Atlas] archive contents:', Object.keys(archive.files));

  const shaderFile = archive.file(RESULT_GLSL_FILENAME);
  if (!shaderFile) {
    throw new Error(`Result archive did not contain ${RESULT_GLSL_FILENAME}.`);
  }

  const fragmentShader = await shaderFile.async('text');
  console.log('--- MOTH GLSL RAW ---', fragmentShader);

  const uniforms = {};
  const rTexture = await loadHdrTexture(archive, R_LUT_FILENAME);
  const tTexture = await loadHdrTexture(archive, T_LUT_FILENAME);
  if (rTexture) uniforms.uRTexture = rTexture;
  if (tTexture) uniforms.uTTexture = tTexture;

  return { fragmentShader, uniforms };
}

// Parses a real floating-point .hdr lookup table from the archive into a
// DataTexture, falling back to null (and the scene's placeholder LUT) if
// the file isn't present or fails to parse.
async function loadHdrTexture(archive, filename) {
  const file = archive.file(filename);
  if (!file) return null;
  try {
    const buffer = await file.async('arraybuffer');
    const parsed = new RGBELoader().parse(buffer);
    if (!parsed?.data) return null;
    const texture = new THREE.DataTexture(
      parsed.data,
      parsed.width,
      parsed.height,
      THREE.RGBAFormat,
      parsed.type ?? THREE.FloatType
    );
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    // Per the engine's GLSL header: the s (phase) axis is periodic, t (angle) is clamped.
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;
    console.log(`[Moth Atlas] parsed ${filename}:`, parsed.width, 'x', parsed.height);
    return texture;
  } catch (err) {
    console.warn(`[Moth Atlas] failed to parse ${filename}:`, err.message);
    return null;
  }
}

async function pollJob(jobId, apiKey, { intervalMs = 1500, timeoutMs = 120000, signal } = {}) {
  const started = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await fetch(`${BASE}/jobs/${jobId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });
    if (!res.ok) throw new Error(`Job status check failed: ${res.status} ${await safeText(res)}`);
    const data = await res.json();

    if (data.status === 'completed') return data;
    if (data.status === 'failed' || data.status === 'error') {
      throw new Error(`Moth Atlas job failed: ${data.error || 'unknown error'}`);
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error('Timed out waiting for the Moth Atlas job to complete.');
    }
    await sleep(intervalMs);
  }
}

// Presigned S3 URLs reject requests carrying an Authorization/custom header,
// so this must stay a clean, header-free GET. If the browser can't reach it
// directly (CORS, network), retry through the dev-server proxy.
async function fetchZip(downloadUrl, signal) {
  try {
    return await fetch(downloadUrl, { signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    console.warn('[Moth Atlas] direct download fetch failed, retrying via /download-proxy:', err.message);
    return fetch(`/download-proxy?url=${encodeURIComponent(downloadUrl)}`, { signal });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
