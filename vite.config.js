import { defineConfig } from 'vite';

// Dev-only fallback for presigned S3 URLs that reject the browser's Origin
// header (CORS). Only used when a direct fetch() from the page fails.
function downloadProxyPlugin() {
  return {
    name: 'download-proxy',
    configureServer(server) {
      server.middlewares.use('/download-proxy', async (req, res) => {
        const targetUrl = new URL(req.url, 'http://localhost').searchParams.get('url');
        if (!targetUrl || !/^https:\/\//.test(targetUrl)) {
          res.statusCode = 400;
          res.end('Missing or invalid url');
          return;
        }
        try {
          const upstream = await fetch(targetUrl);
          res.statusCode = upstream.status;
          res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/zip');
          const buffer = await upstream.arrayBuffer();
          res.end(Buffer.from(buffer));
        } catch (err) {
          res.statusCode = 502;
          res.end(err.message);
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [downloadProxyPlugin()],
  server: {
    proxy: {
      '/moth-api': {
        target: 'https://api.mothquantum.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/moth-api/, ''),
      },
    },
  },
  build: {
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 600, // three.js alone is ~500kB minified
  },
});
