// Render render.html frame by frame in headless Chrome and encode an MP4 with the track.
//
//   node tools/render_video.mjs [--out demo.mp4] [--from 0] [--frames N] [--every 1] [--stills dir]
//
// --stills writes PNGs instead of a video (with --every to sample frames) for quick checks.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const OUT = arg('out', 'quantum-resonator-demo.mp4');
const FROM = Number(arg('from', 0));
const EVERY = Number(arg('every', 1));
const STILLS = arg('stills', null);
const QUERY = arg('query', '');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const server = await createServer({ server: { port: 5199, strictPort: true }, logLevel: 'error' });
await server.listen();

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader',
         '--hide-scrollbars', '--force-device-scale-factor=1'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn') console.log('[page]', m.text().slice(0, 300)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`http://localhost:5199/render.html${QUERY}`, { waitUntil: 'networkidle0' });
await page.waitForFunction('window.__ready === true', { timeout: 120000 });
const info = await page.evaluate(() => window.__info);
console.log('render info', info, await page.evaluate(() => {
  const gl = document.getElementById('c').getContext('webgl2');
  const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
}));

const last = Math.min(info.frames, Number(arg('frames', info.frames)) + FROM);
// Frames go to disk first, then one ffmpeg pass muxes them with the track.
const dir = STILLS || 'render-frames';
mkdirSync(dir, { recursive: true });

const t0 = Date.now();
for (let i = 0; i < last; i++) {
  await page.evaluate((k) => window.__frame(k), i);   // every frame advances the simulation
  if (i < FROM || (i - FROM) % EVERY) continue;
  writeFileSync(`${dir}/f${String(i).padStart(5, '0')}.jpg`, await page.screenshot({ type: 'jpeg', quality: 94 }));
  if (i % 150 === 0) console.log(`frame ${i}/${last}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
await browser.close();
await server.close();

if (!STILLS) {
  const code = await new Promise((resolve) => spawn('ffmpeg', ['-y', '-loglevel', 'error',
    '-framerate', String(info.fps), '-i', `${dir}/f%05d.jpg`, '-i', 'public/render/superposition.wav',
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-strict', '-2', '-b:a', '256k', '-af', 'apad', '-shortest', OUT],
    { stdio: 'inherit' }).on('close', resolve));
  if (code !== 0) throw new Error(`ffmpeg exited with ${code}`);
}
console.log('done', STILLS || OUT, `${((Date.now() - t0) / 1000).toFixed(0)}s`);
