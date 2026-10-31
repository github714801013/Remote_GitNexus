const http = require('http');
const { execFileSync } = require('child_process');
const path = require('path');

const npmRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
const handler = require(path.join(npmRoot, 'serve', 'node_modules', 'serve-handler'));
const LOCAL_DIAGNOSTICS_PATH = '/api/internal/repo-locks';

// 同时识别编码后的路径分隔符，避免 %2F 形式绕过代理层拦截。
const isLocalDiagnosticsRequest = (url = '') =>
  new RegExp(`^${LOCAL_DIAGNOSTICS_PATH}(?:/|%2f|$)`, 'i').test(url);

const server = http.createServer((req, res) => {
  // 容器内诊断接口不能经由对外 Web 代理转发，否则后端只能看到代理的回环地址。
  if (isLocalDiagnosticsRequest(req.url)) {
    res.statusCode = 404;
    res.end();
    return;
  }

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
