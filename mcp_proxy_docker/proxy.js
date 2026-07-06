const http = require('http');
const handler = require('/usr/lib/node_modules/serve/node_modules/serve-handler');

const server = http.createServer((req, res) => {
  // Route /api requests to the backend API server on port 1347
  if (req.url.startsWith('/api')) {
    const proxyReq = http.request(
      {
        host: '127.0.0.1',
        port: 1347,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );

    req.pipe(proxyReq);

    proxyReq.on('error', (e) => {
      console.error(`[proxy] Error routing to backend: ${e.message}`);
      res.statusCode = 502;
      res.end('Bad Gateway');
    });
  } else {
    // Serve static files for everything else
    return handler(req, res, {
      public: '/app/gitnexus-web/dist',
      rewrites: [{ source: '**', destination: '/index.html' }],
    });
  }
});

const PORT = 1350;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[proxy] GitNexus Web UI + API Proxy running on port ${PORT}`);
});
