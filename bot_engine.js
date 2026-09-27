/**
 * SUPER CLIENT — Live Bot & Moderation Engine
 * Handles real-time live monitoring, automated word moderation (mute/ban),
 * recurring chat announcement queues, and post-live DM statistical summaries.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const CONFIG_FILE = path.join(__dirname, 'bot_config.json');
const REMOTE_API_HOST = 'api.sprlv-api.com';
const REMOTE_WS_HOST = 'wss://ws.sprlv-api.com';

const DEFAULT_CONFIG = {
  creatorUserId: '25302248',
  livestreamId: '',
  autoDetectLive: true,
  // Moderação
  moderationEnabled: true,
  muteWords: ['palavrao', 'xingamento', 'ofensa', 'lixo', 'trouxa', 'golpe', 'fake'],
  banWords: ['pedofilia', 'menor', 'crime', 'droga', 'estelionato', 'pix falso'],
  caseSensitive: false,
  exactMatch: false,
  // Mensagens Recorrentes na Live
  recurringEnabled: true,
  recurringIntervalSeconds: 120, // 2 minutos
  recurringMessages: [
    '✨ Bem-vindos à live! Siga o perfil da criadora para não perder transmissões exclusivas!',
    '🎁 Envie presentes para apoiarmos a transmissão e batermos a meta de hoje!',
    '📸 Acompanhe as novidades e bastidores também no Instagram! Compartilhe a live com os amigos!'
  ],
  recurringCurrentIndex: 0,
  // Mensagem Automática pós-live na DM
  dmEnabled: true,
  dmTemplate: 'Live finalizada! Hoje você alcançou {viewers} espectadores e gerou {diamonds} diamantes na transmissão. Parabéns pelo show! ❤️',
  // Conta oficial do robô
  botToken: '1a5e3accb98f0827677f546a61c0bc36d7d89907',
  botUserId: '32037361',
  botName: '𝑨́𝒕𝒊𝒍𝒂',
  deviceId: 'e7a42524b5241eb9a73f28bc11b4f2ed'
};

class BotEngine {
  constructor() {
    this.config = this.loadConfig();
    this.ws = null;
    this.wsConnected = false;
    this.authFailed = false;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.syncPollTimer = null;
    this.recurringTimer = null;
    this.countdownSeconds = this.config.recurringIntervalSeconds || 120;

    this.activeLive = null;
    this.isMonitoring = false;
    this.processedMessageIds = new Set();
    this.chatFeed = [];
    this.moderationLogs = db.getAuditLogs(100);
    this.systemLogs = db.getSystemLogs(200);
    this.stats = {
      messagesAnalyzed: 0,
      usersMuted: 0,
      usersBanned: 0,
      announcementsSent: 0,
      dmsSent: 0,
      peakViewers: 0,
      currentDiamonds: 0
    };
    this.watchdogTimer = null;
    this.userCache = new Map();
    this.pendingResolutions = new Set();

    this.logSystem('SYSTEM', 'INFO', 'Engine Super Client iniciada com sucesso. Servidor operacional.');
    // Conecta imediatamente ao WebSocket oficial para prontidão
    setTimeout(() => this.connectWebSocket(), 800);
  }

  // --- Resolução de Perfil de Usuário para Chat Real-Time ---
  async resolveUserProfile(userId) {
    if (!userId || this.userCache.has(userId) || this.pendingResolutions.has(userId)) return;
    this.pendingResolutions.add(userId);
    try {
      const profRes = await this.apiRequest('users/profile', { user_id: String(userId) });
      if (profRes && profRes.user) {
        const u = profRes.user;
        const realName = u.name || u.shared_id || `Usuário #${userId}`;
        const realAvatar = (u.profile_images && u.profile_images[0] ? u.profile_images[0].url : (u.profile_image ? u.profile_image.url : '')) || '';
        this.userCache.set(userId, { name: realName, avatar: realAvatar });

        // Atualiza retroativamente no feed de chat existente
        for (const msg of this.chatFeed) {
          if (String(msg.user_id) === String(userId)) {
            msg.name = realName;
            msg.user_name = realName;
            if (realAvatar && !msg.picture_url) msg.picture_url = realAvatar;
          }
        }
      }
    } catch (e) {
      // ignore
    } finally {
      this.pendingResolutions.delete(userId);
    }
  }

  loadConfig() {
    try {
      return db.getConfig();
    } catch (e) {
      console.error('[BOT] Erro ao carregar config do db:', e.message);
      return { ...DEFAULT_CONFIG };
    }
  }

  saveConfig(newConfig, shouldRestartQueue = true) {
    const previousToken = this.config.botToken;
    this.config = db.saveConfig(newConfig);

    if (newConfig && newConfig.botToken && newConfig.botToken !== previousToken) {
      this.authFailed = false;
      if (this.ws) {
        try { this.ws.close(); } catch (e) {}
      }
      setTimeout(() => this.connectWebSocket(), 500);
    }

    if (shouldRestartQueue) {
      this.startRecurringQueue();
    }
    return this.config;
  }

  // --- Requisições REST Auxiliares para o SuperLive ---
  apiRequest(apiPath, body = {}, forceNoToken = false) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const isPublicPath = ['users/search', 'users/profile', 'livestream/retrieve'].includes(apiPath);
      const headers = {
        'Content-Type': 'application/json; charset=UTF-8',
        'Accept': 'application/json',
        'User-Agent': 'SuperLive/2.31.0 (samsung SM-G998B; Android 13; Scale/3.0)',
        'Device-ID': this.config.deviceId,
        'Content-Length': Buffer.byteLength(payload)
      };

      if (this.config.botToken && !this.authFailed && !forceNoToken && !isPublicPath) {
        headers['Authorization'] = `Token ${this.config.botToken}`;
      }

      const req = https.request({
        hostname: REMOTE_API_HOST,
        port: 443,
        path: `/api/v1/${apiPath}`,
        method: 'POST',
        headers
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json && json.error && (json.error.code === '2' || json.error.code === 2 || String(json.error.message).includes('logged out'))) {
              this.authFailed = true;
              console.warn(`[BOT API] Token expirado detectado na rota ${apiPath}. Retentando imediatamente em Modo Device-ID...`);
              return this.apiRequest(apiPath, body, true).then(resolve).catch(reject);
            }
            resolve(json);
          } catch (e) {
            resolve({ raw: data, status: res.statusCode });
          }
        });
      });

      req.on('error', (err) => {
        this.logSystem('API', 'ERROR', `Falha de rede em /api/v1/${apiPath}: ${err.message}`);
        reject(err);
      });

      req.write(payload);
      req.end();
    });
  }

  // --- WebSocket Manager ---
  connectWebSocket() {
    // Conecta somente se estiver ativamente monitorando ou conectado a uma live
    if (!this.isMonitoring && !this.activeLive) {
      return;
    }

    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) {
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const hasValidToken = this.config.botToken && !this.authFailed;
    const wsUrl = hasValidToken
      ? `${REMOTE_WS_HOST}?device=${this.config.deviceId}&auth=${this.config.botToken}`
      : `${REMOTE_WS_HOST}?device=${this.config.deviceId}`;

    this.logSystem('WS', 'INFO', `Iniciando conexão WebSocket oficial (${hasValidToken ? 'Token' : 'Device-ID'})...`);

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.wsConnected = true;
        this.logSystem('WS', 'SUCCESS', `Conexão WebSocket estabelecida com sucesso! (${hasValidToken ? 'Autenticado' : 'Device-ID'})`);
        this.startHeartbeat();

        // Se estiver monitorando live ativa, entra na sala da transmissão
        if (this.activeLive && this.activeLive.livestream_id) {
          this.sendWsEnterLive(this.activeLive.livestream_id);
        }
      };

      this.ws.onmessage = (event) => {
        this.handleWsMessage(event.data);
      };

      this.ws.onerror = (err) => {
        this.logSystem('WS', 'ERROR', `Erro de conexão WebSocket: ${err && err.message ? err.message : err}`);
      };

      this.ws.onclose = (evt) => {
        this.wsConnected = false;
        this.stopHeartbeat();

        if (evt.reason === 'duplicate_connection') {
          this.config.deviceId = crypto.randomBytes(16).toString('hex');
          db.saveConfig({ deviceId: this.config.deviceId });
          this.logSystem('WS', 'INFO', `Conexão simultânea evitada. Novo Device-ID único gerado: ${this.config.deviceId}`);
        }

        // Não reconecta se a moderação estiver parada
        if (!this.isMonitoring && !this.activeLive) {
          return;
        }

        const waitTime = evt.reason === 'duplicate_connection' ? 5000 : 3000;
        this.logSystem('WS', 'WARN', `Conexão WebSocket finalizada (código: ${evt.code}, motivo: ${evt.reason || 'N/A'}). Reconectando em ${waitTime / 1000}s...`);

        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
          if (this.isMonitoring || this.activeLive) {
            this.connectWebSocket();
          }
        }, waitTime);
      };
    } catch (e) {
      this.logSystem('WS', 'ERROR', `Falha ao instanciar WebSocket: ${e.message}`);
    }
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === 1) {
        const liveId = this.activeLive ? this.activeLive.livestream_id : null;
        this.ws.send(JSON.stringify({
          id: `hb-${Date.now()}`,
          action: 'heartbeat',
          data: {
            state: liveId ? `livestream:${liveId}` : 'general'
          }
        }));
      }
    }, 5000);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  sendWsEnterLive(livestreamId) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify({
        id: `enter-${Date.now()}`,
        action: 'enter_livestream',
        data: { livestream_id: String(livestreamId) }
      }));
      console.log(`[BOT WS] Comando enter_livestream enviado para live #${livestreamId}`);
    }
  }

  sendWsLeaveLive(livestreamId) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify({
        id: `leave-${Date.now()}`,
        action: 'leave_livestream',
        data: { livestream_id: String(livestreamId) }
      }));
    }
  }

  handleWsMessage(raw) {
    try {
      const msg = JSON.parse(raw);
      if (!msg || !msg.type) return;

      if (msg.type === 'invalid_auth') {
        if (!this.authFailed) {
          this.logSystem('WS', 'INFO', 'WebSocket operando em Modo Device-ID (escuta em tempo real do chat e eventos da live).');
          this.authFailed = true;
        }
        return;
      }

      // Eventos relevantes da Live
      switch (msg.type) {
        case 'livestream_message_sent':
          if (msg.data) {
            this.onChatMessage(msg.data);
          }
          break;
        case 'livestream_ended':
          this.logSystem('SYSTEM', 'INFO', 'Evento de live finalizada recebido via WebSocket.');
          this.onLiveEnded();
          break;
        case 'livestream_diamonds_update':
          if (msg.data && msg.data.diamond_count !== undefined) {
            this.stats.currentDiamonds = msg.data.diamond_count;
            if (this.activeLive) this.activeLive.live_diamonds = msg.data.diamond_count;
          }
          break;
        case 'livestream_viewers_update':
          if (msg.data && msg.data.viewers_count !== undefined) {
            const v = msg.data.viewers_count;
            if (v > this.stats.peakViewers) this.stats.peakViewers = v;
            if (this.activeLive) this.activeLive.viewer_count = v;
          }
          break;
        case 'livestream_modded':
          console.log('[BOT] Robô recebeu status de MODERADOR na live!');
          if (this.activeLive) this.activeLive.is_modded = true;
          this.logAction('SYSTEM', 'Permissão de Moderador confirmada na live!', '', 'MOD_CONFIRMED');
          break;
        case 'livestream_unmodded':
          console.log('[BOT] Status de moderador alterado.');
          if (this.activeLive) this.activeLive.is_modded = false;
          break;
      }
    } catch (e) {
      // Ignora frames não-JSON
    }
  }

  // --- Normalizador de Texto para Verificação de Palavras ---
  normalizeText(text) {
    if (!text) return '';
    let str = String(text);
    if (!this.config.caseSensitive) {
      str = str.toLowerCase();
    }
    // Remove diacríticos e acentos
    str = str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return str;
  }

  containsProhibitedWord(messageText, wordsList) {
    if (!wordsList || wordsList.length === 0 || !messageText) return null;
    const cleanText = this.normalizeText(messageText);

    for (const rawWord of wordsList) {
      const cleanWord = this.normalizeText(rawWord.trim());
      if (!cleanWord) continue;

      if (this.config.exactMatch) {
        const regex = new RegExp(`(^|\\s|[.,!?;])${cleanWord}($|\\s|[.,!?;])`, 'i');
        if (regex.test(cleanText)) {
          return rawWord;
        }
      } else {
        if (cleanText.includes(cleanWord)) {
          return rawWord;
        }
      }
    }
    return null;
  }

  // --- Processamento de Mensagens do Chat ---
  async onChatMessage(data) {
    const messageId = String(data.message_id || `${data.user_id}_${data.text}_${Date.now()}`);
    if (this.processedMessageIds.has(messageId)) {
      return;
    }
    this.processedMessageIds.add(messageId);
    if (this.processedMessageIds.size > 2000) {
      const arr = Array.from(this.processedMessageIds);
      this.processedMessageIds = new Set(arr.slice(arr.length - 1000));
    }

    const userId = String(data.user_id || '');
    let userName = data.name || data.user_name || '';
    let pictureUrl = data.picture_url || '';

    // Verifica se temos no cache de usuários previamente resolvidos
    if (this.userCache.has(userId)) {
      const cached = this.userCache.get(userId);
      if (!userName || userName === 'Usuário' || userName.toLowerCase().includes('anon')) {
        userName = cached.name;
      }
      if (!pictureUrl && cached.avatar) {
        pictureUrl = cached.avatar;
      }
    }

    // Se o nome vier anônimo ou vazio, inicia resolução e exibe identificador amigável
    if (!userName || userName === 'Usuário' || userName.toLowerCase().includes('anon')) {
      if (userId) {
        userName = `Usuário #${userId}`;
        // Resolve em background o perfil oficial via users/profile
        this.resolveUserProfile(userId);
      } else {
        userName = 'Usuário';
      }
    }

    const text = data.text || '';
    const livestreamId = String(data.livestream_id || (this.activeLive ? this.activeLive.livestream_id : ''));
    const timeStr = new Date().toLocaleTimeString('pt-BR');

    // Adiciona ao feed de chat visual da interface com múltiplos aliases para compatibilidade
    const chatItem = {
      id: messageId,
      user_id: userId,
      name: userName,
      user_name: userName,
      text: text,
      picture_url: pictureUrl,
      level: data.level || 0,
      time: timeStr,
      timestamp: timeStr
    };
    this.chatFeed.unshift(chatItem);
    if (this.chatFeed.length > 100) this.chatFeed.pop();

    this.stats.messagesAnalyzed++;

    // Não modera mensagens da própria conta do robô
    if (userId === String(this.config.botUserId)) {
      return;
    }

    if (!this.config.moderationEnabled) {
      return;
    }

    // 1. Checa Palavras para BANIR (Kick permanente)
    const banWord = this.containsProhibitedWord(text, this.config.banWords);
    if (banWord) {
      console.warn(`[BOT MODERAÇÃO] BAN acionado para "${userName}" (ID: ${userId}) por usar "${banWord}"`);
      await this.executeBan(livestreamId, userId, userName, text, banWord);
      return;
    }

    // 2. Checa Palavras para SILENCIAR (Mute)
    const muteWord = this.containsProhibitedWord(text, this.config.muteWords);
    if (muteWord) {
      console.warn(`[BOT MODERAÇÃO] MUTE acionado para "${userName}" (ID: ${userId}) por usar "${muteWord}"`);
      await this.executeMute(livestreamId, userId, userName, text, muteWord);
      return;
    }
  }

  // --- Ações de Moderação Reais ---
  async executeMute(livestreamId, userId, userName, text, triggerWord) {
    try {
      const res = await this.apiRequest('livestream/chat/mute', {
        livestream_id: String(livestreamId),
        user_id: String(userId)
      });

      const success = !res.error;
      this.stats.usersMuted++;
      this.logAction('MUTE', `Usuário "${userName}" foi silenciado no chat.`, triggerWord, success ? 'SUCESSO' : 'ERRO', {
        user_id: userId,
        user_name: userName,
        message: text,
        api_response: res
      });
      console.log(`[BOT MODERAÇÃO] Resultado Mute:`, res);
    } catch (e) {
      this.logAction('MUTE', `Falha ao silenciar "${userName}": ${e.message}`, triggerWord, 'ERRO');
    }
  }

  async executeBan(livestreamId, userId, userName, text, triggerWord) {
    try {
      const res = await this.apiRequest('livestream/kick', {
        livestream_id: String(livestreamId),
        user_id: String(userId),
        permanent: true
      });

      const success = !res.error;
      this.stats.usersBanned++;
      this.logAction('BAN', `Usuário "${userName}" foi BANIDO permanentemente da live.`, triggerWord, success ? 'SUCESSO' : 'ERRO', {
        user_id: userId,
        user_name: userName,
        message: text,
        api_response: res
      });
      console.log(`[BOT MODERAÇÃO] Resultado Ban:`, res);
    } catch (e) {
      this.logAction('BAN', `Falha ao banir "${userName}": ${e.message}`, triggerWord, 'ERRO');
    }
  }

  async executeUnmute(livestreamId, userId, userName) {
    try {
      const res = await this.apiRequest('livestream/chat/unmute', {
        livestream_id: String(livestreamId),
        user_id: String(userId)
      });
      const success = !res.error;
      this.logAction('SYSTEM', `Usuário "${userName}" teve o silenciamento revogado.`, '', success ? 'SUCESSO' : 'ERRO');
      return res;
    } catch (e) {
      return { error: e.message };
    }
  }

  // --- Envio de Mensagem no Chat da Live ---
  async sendChatMessage(text, livestreamId = null) {
    let liveId = livestreamId || (this.activeLive ? this.activeLive.livestream_id : null) || this.config.livestreamId;
    
    // Se não tiver liveId imediato, tenta detectar automaticamente se a criadora está ao vivo
    if (!liveId && this.config.creatorUserId) {
      try {
        const detected = await this.detectCreatorLive(this.config.creatorUserId);
        if (detected && detected.livestreamId) {
          liveId = detected.livestreamId;
          this.config.livestreamId = String(liveId);
          this.saveConfig(this.config);
        }
      } catch (e) {
        // segue para validação
      }
    }

    if (!liveId) {
      throw new Error('Nenhuma live ativa especificada para envio de mensagem no chat. Informe o ID da live ou ligue sua transmissão.');
    }

    const payload = {
      guid: crypto.randomUUID(),
      livestream_id: String(liveId),
      text: String(text),
      tagged_user_id: null,
      tagged_user_name: null
    };

    const res = await this.apiRequest('livestream/chat/send_text_message', payload);
    if (res.error) {
      console.error('[BOT CHAT ERROR]:', res.error);
    } else {
      console.log(`[BOT CHAT] Mensagem enviada na live #${liveId}: "${text}" (Msg ID: ${res.message_id})`);
    }
    return res;
  }

  // --- Disparo Imediato da Próxima Mensagem Recorrente (Teste ou Manual) ---
  async triggerRecurringMessageNow(livestreamId = null) {
    let msgs = this.config.recurringMessages;
    if (!msgs || msgs.length === 0) {
      msgs = DEFAULT_CONFIG.recurringMessages || [];
      this.config.recurringMessages = [...msgs];
      this.saveConfig(this.config);
    }
    if (!msgs || msgs.length === 0) {
      throw new Error('A fila de mensagens recorrentes está vazia. Adicione ao menos uma mensagem para enviar.');
    }

    const idx = (this.config.recurringCurrentIndex || 0) % msgs.length;
    const msgToSend = msgs[idx];
    const liveId = livestreamId || (this.activeLive ? this.activeLive.livestream_id : null) || this.config.livestreamId;

    const res = await this.sendChatMessage(msgToSend, liveId);
    const isSuccess = !res || !res.error;

    if (isSuccess) {
      this.stats.announcementsSent++;
      db.incrementRecurringSendCount(idx);
      this.logAction('ANNOUNCEMENT', `Aviso #${idx + 1} disparado com sucesso: "${msgToSend}"`, '', 'SUCESSO');
    } else {
      this.logAction('ANNOUNCEMENT', `Falha ao disparar aviso #${idx + 1}: ${res && res.error ? (res.error.message || JSON.stringify(res.error)) : 'Erro desconhecido'}`, '', 'ERRO');
    }

    // Avança para a próxima mensagem da fila (cíclica)
    this.config.recurringCurrentIndex = (idx + 1) % msgs.length;
    this.saveConfig({ recurringCurrentIndex: this.config.recurringCurrentIndex });
    this.countdownSeconds = Number(this.config.recurringIntervalSeconds) || 120;

    return {
      success: isSuccess,
      sentMessage: msgToSend,
      messageIndex: idx + 1,
      totalMessages: msgs.length,
      nextIndex: this.config.recurringCurrentIndex + 1,
      apiResponse: res
    };
  }

  // --- Fila de Mensagens Recorrentes na Live ---
  startRecurringQueue() {
    this.stopRecurringQueue();
    if (!this.config.recurringEnabled) {
      this.countdownSeconds = Number(this.config.recurringIntervalSeconds) || 120;
      return;
    }

    if (!this.config.recurringMessages || this.config.recurringMessages.length === 0) {
      this.config.recurringMessages = [...DEFAULT_CONFIG.recurringMessages];
    }

    if (!this.countdownSeconds || this.countdownSeconds <= 0) {
      this.countdownSeconds = Number(this.config.recurringIntervalSeconds) || 120;
    }

    console.log(`[BOT RECORRENTE] Fila ativa com ${this.config.recurringMessages.length} mensagens. Intervalo: ${this.config.recurringIntervalSeconds}s (Countdown atual: ${this.countdownSeconds}s)`);

    this.recurringTimer = setInterval(async () => {
      // Se mensagens recorrentes forem desativadas
      if (!this.config.recurringEnabled) {
        return;
      }

      // O contador avança quando o robô estiver ativo no monitoramento
      if (!this.isMonitoring) {
        return;
      }

      this.countdownSeconds--;

      if (this.countdownSeconds <= 0) {
        // Reseta o contador para o próximo ciclo
        this.countdownSeconds = Number(this.config.recurringIntervalSeconds) || 120;

        const msgs = this.config.recurringMessages;
        if (msgs && msgs.length > 0) {
          const idx = (this.config.recurringCurrentIndex || 0) % msgs.length;
          const msgToSend = msgs[idx];
          const liveId = (this.activeLive ? this.activeLive.livestream_id : null) || this.config.livestreamId;

          if (liveId) {
            try {
              console.log(`[BOT RECORRENTE] Enviando mensagem automática #${idx + 1} para live #${liveId}: "${msgToSend}"`);
              const res = await this.sendChatMessage(msgToSend, liveId);
              if (!res || !res.error) {
                this.stats.announcementsSent++;
                this.logAction('ANNOUNCEMENT', `Aviso #${idx + 1} enviado na live #${liveId}: "${msgToSend}"`, '', 'SUCESSO');
              } else {
                this.logAction('ANNOUNCEMENT', `Falha ao enviar aviso #${idx + 1}: ${res && res.error ? JSON.stringify(res.error) : 'Erro'}`, '', 'ERRO');
              }
            } catch (e) {
              this.logAction('ANNOUNCEMENT', `Falha ao enviar aviso #${idx + 1}: ${e.message}`, '', 'ERRO');
            }
          } else {
            console.log(`[BOT RECORRENTE] Ciclo #${idx + 1} acionado, aguardando início/ID da transmissão.`);
          }

          // Avança ciclicamente para a próxima mensagem da fila (01 -> 02 -> 03 -> 01...)
          this.config.recurringCurrentIndex = (idx + 1) % msgs.length;
          this.saveConfig({ recurringCurrentIndex: this.config.recurringCurrentIndex }, false);
        }
      }
    }, 1000);
  }

  stopRecurringQueue() {
    if (this.recurringTimer) {
      clearInterval(this.recurringTimer);
      this.recurringTimer = null;
    }
  }

  // --- Detecção de Live e Inicialização do Monitoramento ---
  async detectCreatorLive(creatorInput) {
    const raw = String(creatorInput || this.config.creatorUserId || '').trim();
    if (!raw) {
      throw new Error('Informe o ID da sua Live ou da sua Conta.');
    }

    console.log(`[BOT DETECT] Checando identificador informado: "${raw}"...`);

    let targetUser = null;
    let targetLiveId = null;
    let streamDetails = null;

    // 1. Busca por users/search (busca exata por shared_id, user_id, username ou nome)
    try {
      const searchRes = await this.apiRequest('users/search', { search_query: raw });
      if (searchRes && searchRes.items && searchRes.items.length > 0) {
        // Correspondência exata prioritária por shared_id, user_id ou username
        let match = searchRes.items.find(it => 
          String(it.shared_id) === raw || 
          String(it.user_id) === raw || 
          (it.username && String(it.username).toLowerCase() === raw.toLowerCase())
        );

        // Se a busca não for puramente numérica, tenta correspondência por nome
        if (!match && isNaN(Number(raw))) {
          match = searchRes.items.find(it => 
            it.name && it.name.toLowerCase().includes(raw.toLowerCase())
          ) || searchRes.items[0];
        }

        if (match) {
          targetUser = match;
          if (match.livestream_id) {
            targetLiveId = String(match.livestream_id);
          }
        }
      }
    } catch (e) {
      console.error('[BOT DETECT] Erro em users/search:', e.message);
    }

    // 2. Se não encontrou, tenta users/profile diretamente caso seja ID de usuário
    if (!targetUser) {
      try {
        const profRes = await this.apiRequest('users/profile', { user_id: raw });
        if (profRes && profRes.user && !profRes.error) {
          if (String(profRes.user.user_id) === raw || String(profRes.user.shared_id) === raw) {
            targetUser = profRes.user;
            if (profRes.user.livestream_id) {
              targetLiveId = String(profRes.user.livestream_id);
            }
          }
        }
      } catch (e) {}
    }

    // 3. Se ainda não encontrou como usuário, verifica se é o ID de uma live ativa em andamento
    if (!targetUser) {
      try {
        const liveRes = await this.apiRequest('livestream/retrieve', { livestream_id: raw });
        if (liveRes && !liveRes.error && liveRes.stream_details) {
          const sd = liveRes.stream_details;
          const u = liveRes.user || {};
          // Só aceita como live ativa se ela NÃO estiver finalizada
          if (!sd.finished_at) {
            targetLiveId = String(raw);
            streamDetails = sd;
            targetUser = u;
          }
        }
      } catch (e) {}
    }

    // 4. Se encontrou o usuário, obtém dados completos do perfil via users/profile
    if (targetUser) {
      const internalId = String(targetUser.user_id);
      try {
        const fullProf = await this.apiRequest('users/profile', { user_id: internalId });
        if (fullProf && fullProf.user && !fullProf.error) {
          targetUser = { ...targetUser, ...fullProf.user };
          if (fullProf.user.livestream_id) {
            targetLiveId = String(fullProf.user.livestream_id);
          }
        }
      } catch (e) {}

      // Se há um livestream_id ativo, obtém stream_details atualizados
      if (targetLiveId && !streamDetails) {
        try {
          const liveRes = await this.apiRequest('livestream/retrieve', { livestream_id: targetLiveId });
          if (liveRes && liveRes.stream_details && !liveRes.stream_details.finished_at) {
            streamDetails = liveRes.stream_details;
          } else if (liveRes && liveRes.stream_details && liveRes.stream_details.finished_at) {
            targetLiveId = null;
          }
        } catch (e) {}
      }

      const avatarUrl = (targetUser.profile_images && targetUser.profile_images[0] ? targetUser.profile_images[0].url : null)
        || (targetUser.profile_image ? (targetUser.profile_image.url || targetUser.profile_image.thumbnail_url) : null);

      const isLive = !!targetLiveId && (!streamDetails || !streamDetails.finished_at);

      this.logSystem('SYSTEM', 'SUCCESS', `Perfil localizado: "${targetUser.name}" (ID: ${targetUser.user_id}, Shared: ${targetUser.shared_id || raw}). Ao vivo: ${isLive ? 'SIM (#' + targetLiveId + ')' : 'NÃO (Vigilante)'}`);

      const creatorResult = {
        userId: String(targetUser.user_id),
        sharedId: String(targetUser.shared_id || raw),
        name: targetUser.name || 'Criadora',
        username: targetUser.username || '',
        avatar: avatarUrl,
        isLive: isLive,
        liveFound: isLive,
        livestreamId: isLive ? targetLiveId : null,
        headline: streamDetails ? (streamDetails.headline || 'Live ao Vivo') : 'Live ao Vivo',
        viewers: streamDetails ? (streamDetails.viewer_count || 0) : 0,
        diamonds: targetUser.diamonds || (streamDetails ? streamDetails.livestream_diamonds : 0) || 0,
        followers: targetUser.follower_count || 0,
        is_modded: streamDetails ? !!streamDetails.is_modded : false
      };

      // Persiste perfil da criadora no banco de dados
      db.setActiveCreator(creatorResult);

      return creatorResult;
    }

    throw new Error(`Nenhum perfil ou live encontrado com o identificador: "${raw}". Verifique se o ID ou nome de usuário está correto.`);
  }

  async startMonitoring({ livestreamId, creatorUserId }) {
    let targetLiveId = livestreamId;
    let creatorInfo = null;

    if (creatorUserId) {
      this.config.creatorUserId = String(creatorUserId);
      this.saveConfig(this.config);
    }

    if (!targetLiveId && this.config.creatorUserId) {
      try {
        const detected = await this.detectCreatorLive(this.config.creatorUserId);
        creatorInfo = detected;
        if (detected.isLive && detected.livestreamId) {
          targetLiveId = detected.livestreamId;
        }
      } catch (e) {
        // Ignora erro inicial para entrar em modo vigilante
      }
    }

    this.isMonitoring = true;
    this.startRecurringQueue();

    if (targetLiveId) {
      // Live já está aberta! Conecta imediatamente
      await this.attachLive(targetLiveId, creatorInfo);
    } else {
      // Live ainda não começou: entra no Modo Vigilante
      this.activeLive = null;
      this.startWatchdog(this.config.creatorUserId);
      this.logAction('SYSTEM', `Robô ativado em Modo Vigilante! Monitorando ID ${this.config.creatorUserId}. Assim que a live começar, o robô entrará automaticamente.`, '', 'VIGILANTE');
      console.log(`[BOT] Modo Vigilante iniciado para a conta ID ${this.config.creatorUserId}`);
    }

    return this.getStatus();
  }

  async attachLive(livestreamId, creatorInfo) {
    this.stopWatchdog();
    this.config.livestreamId = String(livestreamId);
    this.saveConfig(this.config);

    const retrieveRes = await this.apiRequest('livestream/retrieve', { livestream_id: String(livestreamId) });
    const streamDetails = retrieveRes.stream_details || {};
    const creatorUser = retrieveRes.user || (creatorInfo ? { name: creatorInfo.name, user_id: creatorInfo.userId } : {});

    this.activeLive = {
      livestream_id: String(livestreamId),
      creator_name: creatorUser.name || 'Criadora',
      creator_user_id: String(creatorUser.user_id || this.config.creatorUserId || ''),
      headline: streamDetails.headline || 'Live ao Vivo',
      viewer_count: streamDetails.viewer_count || 0,
      live_diamonds: streamDetails.livestream_diamonds || 0,
      total_diamonds: streamDetails.diamond_count || 0,
      is_modded: !!streamDetails.is_modded,
      thumbnail_url: creatorUser.profile_images && creatorUser.profile_images[0] ? creatorUser.profile_images[0].url : (creatorUser.profile_image ? creatorUser.profile_image.url : null),
      started_at: Date.now()
    };

    this.stats.peakViewers = this.activeLive.viewer_count;
    this.stats.currentDiamonds = this.activeLive.live_diamonds;

    console.log(`[BOT] Conectado à Live #${livestreamId} (${this.activeLive.creator_name})`);
    this.logAction('SYSTEM', `Robô conectado na live #${livestreamId} (${this.activeLive.creator_name})! Status moderador: ${this.activeLive.is_modded ? 'AUTORIZADO (Moderador)' : 'Aguardando Permissão'}`, '', 'ONLINE');

    this.connectWebSocket();
    this.sendWsEnterLive(livestreamId);
    this.startDualSync(livestreamId);
    this.startRecurringQueue();
  }

  startWatchdog(creatorUserId) {
    this.stopWatchdog();
    this.watchdogTimer = setInterval(async () => {
      if (!this.isMonitoring || this.activeLive) {
        this.stopWatchdog();
        return;
      }
      try {
        const detected = await this.detectCreatorLive(creatorUserId);
        if (detected && detected.isLive && detected.livestreamId) {
          console.log(`[BOT WATCHDOG] Live iniciada detectada! ID: ${detected.livestreamId}`);
          await this.attachLive(detected.livestreamId, detected);
        }
      } catch (e) {
        // Silencioso
      }
    }, 3000);
  }

  stopWatchdog() {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  stopMonitoring() {
    this.stopWatchdog();
    if (this.activeLive && this.activeLive.livestream_id) {
      this.sendWsLeaveLive(this.activeLive.livestream_id);
    }
    this.stopDualSync();
    this.stopRecurringQueue();
    this.isMonitoring = false;
    this.activeLive = null;
    this.countdownSeconds = Number(this.config.recurringIntervalSeconds) || 120;
    this.chatFeed = [];
    this.logAction('SYSTEM', 'Monitoramento pausado. Robô pronto e aguardando sua live.', '', 'AGUARDANDO');
    console.log('[BOT] Monitoramento pausado e sala limpa.');
    return this.getStatus();
  }

  // Polling auxiliar para garantir captura 100% livre de quedas de rede
  startDualSync(livestreamId) {
    this.stopDualSync();

    // Busca mensagens iniciais imediatamente
    this.pollInitialMessages(livestreamId);

    this.syncPollTimer = setInterval(async () => {
      if (!this.isMonitoring || !this.activeLive) return;

      // 1. Sincroniza mensagens do chat
      await this.pollInitialMessages(livestreamId);

      // 2. Sincroniza estatísticas e checa se a live encerrou
      await this.pollLiveStats(livestreamId);
    }, 3000);
  }

  stopDualSync() {
    if (this.syncPollTimer) {
      clearInterval(this.syncPollTimer);
      this.syncPollTimer = null;
    }
  }

  async pollInitialMessages(livestreamId) {
    try {
      const res = await this.apiRequest('livestream/initial_messages', { livestream_id: String(livestreamId) });
      if (res.messages && Array.isArray(res.messages)) {
        for (const msg of res.messages) {
          await this.onChatMessage({
            message_id: msg.message_id || `${msg.user_id}_${msg.text}`,
            user_id: msg.user_id,
            name: msg.name,
            text: msg.text,
            picture_url: msg.picture_url,
            level: msg.level,
            livestream_id: livestreamId
          });
        }
      }
    } catch (e) {
      // ignore
    }
  }

  async pollLiveStats(livestreamId) {
    try {
      const res = await this.apiRequest('livestream/retrieve', { livestream_id: String(livestreamId) });
      if (res.stream_details) {
        const sd = res.stream_details;
        const v = sd.viewer_count || 0;
        const d = sd.livestream_diamonds || 0;

        if (this.activeLive) {
          this.activeLive.viewer_count = v;
          this.activeLive.live_diamonds = d;
          this.activeLive.is_modded = !!sd.is_modded;
        }

        if (v > this.stats.peakViewers) this.stats.peakViewers = v;
        this.stats.currentDiamonds = d;

        // Se a live foi encerrada
        if (sd.finished_at) {
          console.log('[BOT] Live encerrada detectada via retrieve (finished_at preenchido)!');
          await this.onLiveEnded();
        }
      }
    } catch (e) {
      // ignore
    }
  }

  // --- Finalização da Live e Envio Automático de DM com Resumo ---
  async onLiveEnded() {
    if (!this.activeLive) return;

    const liveId = this.activeLive.livestream_id;
    const creatorUserId = this.activeLive.creator_user_id || this.config.creatorUserId;
    const creatorName = this.activeLive.creator_name || 'Criadora';

    console.log(`[BOT] Finalizando sessão da live #${liveId}...`);
    this.stopDualSync();
    this.stopRecurringQueue();
    this.isMonitoring = false;

    // Coleta estatísticas consolidadas
    let finalViewers = this.stats.peakViewers || this.activeLive.viewer_count || 0;
    let finalDiamonds = this.stats.currentDiamonds || this.activeLive.live_diamonds || 0;
    let finalFollowers = 0;
    let durationStr = 'N/A';

    if (this.activeLive.started_at) {
      const diffMs = Date.now() - this.activeLive.started_at;
      const mins = Math.floor(diffMs / 60000);
      const hours = Math.floor(mins / 60);
      durationStr = hours > 0 ? `${hours}h ${mins % 60}min` : `${mins}min`;
    }

    // Tenta obter dados adicionais de livestream/statistics se disponível
    try {
      const statsRes = await this.apiRequest('livestream/statistics', { livestream_id: String(liveId) });
      if (statsRes.statistics) {
        const s = statsRes.statistics;
        if (s.overall_viewer_count) finalViewers = s.overall_viewer_count;
        if (s.earned_diamonds) finalDiamonds = s.earned_diamonds;
        if (s.gained_followers) finalFollowers = s.gained_followers;
      }
    } catch (e) {}

    this.logAction('SYSTEM', `Live #${liveId} encerrada! Estatísticas: ${finalViewers} espectadores únicos, ${finalDiamonds} diamantes, duração ${durationStr}.`, '', 'LIVE_ENDED');

    // Registra sessão no banco de dados persistente
    try {
      db.recordLiveSession({
        livestream_id: liveId,
        creator_name: creatorName,
        creator_user_id: creatorUserId,
        headline: this.activeLive.headline,
        peak_viewers: finalViewers,
        total_diamonds: finalDiamonds,
        started_at: this.activeLive.started_at,
        duration: durationStr
      });
    } catch (e) {}

    // Envio de DM à criadora
    if (this.config.dmEnabled && creatorUserId) {
      await this.sendEndOfLiveDM({
        creatorUserId,
        creatorName,
        viewers: finalViewers,
        diamonds: finalDiamonds,
        followers: finalFollowers,
        duration: durationStr
      });
    }

    this.activeLive = null;
  }

  async sendEndOfLiveDM({ creatorUserId, creatorName, viewers, diamonds, followers, duration }) {
    try {
      console.log(`[BOT DM] Preparando envio de resumo para a criadora ID ${creatorUserId}...`);

      // 1. Obtém conversation_id da criadora
      const infoRes = await this.apiRequest('conversation/info', { user_id: String(creatorUserId) });
      const conversationId = infoRes.conversation && infoRes.conversation.conversation_id;

      if (!conversationId) {
        throw new Error(`Não foi possível obter conversa com o ID ${creatorUserId}: ${JSON.stringify(infoRes)}`);
      }

      // 2. Monta o template personalizado
      let messageText = this.config.dmTemplate || DEFAULT_CONFIG.dmTemplate;
      messageText = messageText
        .replace(/\{viewers\}/gi, String(viewers))
        .replace(/\{espectadores\}/gi, String(viewers))
        .replace(/\{diamonds\}/gi, String(diamonds))
        .replace(/\{diamantes\}/gi, String(diamonds))
        .replace(/\{followers\}/gi, String(followers))
        .replace(/\{seguidores\}/gi, String(followers))
        .replace(/\{duration\}/gi, String(duration))
        .replace(/\{duracao\}/gi, String(duration))
        .replace(/\{creator\}/gi, String(creatorName));

      // 3. Envia a mensagem privada
      const sendPayload = {
        conversation_id: String(conversationId),
        text: messageText,
        dev_payload: crypto.randomUUID(),
        should_translate: false,
        initial_coins: 0
      };

      const sendRes = await this.apiRequest('conversation/send_text_message', sendPayload);
      if (sendRes.error) {
        throw new Error(sendRes.error.message || JSON.stringify(sendRes.error));
      }

      this.stats.dmsSent++;
      this.logAction('DM', `DM de resumo pós-live enviada com sucesso para ${creatorName} (ID: ${creatorUserId})!`, '', 'SUCESSO', {
        message: messageText,
        conversation_id: conversationId
      });
      console.log(`[BOT DM] Mensagem enviada com sucesso para ${creatorName}!`);
      return { success: true, text: messageText };
    } catch (e) {
      console.error('[BOT DM ERROR]:', e.message);
      this.logAction('DM', `Falha ao enviar DM para ${creatorName}: ${e.message}`, '', 'ERRO');
      return { error: e.message };
    }
  }

  // --- Auditoria / Log de Ações de Moderação ---
  logAction(type, description, triggerWord = '', status = 'OK', details = null) {
    const entry = {
      id: `log-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      timestamp: new Date().toLocaleTimeString('pt-BR'),
      fullDate: new Date().toISOString(),
      type: type, // 'MUTE', 'BAN', 'ANNOUNCEMENT', 'DM', 'SYSTEM'
      description: description,
      triggerWord: triggerWord,
      status: status,
      details: details
    };
    db.addAuditLog(entry);
    this.moderationLogs = db.getAuditLogs(100);
  }

  // --- Logger Central de Diagnóstico e Erros do Sistema ---
  logSystem(category, level, message, details = null) {
    const entry = {
      id: `sys-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      timestamp: new Date().toLocaleTimeString('pt-BR'),
      isoTime: new Date().toISOString(),
      category: category.toUpperCase(), // 'WS', 'API', 'MOD', 'QUEUE', 'SYSTEM', 'WATCHDOG'
      level: level.toUpperCase(),       // 'INFO', 'SUCCESS', 'WARN', 'ERROR'
      message: String(message),
      details: details ? (typeof details === 'object' ? JSON.stringify(details) : String(details)) : null
    };

    db.addSystemLog(entry);
    this.systemLogs = db.getSystemLogs(200);

    // Log no terminal do Node com formatação
    const prefix = `[${entry.category}][${entry.level}]`;
    if (entry.level === 'ERROR') {
      console.error(`${prefix} ${entry.message}`, details || '');
    } else if (entry.level === 'WARN') {
      console.warn(`${prefix} ${entry.message}`);
    } else {
      console.log(`${prefix} ${entry.message}`);
    }

    return entry;
  }

  getSystemLogs() {
    return db.getSystemLogs(200);
  }

  clearSystemLogs() {
    db.clearSystemLogs();
    this.systemLogs = db.getSystemLogs(200);
    return true;
  }

  // --- Estado Completo do Robô para o Portal ---
  getStatus() {
    return {
      isMonitoring: this.isMonitoring,
      wsConnected: this.wsConnected,
      authFailed: !!this.authFailed,
      activeLive: this.activeLive,
      activeCreator: db.getActiveCreator(),
      config: db.getConfig(),
      recurringMessages: db.getRecurringMessages(),
      moderationRules: db.getModerationRules(),
      liveSessions: db.getLiveSessions(),
      stats: this.stats,
      countdownSeconds: this.countdownSeconds,
      chatFeed: this.chatFeed.slice(0, 50),
      recentLogs: db.getAuditLogs(50),
      systemLogs: db.getSystemLogs(100),
      errorCount: this.systemLogs.filter(l => l.level === 'ERROR').length
    };
  }
}

module.exports = new BotEngine();
