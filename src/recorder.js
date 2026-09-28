// 1-click canvas recorder: captures the WebGL canvas (plus an optional audio
// stream) for a fixed duration and downloads the result as .webm.

const MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

function pickMimeType() {
  return MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/**
 * Records `canvas` for `durationMs`, calling onProgress(fraction 0..1, msLeft)
 * every frame. Resolves with the recorded Blob after triggering a download.
 */
export function recordCanvas(
  canvas,
  durationMs = 15000,
  onProgress,
  { audioStream, filename = 'quantum-resonator-showcase.webm' } = {}
) {
  if (!canvas.captureStream || typeof MediaRecorder === 'undefined') {
    return Promise.reject(new Error('Video recording is not supported in this browser.'));
  }

  const stream = canvas.captureStream(60);
  for (const track of audioStream?.getAudioTracks() ?? []) stream.addTrack(track);

  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(stream, {
    ...(mimeType && { mimeType }),
    videoBitsPerSecond: 12_000_000,
  });
  const chunks = [];

  return new Promise((resolve, reject) => {
    let rafId = 0;
    const start = performance.now();

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    recorder.onerror = (e) => {
      cancelAnimationFrame(rafId);
      reject(e.error || new Error('MediaRecorder failed.'));
    };
    recorder.onstop = () => {
      cancelAnimationFrame(rafId);
      stream.getVideoTracks().forEach((t) => t.stop());
      onProgress?.(1, 0);
      const blob = new Blob(chunks, { type: 'video/webm' });
      downloadBlob(blob, filename);
      resolve(blob);
    };

    function tick() {
      const elapsed = performance.now() - start;
      onProgress?.(Math.min(1, elapsed / durationMs), Math.max(0, durationMs - elapsed));
      if (elapsed < durationMs) rafId = requestAnimationFrame(tick);
    }

    recorder.start(250);
    rafId = requestAnimationFrame(tick);
    // Timer (not rAF) ends the clip, so it still stops if the tab is hidden.
    setTimeout(() => {
      if (recorder.state !== 'inactive') recorder.stop();
    }, durationMs);
  });
}
