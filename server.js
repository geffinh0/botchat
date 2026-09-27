/**
 * SUPER CLIENT — Local Proxy & Web Server
 * Serves the frontend application on http://localhost:3000 and proxies
 * all requests to the official SuperLive API (api.sprlv-api.com) with
 * complete mobile headers, eliminating CORS restrictions in web browsers.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const botEngine = require('./bot_engine');
const db = require('./db');

function readJsonBody(req) {
  return new Promise((resolve) => {
    let chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const str = Buffer.concat(chunks).toString('utf-8');
        resolve(str ? JSON.parse(str) : {});
      } catch (e) {
        resolve({});
      }
    });
  });
}

const PORT = process.env.PORT || 3000;
const STATIC_DIR = __dirname;
const REMOTE_API_HOST = 'api.sprlv-api.com';
const REMOTE_API_BASE_PATH = '/api/v1';

// Default registered Device-ID (obtained from official device/register endpoint)
let cachedDeviceId = 'e7a42524b5241eb9a73f28bc11b4f2ed';

const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp'
};

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Device-ID, User-Agent, Accept');
}

/**
 * Ensures a valid registered Device-ID exists by calling device/register if needed.
 */
function ensureRegisteredDeviceId() {
  return new Promise((resolve) => {
    if (cachedDeviceId) {
      return resolve(cachedDeviceId);
    }

    const payload = JSON.stringify({
      client_params: {
        app_language: 'pt',
        device_language: 'pt',
        brand_name: 'Samsung',
        display_density: 'xxhdpi',
        display_size: '1080x2400',
        device_preferred_languages: ['pt-BR', 'en-US']
      }
    });

    const req = https.request({
      hostname: REMOTE_API_HOST,
      port: 443,
      path: `${REMOTE_API_BASE_PATH}/device/register`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'SuperLive/2.31.0 (samsung SM-G998B; Android 13; Scale/3.0)',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (resp) => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed && parsed.guid) {
            cachedDeviceId = parsed.guid;
            console.log(`[DEVICE] Novo Device-ID registrado com sucesso no SuperLive: ${cachedDeviceId}`);
          }
        } catch (e) {
          // fallback
        }
        resolve(cachedDeviceId || 'e7a42524b5241eb9a73f28bc11b4f2ed');
      });
    });

    req.on('error', () => {
      resolve(cachedDeviceId || 'e7a42524b5241eb9a73f28bc11b4f2ed');
    });

    req.write(payload);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // --- API Proxy Route ---
  if (pathname.startsWith('/api/v1/')) {
    const targetPath = pathname; // e.g. /api/v1/users/own_profile
    const activeDeviceId = req.headers['device-id'] || await ensureRegisteredDeviceId();

    let bodyChunks = [];
    req.on('data', chunk => bodyChunks.push(chunk));
    req.on('end', () => {
      const bodyBuffer = Buffer.concat(bodyChunks);

      const proxyHeaders = {
        'Content-Type': 'application/json; charset=UTF-8',
        'Accept': 'application/json',
        'User-Agent': 'SuperLive/2.31.0 (samsung SM-G998B; Android 13; Scale/3.0)',
        'Device-ID': activeDeviceId,
        'Content-Length': bodyBuffer.length
      };

      if (req.headers['authorization']) {
        proxyHeaders['Authorization'] = req.headers['authorization'];
      }

      const proxyReq = https.request({
        hostname: REMOTE_API_HOST,
        port: 443,
        path: targetPath,
        method: req.method,
        headers: proxyHeaders
      }, (proxyRes) => {
        setCorsHeaders(res);
        res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'application/json');
        res.writeHead(proxyRes.statusCode);
        proxyRes.pipe(res);

        const time = new Date().toLocaleTimeString('pt-BR');
        console.log(`[${time}] PROXY ${req.method} ${targetPath} -> Status ${proxyRes.statusCode}`);
      });

      proxyReq.on('error', (err) => {
        console.error(`[PROXY ERROR] Falha ao encaminhar ${targetPath}:`, err.message);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: -1, message: `Erro de conexão com SuperLive API: ${err.message}` } }));
      });

      if (bodyBuffer.length > 0) {
        proxyReq.write(bodyBuffer);
      }
      proxyReq.end();
    });
    return;
  }

  // --- Bot Engine & Mini-Database Management API Routes ---
  if (pathname.startsWith('/api/bot/') || pathname.startsWith('/api/db/')) {
    setCorsHeaders(res);
    res.setHeader('Content-Type', 'application/json');

    try {
      if (pathname === '/api/bot/status' && req.method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify(botEngine.getStatus()));
        return;
      }

      if (pathname === '/api/bot/system-logs' && req.method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify({
          success: true,
          logs: botEngine.getSystemLogs(),
          wsConnected: botEngine.wsConnected,
          authFailed: botEngine.authFailed,
          errorCount: botEngine.systemLogs.filter(l => l.level === 'ERROR').length
        }));
        return;
      }

      if (pathname === '/api/bot/clear-system-logs' && req.method === 'POST') {
        botEngine.clearSystemLogs();
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
        return;
      }

      if (pathname === '/api/bot/config') {
        if (req.method === 'GET') {
          res.writeHead(200);
          res.end(JSON.stringify(botEngine.config));
          return;
        } else if (req.method === 'POST') {
          const body = await readJsonBody(req);
          const saved = botEngine.saveConfig(body);
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, config: saved }));
          return;
        }
      }

      if (pathname === '/api/bot/start' && req.method === 'POST') {
        const body = await readJsonBody(req);
        try {
          const status = await botEngine.startMonitoring(body);
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, status }));
        } catch (err) {
          res.writeHead(200);
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
        return;
      }

      if (pathname === '/api/bot/stop' && req.method === 'POST') {
        try {
          const status = botEngine.stopMonitoring();
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, status }));
        } catch (err) {
          res.writeHead(200);
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
        return;
      }

      if (pathname === '/api/bot/creators' && req.method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify({
          success: true,
          creators: db.getCreatorsList(),
          activeCreator: db.getActiveCreator()
        }));
        return;
      }

      if (pathname === '/api/bot/switch-creator' && req.method === 'POST') {
        const body = await readJsonBody(req);
        try {
          const result = await botEngine.switchCreator(body.creatorUserId);
          res.writeHead(200);
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(200);
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
        return;
      }

      if (pathname === '/api/bot/creators' && req.method === 'DELETE') {
        const body = await readJsonBody(req);
        const ok = db.deleteCreator(body.id || body.creatorUserId);
        res.writeHead(200);
        res.end(JSON.stringify({ success: ok, creators: db.getCreatorsList() }));
        return;
      }

      if (pathname === '/api/bot/detect-live' && req.method === 'POST') {
        const body = await readJsonBody(req);
        try {
          const result = await botEngine.detectCreatorLive(body.creatorUserId);
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, data: result }));
        } catch (err) {
          res.writeHead(200);
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
        return;
      }

      if (pathname === '/api/bot/test-recurring' && req.method === 'POST') {
        const body = await readJsonBody(req);
        try {
          const result = await botEngine.triggerRecurringMessageNow(body.livestreamId);
          res.writeHead(200);
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(200);
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
        return;
      }

      if (pathname === '/api/bot/test-chat' && req.method === 'POST') {
        const body = await readJsonBody(req);
        try {
          const result = await botEngine.sendChatMessage(body.text, body.livestreamId);
          res.writeHead(200);
          res.end(JSON.stringify({ success: !result || !result.error, ...result }));
        } catch (err) {
          res.writeHead(200);
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
        return;
      }

      if (pathname === '/api/bot/test-mute' && req.method === 'POST') {
        const body = await readJsonBody(req);
        await botEngine.executeMute(body.livestreamId, body.userId, body.userName || 'Usuário', body.text || 'Teste', 'Manual');
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
        return;
      }

      if (pathname === '/api/bot/test-kick' && req.method === 'POST') {
        const body = await readJsonBody(req);
        await botEngine.executeBan(body.livestreamId, body.userId, body.userName || 'Usuário', body.text || 'Teste', 'Manual');
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
        return;
      }

      if (pathname === '/api/bot/test-unmute' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const result = await botEngine.executeUnmute(body.livestreamId, body.userId, body.userName || 'Usuário');
        res.writeHead(200);
        res.end(JSON.stringify(result));
        return;
      }

      if (pathname === '/api/bot/test-dm' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const result = await botEngine.sendEndOfLiveDM({
          creatorUserId: body.creatorUserId || botEngine.config.creatorUserId,
          creatorName: body.creatorName || 'Criadora',
          viewers: body.viewers || 142,
          diamonds: body.diamonds || 2850,
          followers: body.followers || 19,
          duration: body.duration || '1h 45min'
        });
        res.writeHead(200);
        res.end(JSON.stringify(result));
        return;
      }

      if (pathname === '/api/bot/clear-logs' && req.method === 'POST') {
        db.clearAuditLogs();
        botEngine.moderationLogs = [];
        botEngine.chatFeed = [];
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
        return;
      }

      // --- Mini-Banco de Dados Persistente API Routes ---
      if (pathname === '/api/db/data' && req.method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify({
          success: true,
          config: db.getConfig(),
          activeCreator: db.getActiveCreator(),
          recurringMessages: db.getRecurringMessages(),
          moderationRules: db.getModerationRules(),
          auditLogs: db.getAuditLogs(100),
          systemLogs: db.getSystemLogs(200),
          liveSessions: db.getLiveSessions()
        }));
        return;
      }

      if (pathname === '/api/db/recurring/add' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const item = db.addRecurringMessage(body.text);
        botEngine.config = db.getConfig();
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, item, messages: db.getRecurringMessages() }));
        return;
      }

      if (pathname === '/api/db/recurring/delete' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const removed = db.removeRecurringMessage(Number(body.index));
        botEngine.config = db.getConfig();
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, removed, messages: db.getRecurringMessages() }));
        return;
      }

      if (pathname === '/api/db/recurring/reorder' && req.method === 'POST') {
        const body = await readJsonBody(req);
        if (Array.isArray(body.messages)) {
          db.setRecurringMessagesFromStrings(body.messages);
          botEngine.config = db.getConfig();
        }
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, messages: db.getRecurringMessages() }));
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Endpoint do bot não encontrado' }));
      return;
    } catch (err) {
      console.error('[BOT ROUTE ERROR]:', err.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
  }

  // --- Proxy Status & Device Registration Endpoint ---
  if (pathname === '/server-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'online',
      proxyHost: REMOTE_API_HOST,
      cachedDeviceId: cachedDeviceId,
      version: '2.31.0',
      botEngineActive: true
    }));
    return;
  }

  // --- Static Files Serving ---
  let filePath = path.join(STATIC_DIR, pathname === '/' ? 'index.html' : pathname);
  
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      filePath = path.join(STATIC_DIR, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (readErr, content) => {
      if (readErr) {
        res.writeHead(500);
        res.end('Erro interno ao ler arquivo.');
        return;
      }
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      });
      res.end(content);
    });
  });
});

server.listen(PORT, () => {
  console.log('=====================================================');
  console.log(`🚀 SUPER CLIENT SERVER EM EXECUÇÃO!`);
  console.log(`🌐 Painel Web: http://localhost:${PORT}`);
  console.log(`🔌 Proxy SuperLive API: http://localhost:${PORT}/api/v1/`);
  console.log(`📱 Device-ID Padrão: ${cachedDeviceId}`);
  console.log('=====================================================');
});
