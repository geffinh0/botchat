/**
 * SUPER CLIENT — Local Proxy & Web Server
 * Serves the frontend application on http://localhost:3000 and proxies
 * all requests to the official SuperLive API (api.sprlv-api.com) with
 * complete mobile headers, eliminating CORS restrictions in web browsers.
 */

console.log('[BOOT] Iniciando Super Client Server...');
console.log(`[BOOT] Node.js ${process.version} | PID ${process.pid}`);

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

let botEngine;
let db;
try {
  console.log('[BOOT] Carregando banco de dados...');
  db = require('./db');
  console.log('[BOOT] Banco de dados carregado.');

  console.log('[BOOT] Carregando engine do bot...');
  botEngine = require('./bot_engine');
  console.log('[BOOT] Engine do bot carregada.');
} catch (err) {
  console.error('[BOOT][FATAL] Falha ao carregar dependências da aplicação.');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
}

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

const rawPort = process.env.PORT || '3000';
const PORT = Number(rawPort);
if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
  console.error(`[BOOT][FATAL] PORT inválida: ${rawPort}`);
  process.exit(1);
}
const HOST = '0.0.0.0';
const STATIC_DIR = __dirname;
const REMOTE_API_HOST = 'api.sprlv-api.com';
const REMOTE_API_BASE_PATH = '/api/v1';

// Default registered Device-ID (obtained from official device/register endpoint)
let cachedDeviceId = process.env.SUPERLIVE_DEVICE_ID || '';

function getPublicBotConfig() {
  const cfg = botEngine.config || {};
  const { botToken, ...publicConfig } = cfg;
  return publicConfig;
}

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
      } else {
        const isPublicRoute = 
          targetPath === '/api/v1/device/register' || 
          targetPath.startsWith('/api/v1/user/signup/') ||
          targetPath === '/api/v1/users/search' ||
          targetPath === '/api/v1/users/profile' ||
          targetPath === '/api/v1/livestream/retrieve';
        const serverToken = botEngine && botEngine.config && botEngine.config.botToken && !botEngine.authFailed;
        if (!isPublicRoute && serverToken) {
          proxyHeaders['Authorization'] = `Token ${serverToken}`;
        }
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

  // --- Bot Engine API Routes ---
  if (pathname.startsWith('/api/bot/')) {
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

      if (pathname === '/api/bot/login' && req.method === 'POST') {
        const body = await readJsonBody(req);
        let result;
        if (body.type === 'email' || (body.email && body.password)) {
          result = await botEngine.loginWithEmail(body.email, body.password);
        } else if (body.type === 'token' || body.token) {
          result = await botEngine.loginWithToken(body.token, body.deviceId);
        } else if (body.type === 'phone_verify') {
          result = await botEngine.verifyPhoneCode(body.phone_verification_id, body.phone_number, body.code);
        } else {
          result = { success: false, error: 'Método de login não especificado.' };
        }
        // Entrega o estado atual junto com o resultado para a UI não depender
        // de um ciclo de polling para refletir o login imediatamente.
        if (result && result.success) {
          result.status = botEngine.getStatus();
        }
        res.writeHead(200);
        res.end(JSON.stringify(result));
        return;
      }

      if (pathname === '/api/bot/logout' && req.method === 'POST') {
        const result = botEngine.logoutBot();
        result.status = botEngine.getStatus();
        res.writeHead(200);
        res.end(JSON.stringify(result));
        return;
      }

      if (pathname === '/api/bot/send-phone-code' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const result = await botEngine.sendPhoneCode(body.phone_number, body.is_retry);
        res.writeHead(200);
        res.end(JSON.stringify(result));
        return;
      }

      if (pathname === '/api/bot/verify-phone-code' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const result = await botEngine.verifyPhoneCode(body.phone_verification_id, body.phone_number, body.code);
        res.writeHead(200);
        res.end(JSON.stringify(result));
        return;
      }

      if (pathname === '/api/bot/config') {
        if (req.method === 'GET') {
          res.writeHead(200);
          res.end(JSON.stringify(getPublicBotConfig()));
          return;
        } else if (req.method === 'POST') {
          const body = await readJsonBody(req);
          // O token da conta do robô é segredo de servidor e nunca é
          // atualizado pelo formulário de configurações. O login/logout
          // são os únicos fluxos autorizados a alterá-lo.
          if (body && typeof body === 'object') delete body.botToken;
          const saved = botEngine.saveConfig(body);
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, config: getPublicBotConfig() }));
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

  // --- Render / uptime health check ---
  if (pathname === '/healthz' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      status: 'ok',
      uptime: process.uptime(),
      version: '2.33.0'
    }));
    return;
  }

  // --- Proxy Status & Device Registration Endpoint ---
  if (pathname === '/server-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'online',
      proxyHost: REMOTE_API_HOST,
      cachedDeviceId: cachedDeviceId,
      version: '2.33.0',
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

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[SHUTDOWN] Recebido ${signal}. Encerrando servidor...`);

  server.close((err) => {
    if (err) {
      console.error('[SHUTDOWN] Erro ao fechar o servidor:', err);
      process.exitCode = 1;
      return;
    }
    console.log('[SHUTDOWN] Servidor encerrado com sucesso.');
    process.exit(0);
  });

  setTimeout(() => {
    console.error('[SHUTDOWN] Encerramento forçado após timeout.');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  console.error('[PROCESS][FATAL] Uncaught exception:');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[PROCESS][FATAL] Unhandled rejection:');
  console.error(reason && reason.stack ? reason.stack : reason);
  process.exit(1);
});

console.log(`[BOOT] Preparando listener HTTP em ${HOST}:${PORT}...`);

server.on('error', (err) => {
  console.error('[HTTP][FATAL] Falha ao iniciar o listener HTTP:');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('=====================================================');
  console.log('🚀 SUPER CLIENT SERVER EM EXECUÇÃO!');
  console.log(`🌐 Bind: http://${HOST}:${PORT}`);
  console.log(`🔌 Proxy SuperLive API: /api/v1/`);
  console.log(`📱 Device-ID: ${cachedDeviceId}`);
  console.log(`❤️ Health check: /healthz`);
  console.log('=====================================================');
});
