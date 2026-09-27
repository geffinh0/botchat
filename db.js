/**
 * SUPER CLIENT — Mini Banco de Dados Persistente JSON
 * Gerencia o armazenamento persistente de:
 * - Configurações gerais do Robô e da Transmissão
 * - Perfil completo da Criadora detectada (avatar, shared_id, user_id, diamantes)
 * - Fila de Mensagens Recorrentes (não reseta ao reiniciar ou recarregar)
 * - Regras de Moderação (palavras de Mute e Ban com contadores de acionamento)
 * - Histórico permanente de Auditoria (mutes, bans, avisos, DMs)
 * - Histórico de Diagnóstico do Sistema e Sessões de Live
 *
 * Utiliza escrita atômica (.tmp -> rename) para garantir integridade total dos dados.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'database.json');
const LEGACY_CONFIG_FILE = path.join(__dirname, 'bot_config.json');

const DEFAULT_DB = {
  version: '2.0.0',
  last_updated: new Date().toISOString(),
  config: {
    creatorUserId: '',
    livestreamId: '',
    autoDetectLive: true,
    moderationEnabled: true,
    caseSensitive: false,
    exactMatch: false,
    recurringEnabled: true,
    recurringIntervalSeconds: 120,
    recurringCurrentIndex: 0,
    dmEnabled: true,
    dmTemplate: 'Live finalizada! Hoje você alcançou {viewers} espectadores e gerou {diamonds} diamantes na transmissão. Parabéns pelo show! ❤️',
    botToken: process.env.SUPERLIVE_BOT_TOKEN || '',
    botUserId: '32037361',
    botName: '𝑨́𝒕𝒊𝒍𝒂',
    deviceId: process.env.SUPERLIVE_DEVICE_ID || ''
  },
  active_creator: null,
  recurring_messages: [
    {
      id: 'msg-rec-1',
      text: '✨ Bem-vindos à live! Siga o perfil da criadora para não perder transmissões exclusivas!',
      active: true,
      sendCount: 0,
      createdAt: new Date().toISOString()
    },
    {
      id: 'msg-rec-2',
      text: '🎁 Envie presentes para apoiarmos a transmissão e batermos a meta de hoje!',
      active: true,
      sendCount: 0,
      createdAt: new Date().toISOString()
    },
    {
      id: 'msg-rec-3',
      text: '📸 Acompanhe as novidades e bastidores também no Instagram! Compartilhe a live com os amigos!',
      active: true,
      sendCount: 0,
      createdAt: new Date().toISOString()
    }
  ],
  moderation_rules: {
    muteWords: ['palavrao', 'xingamento', 'ofensa', 'lixo', 'trouxa', 'golpe', 'fake'],
    banWords: ['pedofilia', 'menor', 'crime', 'droga', 'estelionato', 'pix falso'],
    caseSensitive: false,
    exactMatch: false
  },
  creators: {},
  audit_logs: [],
  system_logs: [],
  live_sessions: []
};

class MiniDatabase {
  constructor() {
    this.memoryData = null;
    this.ensureDataDir();
    this.loadDatabase();
  }

  ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      } catch (e) {
        console.error('[DB] Falha ao criar diretório data:', e.message);
      }
    }
  }

  loadDatabase() {
    try {
      if (fs.existsSync(DB_FILE)) {
        const raw = fs.readFileSync(DB_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        this.memoryData = {
          ...DEFAULT_DB,
          ...parsed,
          config: { ...DEFAULT_DB.config, ...(parsed.config || {}) },
          moderation_rules: { ...DEFAULT_DB.moderation_rules, ...(parsed.moderation_rules || {}) },
          active_creator: parsed.active_creator !== undefined ? parsed.active_creator : DEFAULT_DB.active_creator,
          creators: { ...(DEFAULT_DB.creators || {}), ...(parsed.creators || {}) }
        };
        // Garante que criadora ativa esteja salva na lista de criadoras conhecidas
        if (this.memoryData.active_creator && (this.memoryData.active_creator.userId || this.memoryData.active_creator.sharedId)) {
          const uid = String(this.memoryData.active_creator.sharedId || this.memoryData.active_creator.userId);
          this.memoryData.creators[uid] = {
            ...this.memoryData.active_creator,
            ...(this.memoryData.creators[uid] || {})
          };
        }
        console.log('[DB] Mini Banco de Dados carregado com sucesso de data/database.json');
        return;
      }
    } catch (e) {
      console.warn('[DB] Erro ao carregar database.json, iniciando processo de migração:', e.message);
    }

    // Inicialização / Migração a partir do bot_config.json legada se existir
    this.memoryData = JSON.parse(JSON.stringify(DEFAULT_DB));

    if (fs.existsSync(LEGACY_CONFIG_FILE)) {
      try {
        const legacyRaw = fs.readFileSync(LEGACY_CONFIG_FILE, 'utf-8');
        const legacy = JSON.parse(legacyRaw);

        this.memoryData.config = { ...this.memoryData.config, ...legacy };

        if (legacy.muteWords && Array.isArray(legacy.muteWords)) {
          this.memoryData.moderation_rules.muteWords = [...legacy.muteWords];
        }
        if (legacy.banWords && Array.isArray(legacy.banWords)) {
          this.memoryData.moderation_rules.banWords = [...legacy.banWords];
        }
        if (legacy.recurringMessages && Array.isArray(legacy.recurringMessages) && legacy.recurringMessages.length > 0) {
          this.memoryData.recurring_messages = legacy.recurringMessages.map((text, idx) => ({
            id: `msg-rec-${idx + 1}`,
            text: String(text),
            active: true,
            sendCount: 0,
            createdAt: new Date().toISOString()
          }));
        }

        console.log('[DB] Dados migrados do legado bot_config.json para a nova base de dados persistente.');
      } catch (e) {
        console.error('[DB] Falha ao ler bot_config legado:', e.message);
      }
    }

    this.persistSync();
  }

  /**
   * Gravação atômica segura para evitar perda ou corrupção de dados
   */
  persistSync() {
    if (!this.memoryData) return;
    this.memoryData.last_updated = new Date().toISOString();

    const tmpFile = `${DB_FILE}.tmp`;
    try {
      const serialized = JSON.stringify(this.memoryData, null, 2);
      fs.writeFileSync(tmpFile, serialized, 'utf-8');
      fs.renameSync(tmpFile, DB_FILE);

      // Mantém bot_config.json sincronizado para retrocompatibilidade
      this.syncLegacyConfigFile();
    } catch (e) {
      console.error('[DB CRITICAL] Falha ao persistir banco de dados:', e.message);
    }
  }

  syncLegacyConfigFile() {
    try {
      const cfg = {
        ...this.memoryData.config,
        muteWords: this.memoryData.moderation_rules.muteWords || [],
        banWords: this.memoryData.moderation_rules.banWords || [],
        recurringMessages: (this.memoryData.recurring_messages || []).map(m => typeof m === 'string' ? m : m.text),
        caseSensitive: this.memoryData.moderation_rules.caseSensitive,
        exactMatch: this.memoryData.moderation_rules.exactMatch
      };
      fs.writeFileSync(LEGACY_CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
    } catch (e) {
      // ignore
    }
  }

  // --- CONFIGURAÇÃO ---
  getConfig() {
    return {
      ...this.memoryData.config,
      muteWords: this.memoryData.moderation_rules.muteWords,
      banWords: this.memoryData.moderation_rules.banWords,
      recurringMessages: (this.memoryData.recurring_messages || []).map(m => typeof m === 'string' ? m : m.text),
      activeCreator: this.memoryData.active_creator
    };
  }

  saveConfig(partialConfig) {
    if (!partialConfig || typeof partialConfig !== 'object') return this.getConfig();

    // Se vierem palavras de moderação no update
    if (partialConfig.muteWords && Array.isArray(partialConfig.muteWords)) {
      this.memoryData.moderation_rules.muteWords = [...new Set(partialConfig.muteWords.filter(Boolean))];
      delete partialConfig.muteWords;
    }
    if (partialConfig.banWords && Array.isArray(partialConfig.banWords)) {
      this.memoryData.moderation_rules.banWords = [...new Set(partialConfig.banWords.filter(Boolean))];
      delete partialConfig.banWords;
    }
    if (partialConfig.caseSensitive !== undefined) {
      this.memoryData.moderation_rules.caseSensitive = !!partialConfig.caseSensitive;
    }
    if (partialConfig.exactMatch !== undefined) {
      this.memoryData.moderation_rules.exactMatch = !!partialConfig.exactMatch;
    }

    // Se vierem mensagens recorrentes como array de strings
    if (partialConfig.recurringMessages && Array.isArray(partialConfig.recurringMessages)) {
      this.setRecurringMessagesFromStrings(partialConfig.recurringMessages);
      delete partialConfig.recurringMessages;
    }

    // Atualiza demais configurações escalares
    this.memoryData.config = {
      ...this.memoryData.config,
      ...partialConfig
    };

    this.persistSync();
    return this.getConfig();
  }

  // --- CRIADORA ATIVA & CACHE DE PERFIS ---
  getActiveCreator() {
    return this.memoryData.active_creator || null;
  }

  getCreatorsList() {
    if (!this.memoryData.creators) this.memoryData.creators = {};
    const seen = new Set();
    const list = [];
    for (const c of Object.values(this.memoryData.creators)) {
      const key = String(c.sharedId || c.userId || '');
      if (key && !seen.has(key)) {
        seen.add(key);
        list.push(c);
      }
    }
    return list;
  }

  saveCreator(creatorData) {
    if (!creatorData || typeof creatorData !== 'object') return null;
    const uid = String(creatorData.sharedId || creatorData.userId || '').trim();
    if (!uid) return null;
    if (!this.memoryData.creators) this.memoryData.creators = {};

    const existing = this.memoryData.creators[uid] || {};
    const item = {
      userId: String(creatorData.userId || existing.userId || ''),
      sharedId: String(creatorData.sharedId || existing.sharedId || uid),
      name: creatorData.name || existing.name || 'Criadora',
      username: creatorData.username || existing.username || '',
      avatar: creatorData.avatar !== undefined ? creatorData.avatar : (existing.avatar || ''),
      diamonds: creatorData.diamonds !== undefined ? creatorData.diamonds : (existing.diamonds || 0),
      followers: creatorData.followers !== undefined ? creatorData.followers : (existing.followers || 0),
      isLive: !!creatorData.isLive,
      livestreamId: creatorData.livestreamId || null,
      lastSeen: new Date().toISOString()
    };
    this.memoryData.creators[uid] = item;
    this.persistSync();
    return item;
  }

  deleteCreator(identifier) {
    if (!identifier) return false;
    const str = String(identifier).trim();
    if (!this.memoryData.creators) return false;

    let foundKey = null;
    if (this.memoryData.creators[str]) {
      foundKey = str;
    } else {
      for (const k in this.memoryData.creators) {
        const c = this.memoryData.creators[k];
        if (String(c.sharedId) === str || String(c.userId) === str) {
          foundKey = k;
          break;
        }
      }
    }

    if (foundKey) {
      delete this.memoryData.creators[foundKey];
      // Se era a criadora ativa, desativa ou seleciona outra
      if (this.memoryData.active_creator && (String(this.memoryData.active_creator.sharedId) === foundKey || String(this.memoryData.active_creator.userId) === foundKey)) {
        const remaining = Object.values(this.memoryData.creators);
        if (remaining.length > 0) {
          this.setActiveCreator(remaining[0]);
        } else {
          this.memoryData.active_creator = null;
          this.memoryData.config.creatorUserId = '';
        }
      }
      this.persistSync();
      return true;
    }
    return false;
  }

  setActiveCreator(creatorData) {
    if (!creatorData || typeof creatorData !== 'object') return null;

    this.memoryData.active_creator = {
      ...(this.memoryData.active_creator || {}),
      ...creatorData,
      lastSeen: new Date().toISOString()
    };

    // Salva também no histórico de criadoras
    const uid = String(creatorData.sharedId || creatorData.userId || '').trim();
    if (uid) {
      if (!this.memoryData.creators) this.memoryData.creators = {};
      this.memoryData.creators[uid] = {
        ...this.memoryData.creators[uid],
        ...this.memoryData.active_creator
      };
    }

    // Sincroniza creatorUserId na config
    if (creatorData.sharedId || creatorData.userId) {
      this.memoryData.config.creatorUserId = String(creatorData.sharedId || creatorData.userId);
    }

    this.persistSync();
    return this.memoryData.active_creator;
  }

  switchActiveCreator(identifier) {
    const creator = this.getCreator(identifier);
    if (creator) {
      return this.setActiveCreator(creator);
    }
    return null;
  }

  getCreator(identifier) {
    if (!identifier) return null;
    const str = String(identifier).trim();
    if (!this.memoryData.creators) return null;
    if (this.memoryData.creators[str]) return this.memoryData.creators[str];
    for (const id in this.memoryData.creators) {
      const c = this.memoryData.creators[id];
      if (String(c.sharedId) === str || String(c.userId) === str || (c.username && c.username.toLowerCase() === str.toLowerCase())) {
        return c;
      }
    }
    return null;
  }

  // --- MENSAGENS RECORRENTES ---
  getRecurringMessages() {
    return this.memoryData.recurring_messages || [];
  }

  getRecurringStrings() {
    return (this.memoryData.recurring_messages || [])
      .filter(m => m.active !== false)
      .map(m => typeof m === 'string' ? m : m.text);
  }

  setRecurringMessagesFromStrings(strings) {
    if (!Array.isArray(strings)) return;
    this.memoryData.recurring_messages = strings
      .map(s => String(s).trim())
      .filter(Boolean)
      .map((text, idx) => ({
        id: `msg-rec-${idx + 1}-${Date.now().toString(36)}`,
        text: text,
        active: true,
        sendCount: 0,
        createdAt: new Date().toISOString()
      }));
    this.persistSync();
    return this.memoryData.recurring_messages;
  }

  addRecurringMessage(text) {
    const clean = String(text || '').trim();
    if (!clean) return null;
    const newMsg = {
      id: `msg-rec-${Date.now().toString(36)}`,
      text: clean,
      active: true,
      sendCount: 0,
      createdAt: new Date().toISOString()
    };
    this.memoryData.recurring_messages.push(newMsg);
    this.persistSync();
    return newMsg;
  }

  removeRecurringMessage(index) {
    if (index >= 0 && index < this.memoryData.recurring_messages.length) {
      const removed = this.memoryData.recurring_messages.splice(index, 1);
      this.persistSync();
      return removed[0];
    }
    return null;
  }

  incrementRecurringSendCount(index) {
    if (index >= 0 && index < this.memoryData.recurring_messages.length) {
      const m = this.memoryData.recurring_messages[index];
      if (m && typeof m === 'object') {
        m.sendCount = (m.sendCount || 0) + 1;
        m.lastSent = new Date().toISOString();
        this.persistSync();
      }
    }
  }

  // --- REGRAS DE MODERAÇÃO ---
  getModerationRules() {
    return this.memoryData.moderation_rules;
  }

  addMuteWord(word) {
    const clean = String(word || '').trim();
    if (!clean) return;
    if (!this.memoryData.moderation_rules.muteWords.includes(clean)) {
      this.memoryData.moderation_rules.muteWords.push(clean);
      this.persistSync();
    }
    return this.memoryData.moderation_rules.muteWords;
  }

  removeMuteWord(wordOrIdx) {
    const list = this.memoryData.moderation_rules.muteWords;
    if (typeof wordOrIdx === 'number') {
      list.splice(wordOrIdx, 1);
    } else {
      const idx = list.indexOf(String(wordOrIdx));
      if (idx !== -1) list.splice(idx, 1);
    }
    this.persistSync();
    return list;
  }

  addBanWord(word) {
    const clean = String(word || '').trim();
    if (!clean) return;
    if (!this.memoryData.moderation_rules.banWords.includes(clean)) {
      this.memoryData.moderation_rules.banWords.push(clean);
      this.persistSync();
    }
    return this.memoryData.moderation_rules.banWords;
  }

  removeBanWord(wordOrIdx) {
    const list = this.memoryData.moderation_rules.banWords;
    if (typeof wordOrIdx === 'number') {
      list.splice(wordOrIdx, 1);
    } else {
      const idx = list.indexOf(String(wordOrIdx));
      if (idx !== -1) list.splice(idx, 1);
    }
    this.persistSync();
    return list;
  }

  // --- HISTÓRICO DE AUDITORIA & MODERAÇÃO ---
  addAuditLog(entry) {
    if (!entry) return;
    const logItem = {
      id: entry.id || `log-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      timestamp: entry.timestamp || new Date().toLocaleTimeString('pt-BR'),
      fullDate: entry.fullDate || new Date().toISOString(),
      type: entry.type || 'SYSTEM',
      description: entry.description || '',
      triggerWord: entry.triggerWord || '',
      status: entry.status || 'OK',
      details: entry.details || null
    };

    this.memoryData.audit_logs.unshift(logItem);
    if (this.memoryData.audit_logs.length > 500) {
      this.memoryData.audit_logs = this.memoryData.audit_logs.slice(0, 500);
    }
    this.persistSync();
    return logItem;
  }

  getAuditLogs(limit = 100) {
    return (this.memoryData.audit_logs || []).slice(0, limit);
  }

  clearAuditLogs() {
    this.memoryData.audit_logs = [];
    this.persistSync();
    return true;
  }

  // --- HISTÓRICO DE LOGS DE DIAGNÓSTICO DO SISTEMA ---
  addSystemLog(entry) {
    if (!entry) return;
    const item = {
      id: entry.id || `sys-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      timestamp: entry.timestamp || new Date().toLocaleTimeString('pt-BR'),
      isoTime: entry.isoTime || new Date().toISOString(),
      category: (entry.category || 'SYSTEM').toUpperCase(),
      level: (entry.level || 'INFO').toUpperCase(),
      message: String(entry.message || ''),
      details: entry.details || null
    };

    this.memoryData.system_logs.unshift(item);
    if (this.memoryData.system_logs.length > 500) {
      this.memoryData.system_logs = this.memoryData.system_logs.slice(0, 500);
    }
    this.persistSync();
    return item;
  }

  getSystemLogs(limit = 200) {
    return (this.memoryData.system_logs || []).slice(0, limit);
  }

  clearSystemLogs() {
    this.memoryData.system_logs = [];
    this.addSystemLog({
      category: 'SYSTEM',
      level: 'INFO',
      message: 'Console de logs limpo pelo operador.'
    });
    this.persistSync();
    return true;
  }

  // --- SESSÕES DE LIVE ---
  recordLiveSession(sessionData) {
    if (!sessionData) return;
    const session = {
      id: sessionData.livestream_id || `session-${Date.now()}`,
      creator_name: sessionData.creator_name || 'Criadora',
      creator_user_id: sessionData.creator_user_id || '',
      headline: sessionData.headline || '',
      peak_viewers: sessionData.peak_viewers || 0,
      total_diamonds: sessionData.total_diamonds || 0,
      started_at: sessionData.started_at,
      ended_at: new Date().toISOString(),
      duration: sessionData.duration || 'N/A'
    };
    this.memoryData.live_sessions.unshift(session);
    if (this.memoryData.live_sessions.length > 50) {
      this.memoryData.live_sessions.pop();
    }
    this.persistSync();
    return session;
  }

  getLiveSessions() {
    return this.memoryData.live_sessions || [];
  }
}

module.exports = new MiniDatabase();
