/**
 * SUPER CLIENT — Main Web Application Controller
 * High-fidelity client communicating with the official SuperLive API (api.sprlv-api.com)
 * Handles Real Authentication, Live Billing, Real Rankings, Account Operations & Cash-Out.
 */

// Clean up any outdated or non-proxied direct api host from localStorage
try {
  const savedHost = localStorage.getItem('sc_api_host');
  if (savedHost && !savedHost.includes('3000') && !savedHost.includes('localhost')) {
    localStorage.removeItem('sc_api_host');
  }
} catch (e) {}

function getApiBaseUrl() {
  const origin = window.location.origin || '';
  if (origin && !origin.startsWith('file:') && !origin.includes('null')) {
    return `${origin}/api/v1/`;
  }
  return 'http://localhost:3000/api/v1/';
}

// --- 1. Estado da Aplicação e Configurações ---
const AppState = {
  activeTab: 'bot',
  isLoggedIn: false,
  botConnected: false,
  botUser: null,
  apiHost: getApiBaseUrl(),
  // O token do robô fica exclusivamente no servidor.
  authToken: '',
  deviceId: localStorage.getItem('sc_device_id') || '',
  exchangeRate: 150, // Taxa real oficial da conta (150 diamantes = $1.00 USD)
  diamondsBalance: 0,
  monthlyDiamonds: 0,
  coinsBalance: 0,
  payoutTiers: [3750, 5250, 7500, 11250, 15000, 22500, 37500, 56250, 112500, 225000, 450000, 1500000],
  selectedTimeframe: 0, // 0: DAY, 1: WEEK, 2: MONTH
  rankingCategory: 'streamers',
  rankingTimeframe: 1, // 1: DAILY, 2: WEEKLY, 0: ALL_TIME
  selectedCountry: '',
  userProfile: null,
  ownUserRank: null,
  cashOutUrl: 'https://liveapp-prod.web.app/#/cash_out',
  earningsBreakdown: {
    publicStream: 0,
    privateStream: 0,
    privateCall: 0,
    conversation: 0,
    total: 0
  },
  purchaseHistory: [],
  leaderboardData: [],
  httpLogs: []
};

// --- 2. Inicialização do App ---
document.addEventListener('DOMContentLoaded', async () => {
  clearStaleServiceWorkerAndCaches();
  initNavigation();
  initToasts();
  initLoginModal();
  initCopyUserId();
  initBotModeratorModule();
  initCornerLiveWidget();
  initSystemLogsModule();

  // O painel atual é focado no Robô Moderador. Os antigos módulos
  // financeiros/configuração foram removidos do HTML e não devem ser
  // inicializados aqui, pois dependem de elementos que não existem mais.

  // Check server proxy status
  checkServerProxyStatus();

  // Restaura a sessão do robô após um reload. Antes o token ficava salvo,
  // mas nenhuma rotina era chamada para reidratar a UI.
  setTimeout(async () => {
    try {
      const statusRes = await fetch('/api/bot/status', { cache: 'no-store' });
      if (statusRes.ok) {
        const status = await statusRes.json();
        if (status.isLoggedIn && status.config) {
          AppState.botConnected = true;
          AppState.botUser = {
            id: status.config.botUserId,
            name: status.config.botName
          };
        }
      }
      if (AppState.botConnected) {
        await validateAndLoadAccount({ silent: true });
      }
      if (window.triggerBotStatusRefresh) await window.triggerBotStatusRefresh();
    } catch (e) {
      console.warn('[BOOT UI] Falha ao restaurar sessão:', e.message);
    }
  }, 0);
});

function clearStaleServiceWorkerAndCaches() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      for (const registration of registrations) {
        registration.unregister().then(() => {
          console.log('[SW] Service Worker antigo desregistrado.');
        });
      }
    }).catch(() => {});
  }
  if ('caches' in window) {
    caches.keys().then((keys) => {
      for (const key of keys) {
        caches.delete(key).then(() => {
          console.log(`[CACHE] Cache antigo '${key}' removido.`);
        });
      }
    }).catch(() => {});
  }
}

// --- 2.5 Função Auxiliar Global de Sanitização HTML ---
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// --- 3. Sistema de Notificações Toast ---
function initToasts() {
  window.showToast = function(message, type = 'info', duration = 3800) {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️';
    toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
    container.appendChild(toast);

    requestAnimationFrame(() => {
      toast.classList.add('show');
    });

    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 350);
    }, duration);
  };
}

// --- 4. Camada de Comunicação com a API (HTTP Client) ---
async function apiCall(endpoint, method = 'POST', bodyData = {}) {
  const cleanEndpoint = endpoint.replace(/^\/+/, '');
  const url = `${AppState.apiHost}${cleanEndpoint}`;
  const startTime = performance.now();

  const headers = {
    'Content-Type': 'application/json; charset=UTF-8',
    'Accept': 'application/json',
    'User-Agent': 'SuperLive/2.31.0 (samsung SM-G998B; Android 13; Scale/3.0)',
    'Device-ID': AppState.deviceId
  };


  const reqOptions = {
    method,
    headers
  };

  if (method === 'POST' || method === 'PUT') {
    reqOptions.body = JSON.stringify(bodyData);
  }

  try {
    const response = await fetch(url, reqOptions);
    const duration = Math.round(performance.now() - startTime);

    let data = null;
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      data = await response.json();
    } else {
      const text = await response.text();
      try {
        data = JSON.parse(text);
      } catch (e) {
        data = { raw: text };
      }
    }

    // Append to live HTTP logger
    logHttpCall(method, cleanEndpoint, response.status, duration, data);

    return {
      ok: response.ok,
      status: response.status,
      data
    };
  } catch (err) {
    const duration = Math.round(performance.now() - startTime);
    logHttpCall(method, cleanEndpoint, 'ERR', duration, { error: err.message });
    console.error(`Erro na chamada API ${endpoint}:`, err);
    return {
      ok: false,
      status: 0,
      data: { error: { message: err.message } }
    };
  }
}

function logHttpCall(method, endpoint, status, duration, responseData) {
  const container = document.getElementById('connectionStatusLog');
  if (!container) return;

  const item = document.createElement('div');
  item.className = 'log-item';

  let statusClass = 's200';
  if (status >= 400 && status < 500) statusClass = status === 401 ? 's401' : 's400';
  if (status >= 500 || status === 'ERR') statusClass = 's500';

  const timeStr = new Date().toLocaleTimeString('pt-BR');
  const preview = responseData ? JSON.stringify(responseData).slice(0, 100) : '';

  item.innerHTML = `
    <div class="log-item-header">
      <span><strong>[${timeStr}]</strong> ${method} /${endpoint}</span>
      <span class="status-badge-http ${statusClass}">${status} (${duration}ms)</span>
    </div>
    <div style="color:var(--text-muted); font-size:10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
      ${preview}...
    </div>
  `;

  container.insertBefore(item, container.firstChild);
}

// --- 5. Gerenciamento de Sessão & Autenticação ---
async function validateAndLoadAccount(options = {}) {
  const silent = !!options.silent;
  if (!AppState.userProfile && !AppState.botConnected) updateAuthUI(true, 'Conectando...');

  try {
    const res = await apiCall('users/own_profile', 'POST', {});

    if (res.ok && res.data) {
      AppState.isLoggedIn = true;
      const profile = res.data.user || res.data;
      AppState.userProfile = profile;
      AppState.botUser = profile;
      AppState.diamondsBalance = profile.diamonds || 0;
      AppState.coinsBalance = profile.coins || 0;

      updateAuthUI(true, profile.name || 'Átila');
      if (!silent) {
        showToast(`Bem-vindo, ${profile.name || 'Átila'}! Conta conectada com sucesso.`, 'success');
      }
    } else {
      const msg = res.data?.error?.message || 'Não foi possível carregar o perfil da conta agora.';
      if (!AppState.botConnected) {
        AppState.isLoggedIn = false;
        AppState.userProfile = null;
        updateAuthUI(false);
      } else if (!silent) {
        showToast(`Conta conectada, mas o perfil não pôde ser carregado agora: ${msg}`, 'warning');
      }
    }
  } catch (err) {
    if (!silent) {
      console.warn('[AUTH] Falha ao carregar perfil:', err.message);
    }
  }
}

async function handleEmailLogin(email, password) {
  const alertBox = document.getElementById('loginAlertBox');
  const btn = document.getElementById('btnSubmitEmailLogin');
  const btnText = document.getElementById('loginSubmitText');

  if (alertBox) alertBox.style.display = 'none';
  if (btn) btn.disabled = true;
  if (btnText) btnText.innerHTML = '<span class="spinning">🔄</span> Autenticando com SuperLive...';

  try {
    const res = await fetch('/api/bot/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'email', email: email.trim(), password: password })
    });
    const data = await res.json();

    if (btn) btn.disabled = false;
    if (btnText) btnText.textContent = '⚡ Entrar na Conta do Robô';

    if (data && data.success && data.token) {
      AppState.authToken = data.token;
      AppState.isLoggedIn = true;
      AppState.botConnected = true;
      AppState.botUser = data.user || null;
      AppState.userProfile = data.user || null;
      updateAuthUI(true, data.user?.name || 'Robô');

      const name = data.user?.name || 'Robô';
      closeLoginModal();
      showToast(`Conta do Robô conectada: "${name}"!`, 'success');

      if (window.triggerBotStatusRefresh) {
        window.triggerBotStatusRefresh();
      }
      validateAndLoadAccount({ silent: true }).catch(() => {});
    } else {
      const errMsg = data?.error || 'Email ou senha incorretos no SuperLive.';
      if (alertBox) {
        alertBox.style.display = 'block';
        alertBox.style.background = 'rgba(239, 68, 68, 0.15)';
        alertBox.style.border = '1px solid rgba(239, 68, 68, 0.4)';
        alertBox.style.color = '#fca5a5';
        alertBox.textContent = errMsg;
      }
    }
  } catch (err) {
    if (btn) btn.disabled = false;
    if (btnText) btnText.textContent = '⚡ Entrar na Conta do Robô';
    if (alertBox) {
      alertBox.style.display = 'block';
      alertBox.style.background = 'rgba(239, 68, 68, 0.15)';
      alertBox.style.border = '1px solid rgba(239, 68, 68, 0.4)';
      alertBox.style.color = '#fca5a5';
      alertBox.textContent = 'Erro ao comunicar com o servidor: ' + err.message;
    }
  }
}

async function handleTokenLogin(token, deviceId) {
  const alertBox = document.getElementById('tokenAlertBox');
  const btn = document.getElementById('btnSubmitTokenLogin');

  if (alertBox) alertBox.style.display = 'none';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinning">🔄</span> Validando Token...';
  }

  try {
    const res = await fetch('/api/bot/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'token', token: token.trim(), deviceId: deviceId ? deviceId.trim() : null })
    });
    const data = await res.json();

    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span>⚡ Conectar com Este Token</span>';
    }

    if (data && data.success && data.token) {
      AppState.authToken = data.token;
      AppState.isLoggedIn = true;
      AppState.botConnected = true;
      AppState.botUser = data.user || null;
      AppState.userProfile = data.user || null;
      updateAuthUI(true, data.user?.name || 'Robô');

      const name = data.user?.name || 'Robô';
      closeLoginModal();
      showToast(`Conta do Robô conectada via Token: "${name}"!`, 'success');

      if (window.triggerBotStatusRefresh) {
        window.triggerBotStatusRefresh();
      }
      validateAndLoadAccount({ silent: true }).catch(() => {});
    } else {
      const errMsg = data?.error || 'Token rejeitado pelo SuperLive. Verifique o valor e o Device-ID.';
      if (alertBox) {
        alertBox.style.display = 'block';
        alertBox.style.background = 'rgba(239, 68, 68, 0.15)';
        alertBox.style.border = '1px solid rgba(239, 68, 68, 0.4)';
        alertBox.style.color = '#fca5a5';
        alertBox.textContent = errMsg;
      }
    }
  } catch (err) {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span>⚡ Conectar com Este Token</span>';
    }
    if (alertBox) {
      alertBox.style.display = 'block';
      alertBox.style.background = 'rgba(239, 68, 68, 0.15)';
      alertBox.style.border = '1px solid rgba(239, 68, 68, 0.4)';
      alertBox.style.color = '#fca5a5';
      alertBox.textContent = 'Erro ao validar token: ' + err.message;
    }
  }
}

async function handleBotLogout() {
  try {
    await fetch('/api/bot/logout', { method: 'POST' });
    AppState.authToken = '';
    AppState.isLoggedIn = false;
    AppState.botConnected = false;
    AppState.botUser = null;
    AppState.userProfile = null;

    updateAuthUI(false);
    closeLoginModal();
    showToast('Conta do robô desconectada com sucesso.', 'info');

    if (window.triggerBotStatusRefresh) {
      window.triggerBotStatusRefresh();
    }
  } catch (e) {
    showToast('Erro ao desconectar conta: ' + e.message, 'error');
  }
}

// --- Variáveis de Sessão para Login por Telefone ---
let currentPhoneVerificationId = '';
let currentPhoneNumber = '';
let phoneResendCountdown = null;
let phoneCountdownSeconds = 0;

async function handleSendPhoneCode(isRetry = false) {
  const countryCode = document.getElementById('loginPhoneCountryCode')?.value || '+55';
  const rawNumber = document.getElementById('loginPhoneNumber')?.value.trim() || '';
  const alertBox = document.getElementById('phoneAlertBox');
  const btn = document.getElementById('btnSendPhoneCode');
  const btnText = document.getElementById('btnSendPhoneCodeText');

  if (alertBox) alertBox.style.display = 'none';

  const cleanDigits = rawNumber.replace(/\D/g, '');
  if (!cleanDigits || cleanDigits.length < 8) {
    if (alertBox) {
      alertBox.style.display = 'block';
      alertBox.style.background = 'rgba(239, 68, 68, 0.15)';
      alertBox.style.border = '1px solid rgba(239, 68, 68, 0.4)';
      alertBox.style.color = '#fca5a5';
      alertBox.textContent = 'Por favor, informe um número de telefone celular válido com DDD.';
    }
    return;
  }

  const fullPhoneNumber = `${countryCode}${cleanDigits}`;
  currentPhoneNumber = fullPhoneNumber;

  if (btn) btn.disabled = true;
  if (btnText) btnText.innerHTML = '<span class="spinning">🔄</span> Solicitando SMS ao SuperLive...';

  try {
    const res = await fetch('/api/bot/send-phone-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone_number: fullPhoneNumber, is_retry: isRetry })
    });
    const data = await res.json();

    if (btn) btn.disabled = false;
    if (btnText) btnText.textContent = '📲 Enviar Código por SMS';

    if (data && data.success && data.phone_verification_id) {
      currentPhoneVerificationId = data.phone_verification_id;

      const p1 = document.getElementById('phoneStep1');
      const p2 = document.getElementById('phoneStep2');
      if (p1) p1.style.display = 'none';
      if (p2) p2.style.display = 'flex';

      const displayEl = document.getElementById('phoneTargetDisplay');
      if (displayEl) displayEl.textContent = formatPhoneDisplay(countryCode, cleanDigits);

      const codeInput = document.getElementById('loginSmsCode');
      if (codeInput) {
        codeInput.value = '';
        codeInput.focus();
      }
      const pvAlert = document.getElementById('phoneVerifyAlertBox');
      if (pvAlert) pvAlert.style.display = 'none';

      startPhoneResendTimer(data.retry_timeout_seconds || 60);
      showToast('Código SMS enviado com sucesso para o seu celular!', 'success');
    } else {
      if (alertBox) {
        alertBox.style.display = 'block';
        alertBox.style.background = 'rgba(239, 68, 68, 0.15)';
        alertBox.style.border = '1px solid rgba(239, 68, 68, 0.4)';
        alertBox.style.color = '#fca5a5';
        alertBox.textContent = data?.error || 'Falha ao solicitar SMS. Verifique o número e tente novamente.';
      }
    }
  } catch (err) {
    if (btn) btn.disabled = false;
    if (btnText) btnText.textContent = '📲 Enviar Código por SMS';
    if (alertBox) {
      alertBox.style.display = 'block';
      alertBox.style.background = 'rgba(239, 68, 68, 0.15)';
      alertBox.style.border = '1px solid rgba(239, 68, 68, 0.4)';
      alertBox.style.color = '#fca5a5';
      alertBox.textContent = 'Erro ao solicitar SMS: ' + err.message;
    }
  }
}

async function handleVerifyPhoneCode() {
  const codeInput = document.getElementById('loginSmsCode');
  const code = codeInput ? codeInput.value.replace(/\D/g, '').trim() : '';
  const alertBox = document.getElementById('phoneVerifyAlertBox');
  const btn = document.getElementById('btnSubmitPhoneCode');
  const btnText = document.getElementById('btnSubmitPhoneCodeText');

  if (alertBox) alertBox.style.display = 'none';

  if (!code || code.length < 4) {
    if (alertBox) {
      alertBox.style.display = 'block';
      alertBox.style.background = 'rgba(239, 68, 68, 0.15)';
      alertBox.style.border = '1px solid rgba(239, 68, 68, 0.4)';
      alertBox.style.color = '#fca5a5';
      alertBox.textContent = 'Por favor, digite o código de verificação recebido por SMS.';
    }
    return;
  }

  if (btn) btn.disabled = true;
  if (btnText) btnText.innerHTML = '<span class="spinning">🔄</span> Validando Código SMS...';

  try {
    const res = await fetch('/api/bot/verify-phone-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone_verification_id: currentPhoneVerificationId,
        phone_number: currentPhoneNumber,
        code: code
      })
    });
    const data = await res.json();

    if (btn) btn.disabled = false;
    if (btnText) btnText.textContent = '⚡ Confirmar Código e Conectar';

    if (data && data.success && data.token) {
      AppState.authToken = data.token;
      AppState.isLoggedIn = true;
      AppState.botConnected = true;
      AppState.botUser = data.user || null;
      AppState.userProfile = data.user || null;
      updateAuthUI(true, data.user?.name || 'Robô');

      if (phoneResendCountdown) clearInterval(phoneResendCountdown);

      const name = data.user?.name || 'Robô';
      closeLoginModal();
      showToast(`Login com celular realizado: "${name}"!`, 'success');

      if (window.triggerBotStatusRefresh) {
        window.triggerBotStatusRefresh();
      }
      validateAndLoadAccount({ silent: true }).catch(() => {});
    } else {
      if (alertBox) {
        alertBox.style.display = 'block';
        alertBox.style.background = 'rgba(239, 68, 68, 0.15)';
        alertBox.style.border = '1px solid rgba(239, 68, 68, 0.4)';
        alertBox.style.color = '#fca5a5';
        alertBox.textContent = data?.error || 'Código incorreto ou expirado. Tente novamente.';
      }
    }
  } catch (err) {
    if (btn) btn.disabled = false;
    if (btnText) btnText.textContent = '⚡ Confirmar Código e Conectar';
    if (alertBox) {
      alertBox.style.display = 'block';
      alertBox.style.background = 'rgba(239, 68, 68, 0.15)';
      alertBox.style.border = '1px solid rgba(239, 68, 68, 0.4)';
      alertBox.style.color = '#fca5a5';
      alertBox.textContent = 'Erro ao validar código SMS: ' + err.message;
    }
  }
}

function startPhoneResendTimer(seconds) {
  if (phoneResendCountdown) clearInterval(phoneResendCountdown);
  phoneCountdownSeconds = seconds;
  const resendBtn = document.getElementById('btnResendPhoneCode');
  if (!resendBtn) return;
  resendBtn.disabled = true;
  resendBtn.textContent = `Reenviar código (${phoneCountdownSeconds}s)`;
  resendBtn.style.opacity = '0.5';

  phoneResendCountdown = setInterval(() => {
    phoneCountdownSeconds--;
    if (phoneCountdownSeconds <= 0) {
      clearInterval(phoneResendCountdown);
      resendBtn.disabled = false;
      resendBtn.textContent = 'Reenviar código SMS';
      resendBtn.style.opacity = '1';
    } else {
      resendBtn.textContent = `Reenviar código (${phoneCountdownSeconds}s)`;
    }
  }, 1000);
}

function formatPhoneDisplay(countryCode, digits) {
  if (countryCode === '+55' && digits.length >= 10) {
    const ddd = digits.slice(0, 2);
    const part1 = digits.length === 11 ? digits.slice(2, 7) : digits.slice(2, 6);
    const part2 = digits.length === 11 ? digits.slice(7) : digits.slice(6);
    return `+55 (${ddd}) ${part1}-${part2}`;
  }
  return `${countryCode} ${digits}`;
}

function handleLogout() {
  if (!confirm('Deseja realmente desconectar sua conta deste navegador?')) return;

  AppState.authToken = '';
  AppState.isLoggedIn = false;
  AppState.botConnected = false;
  AppState.botUser = null;
  AppState.userProfile = null;  AppState.diamondsBalance = 0;
  AppState.coinsBalance = 0;

  updateAuthUI(false);
  renderBillingStats();
  renderDistributionBars();
  showToast('Conta desconectada com segurança.', 'info');
  openLoginModal();
}

function updateAuthUI(isLoggedIn, username = '') {
  const badge = document.getElementById('connectionModeBadge');
  const text = document.getElementById('connectionModeText');
  const actionBtn = document.getElementById('btnAccountAction');
  const sidebarUsername = document.getElementById('sidebarUsername');
  const sidebarAvatarImg = document.getElementById('sidebarAvatarImg');
  const sidebarAvatarLetter = document.getElementById('sidebarAvatarLetter');
  const sidebarLevelText = document.getElementById('sidebarLevelText');
  const btnCopyUserId = document.getElementById('btnCopyUserId');
  const sidebarSharedId = document.getElementById('sidebarSharedId');
  const authStatusLabel = document.getElementById('authStatusLabel');
  const authStatusSub = document.getElementById('authStatusSub');
  const btnLogoutAccount = document.getElementById('btnLogoutAccount');
  const inputUserToken = document.getElementById('inputUserToken');
  const botAuthStatusPill = document.getElementById('botAuthStatusPill');
  const botAccountUserId = document.getElementById('botAccountUserId');
  const botAccountName = document.getElementById('botAccountName');
  const sidebarOnlineIndicator = document.getElementById('sidebarOnlineIndicator');
  const botOnlineIndicator = document.getElementById('botOnlineIndicator');
  const btnLogoutBotModal = document.getElementById('btnLogoutBotModal');

  if (isLoggedIn) {
    const p = AppState.userProfile || AppState.botUser || {};
    const displayName = p.name || username || 'Robô';
    const id = p.shared_id || p.user_id || p.id || '32037361';

    if (badge) badge.className = 'badge-status live';
    if (text) text.textContent = `🟢 Robô Conectado: ${displayName}`;
    if (actionBtn) actionBtn.innerHTML = `<span>👤 ${escapeHtml(displayName)}</span>`;

    if (sidebarUsername) sidebarUsername.textContent = `${displayName} (Robô Oficial)`;
    const familyName = p.family_info?.family?.name ? ` • ${p.family_info.family.name}` : '';
    if (sidebarLevelText) sidebarLevelText.textContent = `Nível ${p.leveling_progress?.current_level || 6}${familyName}`;

    if (id) {
      if (sidebarSharedId) sidebarSharedId.textContent = id;
      if (btnCopyUserId) btnCopyUserId.style.display = 'inline-flex';
      if (botAccountUserId) botAccountUserId.textContent = id;
    }
    if (botAccountName) botAccountName.textContent = displayName;

    if (botAuthStatusPill) {
      botAuthStatusPill.className = 'badge-tag live-badge';
      botAuthStatusPill.style.background = 'rgba(16, 185, 129, 0.2)';
      botAuthStatusPill.style.color = '#34d399';
      botAuthStatusPill.style.borderColor = 'rgba(16, 185, 129, 0.4)';
      botAuthStatusPill.innerHTML = `<span>✅ CONECTADO (${escapeHtml(displayName)})</span>`;
      botAuthStatusPill.title = 'Conta do Robô autenticada com sucesso no SuperLive';
    }

    if (sidebarOnlineIndicator) sidebarOnlineIndicator.className = 'online-indicator active';
    if (botOnlineIndicator) botOnlineIndicator.className = 'online-indicator active';
    if (btnLogoutBotModal) btnLogoutBotModal.style.display = 'inline-block';

    // Avatar image resolution (SuperLive uses profile_images array)
    let avatarUrl = '';
    if (p.profile_images && p.profile_images.length > 0) {
      avatarUrl = p.profile_images[0].thumbnail_url || p.profile_images[0].url;
    } else if (p.profile_image) {
      avatarUrl = p.profile_image.thumbnail_url || p.profile_image.url;
    } else if (p.avatar) {
      avatarUrl = p.avatar;
    }

    if (sidebarAvatarImg) {
      if (avatarUrl) {
        sidebarAvatarImg.src = avatarUrl;
        sidebarAvatarImg.style.display = 'block';
        if (sidebarAvatarLetter) sidebarAvatarLetter.style.display = 'none';
      } else {
        if (sidebarAvatarLetter) {
          sidebarAvatarLetter.textContent = displayName.charAt(0).toUpperCase();
          sidebarAvatarLetter.style.display = 'block';
        }
        sidebarAvatarImg.style.display = 'none';
      }
    } else if (sidebarAvatarLetter) {
      sidebarAvatarLetter.textContent = displayName.charAt(0).toUpperCase() || '🤖';
    }

    if (authStatusLabel) {
      authStatusLabel.textContent = 'Conta Conectada';
      authStatusLabel.style.color = 'var(--success)';
    }
    if (authStatusSub) {
      authStatusSub.textContent = `Usuário: ${displayName} (ID: ${id}) • Moedas: ${(p.coins || 0).toLocaleString('pt-BR')}`;
    }
    if (btnLogoutAccount) btnLogoutAccount.style.display = 'inline-flex';
    if (inputUserToken) inputUserToken.value = AppState.botConnected ? 'Sessão gerenciada com segurança pelo servidor' : '';

    // Update privacy switches according to profile
    const swCoins = document.getElementById('switchCoinsHidden');
    if (swCoins && p.coins_sent_hidden !== undefined) swCoins.checked = p.coins_sent_hidden;

    const swVip = document.getElementById('switchDiamondsHidden');
    if (swVip && p.vip_diamonds_received_hidden !== undefined) swVip.checked = p.vip_diamonds_received_hidden;

    const swOnline = document.getElementById('switchOnlineHidden');
    if (swOnline && p.online_status_hidden !== undefined) swOnline.checked = p.online_status_hidden;

    const swIncog = document.getElementById('switchIncognito');
    if (swIncog && p.public_stream_incognito !== undefined) swIncog.checked = p.public_stream_incognito;

    const swAnon = document.getElementById('switchAnonymous');
    if (swAnon && p.anonymous_on_gifters_leaderboard !== undefined) swAnon.checked = p.anonymous_on_gifters_leaderboard;
  } else {
    if (badge) badge.className = 'badge-status disconnected';
    if (text) text.textContent = '🔴 Robô não conectado';
    if (actionBtn) actionBtn.innerHTML = '<span>🔑 Conectar Conta</span>';

    if (sidebarUsername) sidebarUsername.textContent = 'Nenhuma Conta';
    if (sidebarLevelText) sidebarLevelText.textContent = 'Toque para conectar';
    if (btnCopyUserId) btnCopyUserId.style.display = 'none';
    if (sidebarAvatarLetter) {
      sidebarAvatarLetter.textContent = '🤖';
      sidebarAvatarLetter.style.display = 'block';
    }
    if (sidebarAvatarImg) sidebarAvatarImg.style.display = 'none';

    if (botAuthStatusPill) {
      botAuthStatusPill.className = 'badge-tag';
      botAuthStatusPill.style.background = 'rgba(239, 68, 68, 0.2)';
      botAuthStatusPill.style.color = '#f87171';
      botAuthStatusPill.style.borderColor = 'rgba(239, 68, 68, 0.4)';
      botAuthStatusPill.innerHTML = `<span>⚠️ NÃO LOGADO (Clique para Login)</span>`;
      botAuthStatusPill.title = 'A conta do robô não está logada ou a sessão expirou. Clique para conectar.';
    }

    if (sidebarOnlineIndicator) sidebarOnlineIndicator.className = 'online-indicator';
    if (botOnlineIndicator) botOnlineIndicator.className = 'online-indicator';
    if (btnLogoutBotModal) btnLogoutBotModal.style.display = 'none';

    if (authStatusLabel) {
      authStatusLabel.textContent = 'Não Autenticado';
      authStatusLabel.style.color = 'var(--warning)';
    }
    if (authStatusSub) authStatusSub.textContent = 'Nenhuma credencial ativa';
    if (btnLogoutAccount) btnLogoutAccount.style.display = 'none';
    if (inputUserToken) inputUserToken.value = '';
  }
}

// --- 6. Coleta de Dados Reais do SuperLive ---
async function fetchEarningStatistics(timeframe = 0) {
  const [resCurrent, resMonth] = await Promise.allSettled([
    apiCall('user_statistic/get_earning_statistic', 'POST', {
      statistic_type: timeframe,
      meta: { page: 1, per_page: 20 }
    }),
    apiCall('user_statistic/get_earning_statistic', 'POST', {
      statistic_type: 2, // 2: MONTH
      meta: { page: 1, per_page: 20 }
    })
  ]);

  if (resCurrent.status === 'fulfilled' && resCurrent.value.ok && resCurrent.value.data) {
    const data = resCurrent.value.data;
    if (data.exchange_rate) {
      AppState.exchangeRate = data.exchange_rate;
    }

    const stats = data.earning_statistics || [];
    if (stats.length > 0) {
      const cur = stats[0];
      AppState.earningsBreakdown = {
        publicStream: cur.public_stream_earning || 0,
        privateStream: cur.private_stream_earning || 0,
        privateCall: cur.private_call_earning || 0,
        conversation: cur.conversation_earning || 0,
        total: cur.total_earning || 0
      };

      AppState.diamondsBalance = cur.total_earning || 0;

      // Real trend calculation
      const trendEl = document.getElementById('statDiamondsTrend');
      if (trendEl) {
        const prev = cur.previous_earning || 0;
        if (prev > 0) {
          const diff = (((cur.total_earning - prev) / prev) * 100).toFixed(1);
          const isUp = diff >= 0;
          trendEl.className = `card-trend ${isUp ? 'up' : 'down'}`;
          trendEl.innerHTML = `<span>${isUp ? '↑ +' : '↓ '}${diff}%</span> vs semana anterior`;
        } else {
          trendEl.className = 'card-trend';
          trendEl.innerHTML = `<span>0 pts</span> na semana anterior`;
        }
      }
    }
  }

  // Monthly earnings from real API
  let monthlyTotal = 0;
  if (resMonth.status === 'fulfilled' && resMonth.value.ok && resMonth.value.data) {
    const mStats = resMonth.value.data.earning_statistics || [];
    if (mStats.length > 0) {
      monthlyTotal = mStats[0].total_earning || 0;
    }
  }

  AppState.monthlyDiamonds = monthlyTotal;

  renderBillingStats();
  renderDistributionBars();
  renderEarningsChart(timeframe);
}

async function fetchPayoutChart() {
  const res = await apiCall('user_statistic/get_payout_chart', 'POST', {});

  if (res.ok && res.data) {
    if (res.data.exchange_rate) {
      AppState.exchangeRate = res.data.exchange_rate;
    }
    if (res.data.diamonds && Array.isArray(res.data.diamonds)) {
      AppState.payoutTiers = res.data.diamonds;
    }
    renderPayoutTiers();
    renderBillingStats();
  }
}

async function fetchPurchaseHistory() {
  const res = await apiCall('user/purchase_history', 'POST', {});

  if (res.ok && res.data) {
    const list = [];
    if (res.data.last_week_purchases && Array.isArray(res.data.last_week_purchases)) {
      res.data.last_week_purchases.forEach(p => {
        if (p.purchase) {
          list.push({
            timestamp: p.purchase.timestamp || Date.now(),
            period: 'Última Semana',
            coins: p.purchase.coins || 0,
            status: 'Concluído'
          });
        }
      });
    }
    if (res.data.before_last_week_purchases && Array.isArray(res.data.before_last_week_purchases)) {
      res.data.before_last_week_purchases.forEach(p => {
        if (p.purchase) {
          list.push({
            timestamp: p.purchase.timestamp || Date.now(),
            period: 'Anterior',
            coins: p.purchase.coins || 0,
            status: 'Concluído'
          });
        }
      });
    }

    AppState.purchaseHistory = list;
    const weekCoinsEl = document.getElementById('statWeekPurchasedCoins');
    const weekTrendEl = document.getElementById('statWeekPurchasedTrend');
    if (weekCoinsEl && res.data.last_week_coins !== undefined) {
      weekCoinsEl.innerHTML = `${(res.data.last_week_coins || 0).toLocaleString('pt-BR')} <span class="unit">moedas</span>`;
    }
    if (weekTrendEl) {
      const count = (res.data.last_week_purchases && res.data.last_week_purchases.length) || 0;
      weekTrendEl.innerHTML = `<span>${count} recargas concluídas na última semana</span>`;
    }
    renderPurchaseHistory();
  }
}

async function fetchAnalytics() {
  await Promise.allSettled([
    apiCall('user_statistic/get_stream_duration_statistic', 'POST', { statistic_type: 0, meta: { page: 1, per_page: 20 } }),
    apiCall('user_statistic/get_viewer_statistic', 'POST', { statistic_type: 0, meta: { page: 1, per_page: 20 } }),
    apiCall('user_statistic/get_follower_statistic', 'POST', { statistic_type: 0, meta: { page: 1, per_page: 20 } })
  ]);

  const p = AppState.userProfile;
  const followers = p ? (p.follower_count || 0) : 0;
  const followersEl = document.getElementById('statNewFollowers');
  if (followersEl) {
    followersEl.innerHTML = `${followers.toLocaleString('pt-BR')} <span class="unit">seguidores</span>`;
  }
}

async function fetchUserSettings() {
  const res = await apiCall('user/settings', 'POST', {});
  if (res.ok && res.data) {
    AppState.settings = res.data;
    if (res.data.urls && res.data.urls.cash_out) {
      AppState.cashOutUrl = res.data.urls.cash_out;
    }
  }
}

async function fetchLeaderboard() {
  const endpoint = AppState.rankingCategory === 'gifters' ? 'gifters_leaderboard' : 'leaderboard';
  const isoList = AppState.selectedCountry ? [AppState.selectedCountry] : [];

  const res = await apiCall(endpoint, 'POST', {
    leaderboard_type: AppState.rankingTimeframe,
    iso_codes: isoList
  });

  if (res.ok && res.data) {
    const items = res.data.items || [];
    const formatted = items.map((item, idx) => {
      const u = item.user || {};
      let avatar = '';
      if (u.profile_images && u.profile_images.length > 0) {
        avatar = u.profile_images[0].thumbnail_url || u.profile_images[0].url;
      } else if (u.profile_image) {
        avatar = u.profile_image.thumbnail_url || u.profile_image.url;
      }

      return {
        rank: item.rank || (idx + 1),
        name: u.name || 'Streamer',
        level: u.level || 1,
        isLive: !!u.is_live,
        points: item.points || item.diamonds || 0,
        country: u.country || 'GLOBAL',
        avatarUrl: avatar,
        sharedId: u.shared_id || u.user_id,
        isOwn: AppState.userProfile && (u.user_id === AppState.userProfile.user_id)
      };
    });

    AppState.leaderboardData = formatted;
    if (res.data.own_user) {
      AppState.ownUserRank = res.data.own_user;
    }

    renderLeaderboard();
  }
}

async function registerNewDeviceId() {
  const res = await apiCall('device/register', 'POST', {
    client_params: {
      app_language: 'pt',
      device_language: 'pt',
      brand_name: 'Samsung',
      display_density: 'xxhdpi',
      display_size: '1080x2400',
      device_preferred_languages: ['pt-BR', 'en-US']
    }
  });

  if (res.ok && res.data && res.data.guid) {
    AppState.deviceId = res.data.guid;
    localStorage.setItem('sc_device_id', res.data.guid);
    document.getElementById('inputDeviceId').value = res.data.guid;
    document.getElementById('directDeviceIdInput').value = res.data.guid;
    showToast(`Novo Device-ID oficial registrado: ${res.data.guid}`, 'success');
  } else {
    showToast('Falha ao registrar novo Device-ID no SuperLive', 'error');
  }
}

// --- 7. Módulo SUPER BILLING ---
function initBillingModule() {
  renderBillingStats();
  renderDistributionBars();
  renderPayoutTiers();
  renderEarningsChart(AppState.selectedTimeframe);
  renderPurchaseHistory();

  // Timeframe selector (Dia / Semana / Mês)
  const pills = document.querySelectorAll('#timeframeFilters .filter-pill');
  pills.forEach((pill) => {
    pill.addEventListener('click', () => {
      pills.forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      AppState.selectedTimeframe = parseInt(pill.getAttribute('data-timeframe'), 10);
      if (AppState.isLoggedIn) {
        fetchEarningStatistics(AppState.selectedTimeframe);
      } else {
        renderEarningsChart(AppState.selectedTimeframe);
      }
    });
  });

  // Currency Converter input logic
  const diamondInput = document.getElementById('calcDiamondInput');
  const usdOutput = document.getElementById('calcUsdOutput');

  diamondInput.addEventListener('input', () => {
    const val = parseFloat(diamondInput.value) || 0;
    const usd = (val / AppState.exchangeRate).toFixed(2);
    const brl = (usd * 5.45).toFixed(2);
    usdOutput.value = `$${usd} USD (≈ R$ ${brl})`;
  });

  // Export Data Buttons
  document.getElementById('btnExportData').addEventListener('click', exportFinancialReport);

  // Sync button in header
  const btnSync = document.getElementById('btnSyncData');
  btnSync.addEventListener('click', async () => {
    const icon = document.getElementById('syncSpinnerIcon');
    icon.classList.add('spinning');
    btnSync.disabled = true;

    try {
      if (AppState.isLoggedIn) {
        await Promise.allSettled([
          apiCall('users/own_profile', 'POST', {}),
          fetchEarningStatistics(AppState.selectedTimeframe),
          fetchPayoutChart(),
          fetchPurchaseHistory(),
          fetchLeaderboard()
        ]);
        showToast('Dados sincronizados em tempo real com a API!', 'success');
      } else {
        await fetchLeaderboard();
        showToast('Ranking ao vivo atualizado! Conecte sua conta para ver seus ganhos.', 'info');
      }
    } finally {
      setTimeout(() => {
        icon.classList.remove('spinning');
        btnSync.disabled = false;
      }, 500);
    }
  });
}

function renderBillingStats() {
  const diamonds = AppState.diamondsBalance;
  const usd = (diamonds / AppState.exchangeRate).toFixed(2);
  const brl = (usd * 5.45).toFixed(2);

  const statDiamondsBalance = document.getElementById('statDiamondsBalance');
  if (statDiamondsBalance) statDiamondsBalance.innerHTML = `${diamonds.toLocaleString('pt-BR')} <span class="unit">pts</span>`;

  const statUsdEstimate = document.getElementById('statUsdEstimate');
  if (statUsdEstimate) statUsdEstimate.innerHTML = `$${usd} <span class="unit">USD</span>`;

  const statExchangeRateInfo = document.getElementById('statExchangeRateInfo');
  if (statExchangeRateInfo) statExchangeRateInfo.textContent = `Taxa Oficial: 1 USD = ${AppState.exchangeRate} Diamantes (≈ R$ ${brl})`;

  const modalCashOutBalance = document.getElementById('modalCashOutBalance');
  if (modalCashOutBalance) {
    modalCashOutBalance.textContent = `${diamonds.toLocaleString('pt-BR')} Diamantes ($${usd} USD ≈ R$ ${brl})`;
  }

  const monthlyEl = document.getElementById('statMonthlyEarnings');
  const monthlyUsdEl = document.getElementById('statMonthlyUsd');
  const monthlyDiamonds = AppState.monthlyDiamonds || 0;
  const monthlyUsd = (monthlyDiamonds / (AppState.exchangeRate || 150)).toFixed(2);
  if (monthlyEl) {
    monthlyEl.innerHTML = `${monthlyDiamonds.toLocaleString('pt-BR')} <span class="unit">pts</span>`;
  }
  if (monthlyUsdEl) {
    monthlyUsdEl.innerHTML = `<span>$${monthlyUsd} USD</span> acumulado no mês`;
  }
}

function renderDistributionBars() {
  const container = document.getElementById('distributionList');
  if (!container) return;

  const b = AppState.earningsBreakdown;
  const total = b.publicStream + b.privateStream + b.privateCall + b.conversation;
  const safeTotal = total > 0 ? total : 1;

  const pPublic = ((b.publicStream / safeTotal) * 100).toFixed(1);
  const pPrivate = ((b.privateStream / safeTotal) * 100).toFixed(1);
  const pCall = ((b.privateCall / safeTotal) * 100).toFixed(1);
  const pChat = ((b.conversation / safeTotal) * 100).toFixed(1);

  container.innerHTML = `
    <div class="distribution-item">
      <div class="dist-header">
        <span class="dist-name"><span class="dist-color-dot" style="background:#6366f1;"></span> Transmissão Pública</span>
        <span>${pPublic}% (${b.publicStream.toLocaleString('pt-BR')} pts)</span>
      </div>
      <div class="progress-track"><div class="progress-fill" style="width:${pPublic}%; background:#6366f1;"></div></div>
    </div>
    <div class="distribution-item">
      <div class="dist-header">
        <span class="dist-name"><span class="dist-color-dot" style="background:#a855f7;"></span> Transmissão Privada</span>
        <span>${pPrivate}% (${b.privateStream.toLocaleString('pt-BR')} pts)</span>
      </div>
      <div class="progress-track"><div class="progress-fill" style="width:${pPrivate}%; background:#a855f7;"></div></div>
    </div>
    <div class="distribution-item">
      <div class="dist-header">
        <span class="dist-name"><span class="dist-color-dot" style="background:#06b6d4;"></span> Chamada de Vídeo 1-on-1</span>
        <span>${pCall}% (${b.privateCall.toLocaleString('pt-BR')} pts)</span>
      </div>
      <div class="progress-track"><div class="progress-fill" style="width:${pCall}%; background:#06b6d4;"></div></div>
    </div>
    <div class="distribution-item">
      <div class="dist-header">
        <span class="dist-name"><span class="dist-color-dot" style="background:#10b981;"></span> Conversa / Álbuns Premium</span>
        <span>${pChat}% (${b.conversation.toLocaleString('pt-BR')} pts)</span>
      </div>
      <div class="progress-track"><div class="progress-fill" style="width:${pChat}%; background:#10b981;"></div></div>
    </div>
  `;
}

function renderPayoutTiers() {
  const container = document.getElementById('payoutTiersContainer');
  if (!container) return;
  container.innerHTML = '';

  AppState.payoutTiers.forEach((tier) => {
    const usd = (tier / AppState.exchangeRate).toFixed(0);
    const chip = document.createElement('div');
    chip.className = 'tier-chip';
    chip.innerHTML = `
      <div class="tier-diamonds">${tier.toLocaleString('pt-BR')} 💎</div>
      <div class="tier-usd">$${usd} USD</div>
    `;

    chip.addEventListener('click', () => {
      document.querySelectorAll('.tier-chip').forEach(c => c.classList.remove('selected'));
      chip.classList.add('selected');
      const diamondInput = document.getElementById('calcDiamondInput');
      if (diamondInput) {
        diamondInput.value = tier;
        diamondInput.dispatchEvent(new Event('input'));
      }
    });

    container.appendChild(chip);
  });
}

function renderEarningsChart(timeframe, apiData = null) {
  const viewport = document.getElementById('earningsChartViewport');
  if (!viewport) return;
  viewport.innerHTML = '';

  if (!AppState.diamondsBalance || AppState.diamondsBalance === 0) {
    viewport.innerHTML = `
      <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; width:100%; height:180px; color:var(--text-muted); gap:10px;">
        <span style="font-size:32px;">📊</span>
        <div style="font-size:14px; font-weight:700; color:var(--text-secondary);">Nenhum ganho registrado neste período</div>
        <div style="font-size:12px; color:var(--text-muted);">Transmita ao vivo ou receba presentes na sua conta para visualizar a evolução gráfica em tempo real.</div>
      </div>
    `;
    return;
  }

  const periods = timeframe === 0 
    ? ['00h-04h', '04h-08h', '08h-12h', '12h-16h', '16h-20h', '20h-24h']
    : timeframe === 1 
    ? ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom']
    : ['Sem 1', 'Sem 2', 'Sem 3', 'Sem 4'];

  periods.forEach((label, idx) => {
    const total = Math.max(10, Math.floor(AppState.diamondsBalance / periods.length * (0.8 + idx * 0.1)));
    const maxVal = Math.max(1, AppState.diamondsBalance);
    const heightPercent = Math.min(100, Math.max(15, (total / maxVal) * 100));

    const barGroup = document.createElement('div');
    barGroup.className = 'chart-bar-group';
    barGroup.title = `${label}: ${total.toLocaleString('pt-BR')} Diamantes`;

    barGroup.innerHTML = `
      <div class="stacked-bar" style="height: ${heightPercent}%;">
        <div class="bar-segment public" style="height: 60%;"></div>
        <div class="bar-segment private" style="height: 20%;"></div>
        <div class="bar-segment call" style="height: 15%;"></div>
        <div class="bar-segment chat" style="height: 5%;"></div>
      </div>
      <span class="bar-label">${label}</span>
    `;

    viewport.appendChild(barGroup);
  });
}

function renderPurchaseHistory() {
  const tbody = document.getElementById('purchaseHistoryBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (AppState.purchaseHistory.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" style="text-align:center; color:var(--text-muted); padding:24px;">
          Nenhum registro de compra de moedas encontrado nesta conta.
        </td>
      </tr>
    `;
    return;
  }

  AppState.purchaseHistory.forEach((item) => {
    const dateStr = new Date(item.timestamp).toLocaleDateString('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${dateStr}</td>
      <td><span class="brand-badge">${item.period}</span></td>
      <td style="font-weight:700; color:var(--gold);">+${item.coins.toLocaleString('pt-BR')} moedas</td>
      <td><span style="color:var(--success); font-weight:700;">✓ ${item.status}</span></td>
    `;
    tbody.appendChild(tr);
  });
}

// --- 8. Módulo SUPER RANKING ---
function initRankingModule() {
  renderLeaderboard();

  // Category switch (Streamers / Gifters / Famílias)
  document.querySelectorAll('#rankingCategoryFilters .filter-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#rankingCategoryFilters .filter-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      AppState.rankingCategory = btn.getAttribute('data-cat');
      fetchLeaderboard();
    });
  });

  // Timeframe switch (Diário / Semanal / Geral)
  document.querySelectorAll('#rankingTimeframeFilters .filter-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#rankingTimeframeFilters .filter-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      AppState.rankingTimeframe = parseInt(btn.getAttribute('data-time'), 10);
      fetchLeaderboard();
    });
  });

  // Country select
  const countrySelect = document.getElementById('countrySelect');
  if (countrySelect) {
    countrySelect.addEventListener('change', (e) => {
      AppState.selectedCountry = e.target.value;
      fetchLeaderboard();
    });
  }
}

function renderLeaderboard() {
  const tbody = document.getElementById('leaderboardTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const list = AppState.leaderboardData;

  if (list.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align:center; color:var(--text-muted); padding:32px;">
          Carregando tabela de classificação ao vivo da API...
        </td>
      </tr>
    `;
    return;
  }

  // Update own position card if available
  const ownCard = document.getElementById('ownRankNumber');
  const ownName = document.getElementById('ownRankName');
  const ownPoints = document.getElementById('ownRankPoints');
  const ownDist = document.getElementById('ownRankDistance');

  if (AppState.isLoggedIn && AppState.userProfile) {
    const ownItem = list.find(u => u.isOwn) || AppState.ownUserRank;
    if (ownItem) {
      ownCard.textContent = `#${ownItem.rank || '--'}`;
      ownName.textContent = `Sua Conta (${AppState.userProfile.name})`;
      ownPoints.textContent = `${(ownItem.points || ownItem.diamonds || AppState.diamondsBalance).toLocaleString('pt-BR')} pts`;
      ownDist.textContent = `Posição oficial no ranking do SuperLive`;
    } else {
      ownCard.textContent = `#--`;
      ownName.textContent = `Sua Conta (${AppState.userProfile.name})`;
      ownPoints.textContent = `${AppState.diamondsBalance.toLocaleString('pt-BR')} pts`;
      ownDist.textContent = `Transmita para entrar no Top Classificados de hoje!`;
    }
  } else {
    ownCard.textContent = `#?`;
    ownName.textContent = `Conecte sua conta para ver sua posição`;
    ownPoints.textContent = `0 pts`;
    ownDist.textContent = `Faça login com seu email ou token SuperLive`;
  }

  list.forEach((user) => {
    const isTop1 = user.rank === 1;
    const isTop2 = user.rank === 2;
    const isTop3 = user.rank === 3;
    const rankClass = isTop1 ? 'rank-1' : isTop2 ? 'rank-2' : isTop3 ? 'rank-3' : 'rank-other';

    const tr = document.createElement('tr');
    if (user.isOwn) {
      tr.style.background = 'rgba(99, 102, 241, 0.15)';
      tr.style.borderLeft = '3px solid var(--primary)';
    }

    const avatarHtml = user.avatarUrl
      ? `<img src="${user.avatarUrl}" class="avatar-small" style="object-fit:cover;" alt="Avatar" onerror="this.onerror=null; this.src=''; this.parentElement.textContent='${user.name.charAt(0)}';">`
      : `<div class="avatar-small">${user.name.charAt(0).toUpperCase()}</div>`;

    tr.innerHTML = `
      <td><span class="rank-badge ${rankClass}">#${user.rank}</span></td>
      <td>
        <div class="user-cell">
          ${avatarHtml}
          <div>
            <div style="font-weight:700;">${user.name} ${user.isOwn ? '<span class="brand-badge">VOCÊ</span>' : ''}</div>
            <small style="color:var(--text-muted);">${user.country} • ID: ${user.sharedId || '--'}</small>
          </div>
        </div>
      </td>
      <td><span class="brand-badge">Lv. ${user.level}</span></td>
      <td>
        ${user.isLive 
          ? '<span class="badge-status live"><span class="pulse-dot"></span> AO VIVO</span>' 
          : '<span style="color:var(--text-muted);font-size:12px;">Offline</span>'}
      </td>
      <td style="text-align: right; font-weight: 800; color: var(--text-primary); font-family: var(--font-mono);">
        ${user.points.toLocaleString('pt-BR')} pts
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// --- 9. Minha Conta & Operações Permitidas ---
function initAccountOperations() {
  document.getElementById('btnSaveCallPrice').addEventListener('click', async () => {
    const price = parseInt(document.getElementById('privateCallPriceInput').value, 10) || 500;
    const res = await apiCall('user/paid_private_call_gift_update', 'POST', { coins: price });
    if (res.ok) {
      showToast(`Preço da Chamada Privada atualizado para ${price} moedas!`, 'success');
    } else {
      showToast(res.data?.error?.message || 'Falha ao atualizar preço da chamada privada.', 'error');
    }
  });

  document.getElementById('btnSaveStreamPrice').addEventListener('click', async () => {
    const price = parseInt(document.getElementById('privateStreamPriceInput').value, 10) || 1000;
    const res = await apiCall('user/private_livestream_gift_update', 'POST', { coins: price });
    if (res.ok) {
      showToast(`Preço de Ingresso na Live Privada atualizado para ${price} moedas!`, 'success');
    } else {
      showToast(res.data?.error?.message || 'Falha ao atualizar preço da live privada.', 'error');
    }
  });

  // Privacy toggles
  const switchMap = [
    { id: 'switchAnonymous', endpoint: 'user/set_gifters_leaderboard_anonymous', param: 'is_anonymous' },
    { id: 'switchCoinsHidden', endpoint: 'user/set_coins_sent_hidden', param: 'is_hidden' },
    { id: 'switchDiamondsHidden', endpoint: 'user/set_vip_diamonds_received_hidden', param: 'is_hidden' },
    { id: 'switchOnlineHidden', endpoint: 'user/set_online_status_hidden', param: 'is_hidden' },
    { id: 'switchIncognito', endpoint: 'user/set_public_stream_incognito', param: 'is_incognito' }
  ];

  switchMap.forEach(item => {
    const el = document.getElementById(item.id);
    if (!el) return;
    el.addEventListener('change', async () => {
      if (!AppState.isLoggedIn) {
        showToast('Conecte sua conta para alterar as opções de privacidade no SuperLive', 'info');
        openLoginModal();
        return;
      }
      const body = {};
      body[item.param] = el.checked;
      const res = await apiCall(item.endpoint, 'POST', body);
      if (res.ok) {
        showToast('Configuração de privacidade salva no SuperLive!', 'success');
      } else {
        showToast('Falha ao salvar configuração no servidor.', 'error');
      }
    });
  });
}

// --- 10. Conexão API & Painel de Diagnóstico ---
function initConnectionTester() {
  const hostInput = document.getElementById('inputApiHost');
  const tokenInput = document.getElementById('inputUserToken');
  const deviceInput = document.getElementById('inputDeviceId');

  hostInput.value = AppState.apiHost;
  deviceInput.value = AppState.deviceId;

  document.getElementById('btnTestConnection').addEventListener('click', async () => {
    AppState.apiHost = hostInput.value.trim();
    showToast('Testando conexão direta com o SuperLive...', 'info');
    const res = await apiCall('users/own_profile', 'POST', {});

    if (res.ok) {
      showToast('Conexão oficial bem-sucedida! Conta autenticada.', 'success');
      AppState.isLoggedIn = true;
      updateAuthUI(true, res.data?.user?.name || 'Streamer');
    } else if (res.status === 401) {
      showToast('API respondeu normalmente (401 - Você precisa fazer login).', 'info');
      openLoginModal();
    } else {
      showToast(`Resposta do servidor: Status ${res.status}`, 'error');
    }
  });

  document.getElementById('btnRegenDeviceId').addEventListener('click', () => {
    registerNewDeviceId();
  });

  document.getElementById('btnClearHttpLog').addEventListener('click', () => {
    const container = document.getElementById('connectionStatusLog');
    if (container) {
      container.innerHTML = '<div class="log-item" style="color:var(--text-muted);">[LOG LIMPO] Aguardando novas requisições...</div>';
    }
  });

  document.getElementById('btnOpenLoginModalFromSettings').addEventListener('click', () => {
    openLoginModal();
  });

  document.getElementById('btnLogoutAccount').addEventListener('click', () => {
    handleLogout();
  });
}

async function checkServerProxyStatus() {
  try {
    const res = await fetch('/server-status');
    if (res.ok) {
      const data = await res.json();
      const el = document.getElementById('proxyStatusLabel');
      if (el) el.textContent = `Online • GUID ${data.cachedDeviceId ? data.cachedDeviceId.slice(0, 8) : ''}...`;
      if (data.cachedDeviceId && !localStorage.getItem('sc_device_id')) {
        AppState.deviceId = data.cachedDeviceId;
        localStorage.setItem('sc_device_id', data.cachedDeviceId);
      }
    }
  } catch (e) {}
}

// --- 11. Modal de Login / Conexão de Conta ---
function initLoginModal() {
  const modal = document.getElementById('loginModal');
  const btnClose = document.getElementById('btnCloseLoginModal');
  const btnAccountAction = document.getElementById('btnAccountAction');
  const sidebarAccountPill = document.getElementById('sidebarAccountPill');
  const btnOpenBotLoginModal = document.getElementById('btnOpenBotLoginModal');
  const botAuthStatusPill = document.getElementById('botAuthStatusPill');
  const btnLogoutBotModal = document.getElementById('btnLogoutBotModal');

  window.openLoginModal = () => {
    if (modal) modal.classList.add('active');
  };

  window.closeLoginModal = () => {
    if (modal) modal.classList.remove('active');
  };

  if (btnClose) btnClose.addEventListener('click', closeLoginModal);
  if (btnAccountAction) btnAccountAction.addEventListener('click', openLoginModal);
  if (sidebarAccountPill) sidebarAccountPill.addEventListener('click', openLoginModal);
  if (btnOpenBotLoginModal) btnOpenBotLoginModal.addEventListener('click', openLoginModal);
  if (botAuthStatusPill) botAuthStatusPill.addEventListener('click', openLoginModal);
  if (btnLogoutBotModal) btnLogoutBotModal.addEventListener('click', handleBotLogout);

  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeLoginModal();
    });
  }

  // Tab switching inside modal
  const tabs = [
    { btn: 'tabBtnEmail', pane: 'tabPaneEmail' },
    { btn: 'tabBtnPhone', pane: 'tabPanePhone' },
    { btn: 'tabBtnToken', pane: 'tabPaneToken' },
    { btn: 'tabBtnHelp', pane: 'tabPaneHelp' }
  ];

  tabs.forEach(t => {
    const btnEl = document.getElementById(t.btn);
    if (!btnEl) return;
    btnEl.addEventListener('click', () => {
      document.querySelectorAll('.modal-tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.modal-tab-pane').forEach(p => p.classList.remove('active'));
      btnEl.classList.add('active');
      const paneEl = document.getElementById(t.pane);
      if (paneEl) paneEl.classList.add('active');
    });
  });

  const btnGoBack = document.getElementById('btnGoBackToLogin');
  if (btnGoBack) {
    btnGoBack.addEventListener('click', () => {
      document.getElementById('tabBtnEmail')?.click();
    });
  }

  // Password toggle
  const pwdInput = document.getElementById('loginPassword');
  const pwdToggle = document.getElementById('btnTogglePassword');
  if (pwdToggle && pwdInput) {
    pwdToggle.addEventListener('click', () => {
      const isPassword = pwdInput.type === 'password';
      pwdInput.type = isPassword ? 'text' : 'password';
      pwdToggle.textContent = isPassword ? '🔒' : '👁️';
    });
  }

  // Pre-fill email and token inputs with user credentials
  const emailInput = document.getElementById('loginEmail');
  if (emailInput && !emailInput.value) {
    emailInput.value = 'contato.gefferson@hotmail.com';
  }
  const tokenInput = document.getElementById('directTokenInput');
  if (tokenInput && !tokenInput.value) {
    tokenInput.value = '';
  }
  const devIdInput = document.getElementById('directDeviceIdInput');
  if (devIdInput && !devIdInput.value) {
    devIdInput.value = AppState.deviceId;
  }

  // Submit Email Login
  const btnSubmitEmail = document.getElementById('btnSubmitEmailLogin');
  if (btnSubmitEmail) {
    btnSubmitEmail.addEventListener('click', () => {
      const email = document.getElementById('loginEmail')?.value.trim() || '';
      const password = document.getElementById('loginPassword')?.value || '';
      if (!email || !password) {
        showToast('Por favor, informe seu email e senha do SuperLive.', 'error');
        return;
      }
      handleEmailLogin(email, password);
    });
  }

  // Submit Token Login
  const btnSubmitToken = document.getElementById('btnSubmitTokenLogin');
  if (btnSubmitToken) {
    btnSubmitToken.addEventListener('click', () => {
      const token = document.getElementById('directTokenInput')?.value.trim() || '';
      const devId = document.getElementById('directDeviceIdInput')?.value.trim() || '';
      if (!token) {
        showToast('Por favor, cole seu Token de acesso.', 'error');
        return;
      }
      handleTokenLogin(token, devId);
    });
  }

  // Register GUID from inside modal
  const btnRegGuid = document.getElementById('btnRegisterNewGuidModal');
  if (btnRegGuid) {
    btnRegGuid.addEventListener('click', () => {
      registerNewDeviceId();
    });
  }

  // --- Phone Login Event Listeners ---
  const btnSendPhoneCode = document.getElementById('btnSendPhoneCode');
  if (btnSendPhoneCode) {
    btnSendPhoneCode.addEventListener('click', () => handleSendPhoneCode(false));
  }

  const btnSubmitPhoneCode = document.getElementById('btnSubmitPhoneCode');
  if (btnSubmitPhoneCode) {
    btnSubmitPhoneCode.addEventListener('click', handleVerifyPhoneCode);
  }

  const btnBackToPhone = document.getElementById('btnBackToPhoneInput');
  if (btnBackToPhone) {
    btnBackToPhone.addEventListener('click', () => {
      const p2 = document.getElementById('phoneStep2');
      const p1 = document.getElementById('phoneStep1');
      if (p2) p2.style.display = 'none';
      if (p1) p1.style.display = 'flex';
      if (phoneResendCountdown) clearInterval(phoneResendCountdown);
    });
  }

  const btnResendPhoneCode = document.getElementById('btnResendPhoneCode');
  if (btnResendPhoneCode) {
    btnResendPhoneCode.addEventListener('click', () => {
      if (!btnResendPhoneCode.disabled) {
        handleSendPhoneCode(true);
      }
    });
  }

  // Auto submit or format SMS code input
  const smsInput = document.getElementById('loginSmsCode');
  if (smsInput) {
    smsInput.addEventListener('input', (e) => {
      e.target.value = e.target.value.replace(/\D/g, '');
      if (e.target.value.length === 6) {
        handleVerifyPhoneCode();
      }
    });
    smsInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        handleVerifyPhoneCode();
      }
    });
  }

  // Auto-mask Brazilian phone number
  const phoneInput = document.getElementById('loginPhoneNumber');
  if (phoneInput) {
    phoneInput.addEventListener('input', (e) => {
      const countryCode = document.getElementById('loginPhoneCountryCode')?.value || '+55';
      if (countryCode === '+55') {
        let v = e.target.value.replace(/\D/g, '');
        if (v.length > 11) v = v.slice(0, 11);
        if (v.length > 6) {
          e.target.value = `(${v.slice(0, 2)}) ${v.slice(2, 7)}-${v.slice(7)}`;
        } else if (v.length > 2) {
          e.target.value = `(${v.slice(0, 2)}) ${v.slice(2)}`;
        } else if (v.length > 0) {
          e.target.value = `(${v}`;
        }
      }
    });
    phoneInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        handleSendPhoneCode(false);
      }
    });
  }
}

function initCopyUserId() {
  const btn = document.getElementById('btnCopyUserId');
  if (btn) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = document.getElementById('sidebarSharedId')?.textContent;
      if (id && id !== '--') {
        navigator.clipboard.writeText(id).then(() => {
          showToast(`ID ${id} copiado para a área de transferência!`, 'success');
        });
      }
    });
  }
}

// --- 12. Modal de Resgate / Saque (Cash-Out) ---
function initCashOutModal() {
  const modal = document.getElementById('cashOutModal');
  const btnOpen = document.getElementById('btnOpenCashOut');
  const btnClose = document.getElementById('btnCloseCashOut');
  const btnCancel = document.getElementById('btnCancelCashOut');
  const btnProceed = document.getElementById('btnProceedCashOut');

  btnOpen.addEventListener('click', () => {
    modal.classList.add('active');
  });

  const closeModal = () => modal.classList.remove('active');
  btnClose.addEventListener('click', closeModal);
  btnCancel.addEventListener('click', closeModal);

  btnProceed.addEventListener('click', () => {
    if (AppState.cashOutUrl) {
      window.open(AppState.cashOutUrl, '_blank');
      showToast('Redirecionando para o portal oficial de saque...', 'success');
    } else {
      window.open('https://api.sprlv-api.com/', '_blank');
      showToast('Abrindo ambiente de saque seguro da sua conta...', 'info');
    }
    closeModal();
  });
}

// --- 13. Navegação em Seções do Robô Moderador ---
function initNavigation() {
  const navItems = document.querySelectorAll('.nav-item');
  const pageTitle = document.getElementById('pageTitle');
  const pageSubtitle = document.getElementById('pageSubtitle');

  navItems.forEach((item) => {
    item.addEventListener('click', (e) => {
      const href = item.getAttribute('href');
      if (href && href.startsWith('#')) {
        e.preventDefault();
        navItems.forEach((n) => n.classList.remove('active'));
        item.classList.add('active');
        const targetEl = document.querySelector(href);
        if (targetEl) {
          targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }
    });
  });
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// --- 14. Exportação de Relatórios Financeiros ---
function exportFinancialReport() {
  const b = AppState.earningsBreakdown;
  const totalDiamonds = AppState.diamondsBalance;
  const usd = (totalDiamonds / AppState.exchangeRate).toFixed(2);
  const brl = (usd * 5.45).toFixed(2);

  const reportData = {
    app: "Super Client",
    user: AppState.userProfile ? {
      name: AppState.userProfile.name,
      userId: AppState.userProfile.user_id,
      sharedId: AppState.userProfile.shared_id,
      level: AppState.userProfile.leveling_progress?.current_level || 6
    } : null,
    generatedAt: new Date().toISOString(),
    currency: "USD / BRL",
    exchangeRate: AppState.exchangeRate,
    diamondsBalance: totalDiamonds,
    usdEquivalent: usd,
    brlEquivalent: brl,
    breakdown: b,
    purchases: AppState.purchaseHistory
  };

  const blob = new Blob([JSON.stringify(reportData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `SuperClient_Relatorio_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Relatório financeiro exportado com sucesso!', 'success');
}

// =========================================================================
// 15. ROBÔ MODERADOR & ASSISTENTE DE LIVE (MOTOR INTEGRADO)
// =========================================================================
function initBotModeratorModule() {
  let botConfig = {
    creatorUserId: '',
    livestreamId: '',
    autoDetectLive: true,
    moderationEnabled: true,
    muteWords: ['palavrao', 'xingamento', 'ofensa', 'lixo', 'trouxa', 'golpe', 'fake'],
    banWords: ['pedofilia', 'menor', 'crime', 'droga', 'estelionato', 'pix falso'],
    caseSensitive: false,
    exactMatch: false,
    recurringEnabled: true,
    recurringIntervalSeconds: 120,
    recurringMessages: [
      '✨ Bem-vindos à live! Siga o perfil da criadora para não perder transmissões exclusivas!',
      '🎁 Envie presentes para apoiarmos a transmissão e batermos a meta de hoje!',
      '📸 Acompanhe as novidades e bastidores também no Instagram! Compartilhe a live com os amigos!'
    ],
    recurringCurrentIndex: 0,
    dmEnabled: true,
    dmTemplate: 'Live finalizada! Hoje você alcançou {viewers} espectadores e gerou {diamonds} diamantes na transmissão. Parabéns pelo show! ❤️',
    botToken: '',
    botUserId: '32037361',
    botName: '𝑨́𝒕𝒊𝒍𝒂',
    deviceId: 'e7a42524b5241eb9a73f28bc11b4f2ed'
  };

  let botStatus = {
    isMonitoring: false,
    wsConnected: false,
    activeLive: null,
    countdownSeconds: 120,
    stats: { messagesAnalyzed: 0, usersMuted: 0, usersBanned: 0, announcementsSent: 0, dmsSent: 0 }
  };

  let pollInterval = null;

  // DOM Elements
  const btnToggleMonitoring = document.getElementById('btnBotToggleMonitoring');
  const btnToggleIcon = document.getElementById('btnBotToggleIcon');
  const btnToggleText = document.getElementById('btnBotToggleText');
  const btnSaveConfig = document.getElementById('btnBotSaveConfig');
  const btnDetectLive = document.getElementById('btnDetectLive');
  const inputCreatorUserId = document.getElementById('botCreatorUserId');
  const selectSavedCreator = document.getElementById('botSelectSavedCreator');
  const btnDeleteCreator = document.getElementById('btnDeleteSelectedCreator');
  const savedCreatorsBadge = document.getElementById('savedCreatorsCountBadge');
  let savedCreatorsList = [];

  const botWsBadge = document.getElementById('botWsStatusBadge');
  const botNavBadge = document.getElementById('botNavStatusBadge');
  const botStatusText = document.getElementById('botStatusText');
  const liveBadgePill = document.getElementById('botLiveBadgePill');
  const liveBadgeText = document.getElementById('botLiveBadgeText');
  const liveInfoPreview = document.getElementById('botLiveInfoPreview');

  // Stats Elements
  const statAnalyzed = document.getElementById('botStatAnalyzed');
  const statMutes = document.getElementById('botStatMutes');
  const statBans = document.getElementById('botStatBans');
  const statAnnouncements = document.getElementById('botStatAnnouncements');
  const statDms = document.getElementById('botStatDms');
  const statCountdownTrend = document.getElementById('botStatCountdownTrend');
  const countdownTimerText = document.getElementById('botCountdownTimerText');

  // Rules Elements
  const toggleModeration = document.getElementById('botToggleModeration');
  const muteWordsTags = document.getElementById('muteWordsTags');
  const banWordsTags = document.getElementById('banWordsTags');
  const muteWordsCount = document.getElementById('muteWordsCount');
  const banWordsCount = document.getElementById('banWordsCount');
  const inputNewMuteWord = document.getElementById('inputNewMuteWord');
  const btnAddMuteWord = document.getElementById('btnAddMuteWord');
  const inputNewBanWord = document.getElementById('inputNewBanWord');
  const btnAddBanWord = document.getElementById('btnAddBanWord');
  const checkCaseSensitive = document.getElementById('botCaseSensitive');
  const checkExactMatch = document.getElementById('botExactMatch');

  // Recurring Elements
  const toggleRecurring = document.getElementById('botToggleRecurring');
  const selectRecurringInterval = document.getElementById('botRecurringInterval');
  const queueList = document.getElementById('botQueueList');
  const inputNewQueueMsg = document.getElementById('inputNewQueueMessage');
  const btnAddQueueMsg = document.getElementById('btnAddQueueMessage');

  // DM Elements
  const toggleDm = document.getElementById('botToggleDm');
  const txtDmTemplate = document.getElementById('botDmTemplate');
  const previewDMBubble = document.getElementById('botDmPreviewText');
  const btnTestDm = document.getElementById('btnTestDmNow');

  // Consoles
  const chatFeedContainer = document.getElementById('botChatFeedContainer');
  const auditLogContainer = document.getElementById('botAuditLogContainer');
  const inputManualChat = document.getElementById('inputManualChatMessage');
  const btnSendManualChat = document.getElementById('btnSendManualChat');
  const btnClearLogs = document.getElementById('btnClearBotLogs');

  // --- Funções de Renderização de Tags ---
  function renderMuteTags() {
    if (!muteWordsTags) return;
    muteWordsTags.innerHTML = '';
    botConfig.muteWords.forEach((word, idx) => {
      const pill = document.createElement('span');
      pill.className = 'tag-pill mute-pill';
      pill.innerHTML = `<span>${escapeHtml(word)}</span><button class="tag-remove-btn" data-type="mute" data-index="${idx}" title="Remover">&times;</button>`;
      muteWordsTags.appendChild(pill);
    });
    if (muteWordsCount) muteWordsCount.textContent = `${botConfig.muteWords.length} palavras`;
  }

  function renderBanTags() {
    if (!banWordsTags) return;
    banWordsTags.innerHTML = '';
    botConfig.banWords.forEach((word, idx) => {
      const pill = document.createElement('span');
      pill.className = 'tag-pill ban-pill';
      pill.innerHTML = `<span>${escapeHtml(word)}</span><button class="tag-remove-btn" data-type="ban" data-index="${idx}" title="Remover">&times;</button>`;
      banWordsTags.appendChild(pill);
    });
    if (banWordsCount) banWordsCount.textContent = `${botConfig.banWords.length} palavras`;
  }

  // --- Funções de Renderização da Fila ---
  function renderQueueList() {
    if (!queueList) return;
    queueList.innerHTML = '';

    if (!botConfig.recurringMessages || botConfig.recurringMessages.length === 0) {
      queueList.innerHTML = '<div style="color:var(--text-muted); font-size:12px; padding:12px; text-align:center;">Nenhuma mensagem na fila. Adicione mensagens abaixo para criar o ciclo.</div>';
      return;
    }

    const currentIdx = (botConfig.recurringCurrentIndex || 0) % botConfig.recurringMessages.length;

    botConfig.recurringMessages.forEach((msg, idx) => {
      const isNext = (idx === currentIdx);
      const item = document.createElement('div');
      item.className = `queue-item ${isNext ? 'active-sending' : ''}`;
      
      const numStr = (idx + 1).toString().padStart(2, '0');
      item.innerHTML = `
        <div class="queue-number">${numStr}</div>
        <div class="queue-text">${escapeHtml(msg)}</div>
        <div class="queue-actions">
          ${isNext ? '<span class="badge-tag live-badge" style="font-size:10px; padding:2px 6px;">PRÓXIMA</span>' : ''}
          <button class="btn-icon-xs btn-queue-up" data-index="${idx}" title="Subir na fila" ${idx === 0 ? 'disabled style="opacity:0.3"' : ''}>▲</button>
          <button class="btn-icon-xs btn-queue-down" data-index="${idx}" title="Descer na fila" ${idx === botConfig.recurringMessages.length - 1 ? 'disabled style="opacity:0.3"' : ''}>▼</button>
          <button class="btn-icon-xs delete btn-queue-del" data-index="${idx}" title="Excluir da fila">🗑️</button>
        </div>
      `;
      queueList.appendChild(item);
    });
  }

  // --- Pré-visualização da DM ---
  function updateDmPreview() {
    if (!txtDmTemplate || !previewDMBubble) return;
    const tpl = txtDmTemplate.value;
    const samplePreview = tpl
      .replace(/{creator}/gi, 'Criadora Oficial')
      .replace(/{viewers}/gi, '142')
      .replace(/{diamonds}/gi, '2.850')
      .replace(/{followers}/gi, '19')
      .replace(/{duration}/gi, '1h 45min');
    previewDMBubble.textContent = samplePreview;
  }

  // --- Formatador de Tempo ---
  function formatCountdown(sec) {
    if (sec <= 0 || isNaN(sec)) return '00:00';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  // --- Carregar Lista de Streamers Salvas ---
  async function loadSavedCreators() {
    try {
      const res = await fetch('/api/bot/creators');
      if (!res.ok) return;
      const data = await res.json();
      if (!data.success) return;

      savedCreatorsList = data.creators || [];
      if (savedCreatorsBadge) {
        savedCreatorsBadge.textContent = `${savedCreatorsList.length} ${savedCreatorsList.length === 1 ? 'Salva' : 'Salvas'}`;
      }

      if (selectSavedCreator) {
        const currentActiveId = (data.activeCreator && (data.activeCreator.sharedId || data.activeCreator.userId)) || botConfig.creatorUserId || '';
        selectSavedCreator.innerHTML = '<option value="">-- Trocar Streamer --</option>';

        savedCreatorsList.forEach((c) => {
          const opt = document.createElement('option');
          const uid = String(c.sharedId || c.userId || '');
          opt.value = uid;
          const liveMark = c.isLive ? '🔴 ' : '👤 ';
          opt.textContent = `${liveMark}${c.name || 'Criadora'} (${uid})`;
          if (uid && String(uid) === String(currentActiveId)) {
            opt.selected = true;
          }
          selectSavedCreator.appendChild(opt);
        });

        if (btnDeleteCreator) {
          btnDeleteCreator.style.display = selectSavedCreator.value ? 'inline-flex' : 'none';
        }
      }
    } catch (e) {
      console.warn('[BOT UI] Falha ao listar criadoras salvas:', e.message);
    }
  }

  // --- Carregar Configurações do Backend ---
  async function loadBotConfig() {
    try {
      await loadSavedCreators();
      const res = await fetch('/api/bot/config');
      if (res.ok) {
        const data = await res.json();
        botConfig = { ...botConfig, ...data };

        // Garante mensagens padrão caso a lista venha vazia
        if (!botConfig.recurringMessages || botConfig.recurringMessages.length === 0) {
          botConfig.recurringMessages = [
            '✨ Bem-vindos à live! Siga o perfil da criadora para não perder transmissões exclusivas!',
            '🎁 Envie presentes para apoiarmos a transmissão e batermos a meta de hoje!',
            '📸 Acompanhe as novidades e bastidores também no Instagram! Compartilhe a live com os amigos!'
          ];
        }

        // Preenche campos do formulário sem travar o usuário
        if (inputCreatorUserId && document.activeElement !== inputCreatorUserId) {
          if (botConfig.creatorUserId) {
            inputCreatorUserId.value = botConfig.creatorUserId;
          }
        }
        if (toggleModeration) toggleModeration.checked = botConfig.moderationEnabled;
        if (checkCaseSensitive) checkCaseSensitive.checked = botConfig.caseSensitive;
        if (checkExactMatch) checkExactMatch.checked = botConfig.exactMatch;
        if (toggleRecurring) toggleRecurring.checked = botConfig.recurringEnabled;
        if (selectRecurringInterval) selectRecurringInterval.value = String(botConfig.recurringIntervalSeconds || 120);
        if (toggleDm) toggleDm.checked = botConfig.dmEnabled;
        if (txtDmTemplate) txtDmTemplate.value = botConfig.dmTemplate;

        renderMuteTags();
        renderBanTags();
        renderQueueList();
        updateDmPreview();
      }
    } catch (e) {
      console.warn('[BOT UI] Não foi possível carregar bot_config do servidor:', e.message);
    }
  }

  // --- Salvar Configurações no Backend ---
  async function saveBotConfig(showNotification = true) {
    if (inputCreatorUserId) botConfig.creatorUserId = inputCreatorUserId.value.trim();
    if (toggleModeration) botConfig.moderationEnabled = toggleModeration.checked;
    if (checkCaseSensitive) botConfig.caseSensitive = checkCaseSensitive.checked;
    if (checkExactMatch) botConfig.exactMatch = checkExactMatch.checked;
    if (toggleRecurring) botConfig.recurringEnabled = toggleRecurring.checked;
    if (selectRecurringInterval) botConfig.recurringIntervalSeconds = parseInt(selectRecurringInterval.value) || 120;
    if (toggleDm) botConfig.dmEnabled = toggleDm.checked;
    if (txtDmTemplate) botConfig.dmTemplate = txtDmTemplate.value;

    try {
      const res = await fetch('/api/bot/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(botConfig)
      });
      if (res.ok) {
        if (showNotification) showToast('Regras de moderação e mensagens salvas!', 'success');
      } else {
        showToast('Erro ao salvar regras no servidor.', 'danger');
      }
    } catch (e) {
      showToast(`Falha de conexão: ${e.message}`, 'danger');
    }
  }

  // --- Polling de Status em Tempo Real ---
  async function syncBotStatus() {
    try {
      const res = await fetch('/api/bot/status');
      if (!res.ok) return;
      const data = await res.json();
      botStatus = data;

      // Status da Conexão em Tempo Real (WebSocket & REST DualSync)
      if (botWsBadge) {
        if (data.wsConnected) {
          botWsBadge.textContent = 'ONLINE (WS)';
          botWsBadge.className = 'badge-tag live-badge';
          botWsBadge.title = 'Conectado via WebSocket oficial do SuperLive';
        } else if (data.dualSyncActive || (data.isMonitoring && data.activeLive)) {
          botWsBadge.textContent = 'ONLINE (DUAL-SYNC)';
          botWsBadge.className = 'badge-tag live-badge';
          botWsBadge.title = 'Conectado e sincronizando chat em tempo real via REST DualSync oficial';
        } else if (data.isMonitoring) {
          botWsBadge.textContent = 'MODO VIGILANTE';
          botWsBadge.className = 'badge-tag';
          botWsBadge.style.background = 'rgba(99,102,241,0.2)';
          botWsBadge.style.color = '#a5b4fc';
          botWsBadge.style.borderColor = 'rgba(99,102,241,0.5)';
          botWsBadge.title = 'Robô em Modo Vigilante aguardando o início da live';
        } else {
          botWsBadge.textContent = 'STANDBY (PRONTO)';
          botWsBadge.className = 'badge-tag';
          botWsBadge.style.background = 'rgba(255,255,255,0.08)';
          botWsBadge.style.color = 'var(--text-secondary)';
          botWsBadge.style.borderColor = 'rgba(255,255,255,0.12)';
          botWsBadge.title = 'Robô pronto para entrar na live. Clique em Iniciar Moderação ou Detectar Live.';
        }
      }

      // Status Geral do Robô
      if (botStatusText) {
        if (data.isMonitoring && data.activeLive) {
          botStatusText.innerHTML = `<span style="color:var(--success);">● Monitorando Live #${data.activeLive.livestream_id}</span>`;
        } else if (data.isMonitoring) {
          botStatusText.innerHTML = `<span style="color:var(--accent);">● Aguardando início de Live...</span>`;
        } else {
          botStatusText.innerHTML = `<span style="color:var(--text-muted);">Inativo</span>`;
        }
      }

      // Atualização dos Dados da Conta Oficial do Robô
      const botAccountNameEl = document.getElementById('botAccountName');
      const botAccountUserIdEl = document.getElementById('botAccountUserId');
      const botAuthStatusPill = document.getElementById('botAuthStatusPill');
      const botOnlineIndicator = document.getElementById('botOnlineIndicator');
      const sidebarUsername = document.getElementById('sidebarUsername');
      const sidebarSharedId = document.getElementById('sidebarSharedId');
      const btnLogoutBotModal = document.getElementById('btnLogoutBotModal');

      const isBotLoggedIn = data.isLoggedIn === true && data.authFailed !== true;
      const botName = (data.config && data.config.botName) ? data.config.botName : 'Átila';
      AppState.botConnected = isBotLoggedIn;
      AppState.botUser = isBotLoggedIn ? { id: data.config?.botUserId, name: botName } : null;

      // Cabeçalho global deve refletir a sessão do robô imediatamente.
      const globalBadge = document.getElementById('connectionModeBadge');
      const globalText = document.getElementById('connectionModeText');
      if (globalBadge && globalText) {
        if (isBotLoggedIn) {
          globalBadge.className = 'badge-status live';
          globalText.textContent = `🟢 Robô conectado: ${botName}`;
        } else {
          globalBadge.className = 'badge-status disconnected';
          globalText.textContent = '🔴 Robô não conectado';
        }
      }
      const botUserId = (data.config && data.config.botUserId) ? data.config.botUserId : '32037361';

      if (botAccountNameEl) botAccountNameEl.textContent = botName;
      if (botAccountUserIdEl) botAccountUserIdEl.textContent = botUserId;
      if (sidebarUsername) sidebarUsername.textContent = `${botName} (Robô Oficial)`;
      if (sidebarSharedId) sidebarSharedId.textContent = botUserId;

      if (botAuthStatusPill) {
        if (isBotLoggedIn) {
          botAuthStatusPill.className = 'badge-tag live-badge';
          botAuthStatusPill.style.background = 'rgba(16, 185, 129, 0.2)';
          botAuthStatusPill.style.color = '#34d399';
          botAuthStatusPill.style.borderColor = 'rgba(16, 185, 129, 0.4)';
          botAuthStatusPill.innerHTML = `<span>✅ CONECTADO (${escapeHtml(botName)})</span>`;
          botAuthStatusPill.title = 'Conta do Robô autenticada com sucesso no SuperLive';
          if (botOnlineIndicator) botOnlineIndicator.className = 'online-indicator active';
          const sidebarOnlineIndicator = document.getElementById('sidebarOnlineIndicator');
          if (sidebarOnlineIndicator) sidebarOnlineIndicator.className = 'online-indicator active';
          if (btnLogoutBotModal) btnLogoutBotModal.style.display = 'inline-block';
        } else if (data.authState === 'unknown' && data.botAccount && data.botAccount.hasToken) {
          botAuthStatusPill.className = 'badge-tag';
          botAuthStatusPill.style.background = 'rgba(245, 158, 11, 0.16)';
          botAuthStatusPill.style.color = '#fbbf24';
          botAuthStatusPill.style.borderColor = 'rgba(245, 158, 11, 0.35)';
          botAuthStatusPill.innerHTML = '<span>⏳ VALIDANDO SESSÃO...</span>';
          botAuthStatusPill.title = 'Validando a sessão persistida do robô.';
          if (botOnlineIndicator) botOnlineIndicator.className = 'online-indicator';
        } else if (data.authState === 'invalid' || data.authFailed) {
          botAuthStatusPill.className = 'badge-tag';
          botAuthStatusPill.style.background = 'rgba(239, 68, 68, 0.2)';
          botAuthStatusPill.style.color = '#f87171';
          botAuthStatusPill.style.borderColor = 'rgba(239, 68, 68, 0.4)';
          botAuthStatusPill.innerHTML = '<span>⚠️ SESSÃO EXPIRADA</span>';
          botAuthStatusPill.title = data.lastAuthError || 'A sessão do robô foi rejeitada pelo SuperLive. Faça login novamente.';
          if (botOnlineIndicator) botOnlineIndicator.className = 'online-indicator';
          const sidebarOnlineIndicator = document.getElementById('sidebarOnlineIndicator');
          if (sidebarOnlineIndicator) sidebarOnlineIndicator.className = 'online-indicator';
          if (btnLogoutBotModal) btnLogoutBotModal.style.display = 'none';
        } else {
          botAuthStatusPill.className = 'badge-tag';
          botAuthStatusPill.style.background = 'rgba(239, 68, 68, 0.2)';
          botAuthStatusPill.style.color = '#f87171';
          botAuthStatusPill.style.borderColor = 'rgba(239, 68, 68, 0.4)';
          botAuthStatusPill.innerHTML = `<span>⚠️ NÃO LOGADO (Clique para Login)</span>`;
          botAuthStatusPill.title = 'A conta do robô não está logada ou a sessão expirou. Clique para conectar.';
          if (botOnlineIndicator) botOnlineIndicator.className = 'online-indicator';
          const sidebarOnlineIndicator = document.getElementById('sidebarOnlineIndicator');
          if (sidebarOnlineIndicator) sidebarOnlineIndicator.className = 'online-indicator';
          if (btnLogoutBotModal) btnLogoutBotModal.style.display = 'none';
        }
      }

      window.triggerBotStatusRefresh = syncBotStatus;

      // Badge no Menu Lateral
      if (botNavBadge) {
        if (data.activeLive) {
          botNavBadge.textContent = 'LIVE';
          botNavBadge.className = 'badge-tag live-badge';
        } else if (data.isMonitoring) {
          botNavBadge.textContent = 'ON';
          botNavBadge.className = 'badge-tag info-badge';
        } else {
          botNavBadge.textContent = 'OFF';
          botNavBadge.className = 'badge-tag';
          botNavBadge.style.background = 'rgba(255,255,255,0.06)';
          botNavBadge.style.color = 'var(--text-muted)';
        }
      }

      // Botão Iniciar/Pausar
      if (btnToggleText && btnToggleIcon) {
        if (data.isMonitoring) {
          btnToggleText.textContent = 'Pausar Moderação';
          btnToggleIcon.textContent = '⏸';
          btnToggleMonitoring.className = 'btn btn-secondary';
        } else {
          btnToggleText.textContent = 'Iniciar Moderação';
          btnToggleIcon.textContent = '▶';
          btnToggleMonitoring.className = 'btn btn-primary';
        }
      }

      // Detalhes da Live Ativa e Perfil da Criadora
      const botCreatorAvatarEl = document.getElementById('botCreatorAvatar');
      const botCreatorDisplayNameEl = document.getElementById('botCreatorDisplayName');
      const currentCreator = data.activeCreator || (data.activeLive ? { name: data.activeLive.creator_name, avatar: data.activeLive.thumbnail_url } : null);

      if (botCreatorAvatarEl && currentCreator) {
        if (currentCreator.avatar) {
          botCreatorAvatarEl.style.backgroundImage = `url('${currentCreator.avatar}')`;
          botCreatorAvatarEl.textContent = '';
        } else {
          botCreatorAvatarEl.style.backgroundImage = 'none';
          botCreatorAvatarEl.textContent = '👤';
        }
      }

      if (botCreatorDisplayNameEl && currentCreator) {
        const sharedTag = currentCreator.sharedId ? `(ID: ${currentCreator.sharedId})` : (currentCreator.userId ? `(ID: ${currentCreator.userId})` : '');
        botCreatorDisplayNameEl.textContent = `${currentCreator.name || 'Criadora'} ${sharedTag}`;
      }

      if (selectSavedCreator && currentCreator) {
        const activeId = String(currentCreator.sharedId || currentCreator.userId || '');
        if (activeId && selectSavedCreator.value !== activeId) {
          const hasOption = Array.from(selectSavedCreator.options).some(o => o.value === activeId);
          if (hasOption) {
            selectSavedCreator.value = activeId;
          }
        }
        if (btnDeleteCreator) {
          btnDeleteCreator.style.display = selectSavedCreator.value ? 'inline-flex' : 'none';
        }
      }

      if (liveBadgePill && liveBadgeText && liveInfoPreview) {
        if (data.activeLive && data.activeLive.livestream_id) {
          liveBadgePill.className = 'live-pill active';
          liveBadgeText.textContent = `LIVE AO VIVO (#${data.activeLive.livestream_id})`;
          liveInfoPreview.innerHTML = `
            <strong>${escapeHtml(data.activeLive.creator_name || 'Criadora')}</strong>: 
            👥 ${data.activeLive.viewer_count || 0} espectadores | 
            💎 ${(data.activeLive.live_diamonds || 0).toLocaleString()} diamantes | 
            Mod: <strong>${data.activeLive.is_modded ? 'AUTORIZADO' : 'AGUARDANDO MOD'}</strong>
          `;
        } else if (currentCreator) {
          liveBadgePill.className = data.isMonitoring ? 'live-pill active' : 'live-pill offline';
          liveBadgeText.textContent = data.isMonitoring ? 'MODO VIGILANTE ATIVO' : 'OFFLINE (VIGILANTE)';
          liveInfoPreview.innerHTML = `
            Criadora <strong>${escapeHtml(currentCreator.name || 'Criadora')}</strong> identificada. 
            <span style="color:${data.isMonitoring ? 'var(--success)' : 'var(--accent)'}; font-weight:700;">
              ${data.isMonitoring ? '● Robô ativo em Modo Vigilante — monitorando e pronto para entrar na live automaticamente!' : 'Robô pronto.'}
            </span>
          `;
        } else {
          liveBadgePill.className = 'live-pill offline';
          liveBadgeText.textContent = 'NENHUMA LIVE DETECTADA';
          liveInfoPreview.textContent = 'A criadora está offline ou a live ainda não foi iniciada.';
        }
      }

      // Atualiza Estatísticas
      if (data.stats) {
        if (statAnalyzed) statAnalyzed.textContent = (data.stats.messagesAnalyzed || 0).toLocaleString();
        if (statMutes) statMutes.textContent = (data.stats.usersMuted || 0).toLocaleString();
        if (statBans) statBans.textContent = (data.stats.usersBanned || 0).toLocaleString();
        if (statAnnouncements) statAnnouncements.textContent = (data.stats.announcementsSent || 0).toLocaleString();
        if (statDms) statDms.textContent = (data.stats.dmsSent || 0).toLocaleString();
      }

      // Countdown de Envio Recorrente
      if (countdownTimerText) {
        countdownTimerText.textContent = formatCountdown(data.countdownSeconds || 0);
      }
      if (statCountdownTrend) {
        statCountdownTrend.textContent = `Próximo envio em: ${formatCountdown(data.countdownSeconds || 0)}`;
      }

      // Sincroniza índice e mensagens da fila vindos do servidor
      if (data.config) {
        let queueNeedsRender = false;
        if (data.config.recurringCurrentIndex !== undefined && data.config.recurringCurrentIndex !== botConfig.recurringCurrentIndex) {
          botConfig.recurringCurrentIndex = data.config.recurringCurrentIndex;
          queueNeedsRender = true;
        }
        if (data.config.recurringMessages && Array.isArray(data.config.recurringMessages) && data.config.recurringMessages.length > 0) {
          if (JSON.stringify(data.config.recurringMessages) !== JSON.stringify(botConfig.recurringMessages)) {
            botConfig.recurringMessages = data.config.recurringMessages;
            queueNeedsRender = true;
          }
        }
        if (queueNeedsRender) {
          renderQueueList();
        }
      }

      // Renderiza Feed de Chat e Auditoria
      renderChatFeed(data.chatFeed || []);
      renderAuditLogs(data.recentLogs || []);

      // Renderiza Preview da Live e Chat no Canto
      renderCornerLiveWidget(data);
    } catch (e) {
      // Ignora pequenos soluços de rede no polling
    }
  }

  // --- Render Feed de Chat ao Vivo ---
  function renderChatFeed(feed) {
    if (!chatFeedContainer) return;
    if (feed.length === 0) {
      chatFeedContainer.innerHTML = '<div class="empty-feed-placeholder">Nenhuma mensagem no chat até o momento.</div>';
      return;
    }

    chatFeedContainer.innerHTML = '';
    feed.forEach((item) => {
      const card = document.createElement('div');
      card.className = 'chat-item-card';
      const displayName = item.name || item.user_name || (item.user_id ? `Usuário #${item.user_id}` : 'Anônimo');
      const displayTime = item.time || item.timestamp || '';
      const avatarHtml = item.picture_url 
        ? `<img src="${escapeHtml(item.picture_url)}" style="width:28px; height:28px; border-radius:50%; object-fit:cover; border:1px solid rgba(255,255,255,0.15);" alt="">`
        : `<div style="width:28px; height:28px; border-radius:50%; background:rgba(255,255,255,0.08); display:flex; align-items:center; justify-content:center; font-size:12px;">👤</div>`;

      card.innerHTML = `
        <div style="margin-right:10px; display:flex; align-items:center;">
          ${avatarHtml}
        </div>
        <div style="flex:1;">
          <div class="chat-item-author">
            <span style="color:var(--text-primary); font-weight:800;">${escapeHtml(displayName)}</span>
            <span class="badge-tag" style="font-size:9px; padding:1px 4px; background:rgba(255,255,255,0.06);">ID: ${item.user_id || '--'}</span>
            <span class="chat-item-time">${escapeHtml(displayTime)}</span>
          </div>
          <div class="chat-item-text">${escapeHtml(item.text || '')}</div>
        </div>
        <div style="display:flex; gap:4px; align-self:center;">
          <button class="btn-icon-xs btn-quick-mute" data-userid="${item.user_id || ''}" data-name="${escapeHtml(displayName)}" data-text="${escapeHtml(item.text || '')}" title="Silenciar usuário (Mute)">🔇</button>
          <button class="btn-icon-xs delete btn-quick-ban" data-userid="${item.user_id || ''}" data-name="${escapeHtml(displayName)}" data-text="${escapeHtml(item.text || '')}" title="Banir usuário (Kick)">🚫</button>
        </div>
      `;
      chatFeedContainer.appendChild(card);
    });
  }

  // --- Render Log de Auditoria ---
  function renderAuditLogs(logs) {
    if (!auditLogContainer) return;
    if (logs.length === 0) {
      auditLogContainer.innerHTML = '<div class="empty-feed-placeholder">Nenhuma ação registrada pelo robô no momento.</div>';
      return;
    }

    auditLogContainer.innerHTML = '';
    logs.forEach((log) => {
      const card = document.createElement('div');
      card.className = `audit-item-card ${log.type}`;

      let typeBadge = '';
      if (log.type === 'MUTE') typeBadge = '<span class="badge-tag warning-badge" style="font-size:10px;">SILENCIAMENTO</span>';
      else if (log.type === 'BAN') typeBadge = '<span class="badge-tag danger-badge" style="font-size:10px;">BANIMENTO</span>';
      else if (log.type === 'ANNOUNCEMENT') typeBadge = '<span class="badge-tag live-badge" style="font-size:10px;">AVISO RECORRENTE</span>';
      else if (log.type === 'DM') typeBadge = '<span class="badge-tag info-badge" style="font-size:10px;">DM PÓS-LIVE</span>';
      else typeBadge = `<span class="badge-tag" style="font-size:10px;">${log.type}</span>`;

      card.innerHTML = `
        <div class="audit-header-row">
          ${typeBadge}
          <span style="font-size:11px; font-family:var(--font-mono); color:var(--text-muted);">${escapeHtml(log.timestamp || '')}</span>
        </div>
        <div class="audit-desc">${escapeHtml(log.description || '')}</div>
        ${log.triggerWord ? `<div class="audit-trigger">Termo acionador: <code>"${escapeHtml(log.triggerWord)}"</code></div>` : ''}
      `;
      auditLogContainer.appendChild(card);
    });
  }

  // --- Escape HTML Auxiliar ---
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // --- Event Listeners ---

  // 1. Iniciar / Pausar Moderação
  if (btnToggleMonitoring) {
    btnToggleMonitoring.addEventListener('click', async () => {
      if (!botStatus.isMonitoring && !botStatus.isLoggedIn) {
        showToast('Conecte a conta do robô antes de iniciar a moderação.', 'warning');
        openLoginModal();
        return;
      }
      const endpoint = botStatus.isMonitoring ? '/api/bot/stop' : '/api/bot/start';
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ creatorUserId: inputCreatorUserId ? inputCreatorUserId.value.trim() : botConfig.creatorUserId })
        });
        const d = await res.json();
        if (d.success) {
          showToast(botStatus.isMonitoring ? 'Moderação pausada com sucesso.' : 'Robô conectado e monitorando live!', 'info');
          await syncBotStatus();
        } else {
          showToast(`Falha: ${d.error || 'Erro desconhecido'}`, 'danger');
        }
      } catch (e) {
        showToast(`Erro de comunicação: ${e.message}`, 'danger');
      }
    });
  }

  // 2. Salvar Regras
  if (btnSaveConfig) {
    btnSaveConfig.addEventListener('click', () => saveBotConfig(true));
  }

  // 2.1 Alternar Streamer Salva Rapidamente
  if (selectSavedCreator) {
    selectSavedCreator.addEventListener('change', async () => {
      const selectedId = selectSavedCreator.value;
      if (btnDeleteCreator) {
        btnDeleteCreator.style.display = selectedId ? 'inline-flex' : 'none';
      }
      if (!selectedId) return;

      if (inputCreatorUserId) {
        inputCreatorUserId.value = selectedId;
      }
      botConfig.creatorUserId = selectedId;

      showToast(`Alternando para streamer #${selectedId}...`, 'info', 2000);
      try {
        const res = await fetch('/api/bot/switch-creator', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ creatorUserId: selectedId })
        });
        const d = await res.json();
        if (d.success && d.creator) {
          showToast(`Streamer alternada: ${d.creator.name}! ${d.creator.isLive ? '🔴 Live Conectada!' : '🛡️ Modo Vigilante Ativo'}`, 'success', 4000);
        } else {
          showToast(`Aviso: ${d.error || 'Não foi possível obter dados imediatos'}`, 'warning');
        }
        await loadSavedCreators();
        await syncBotStatus();
      } catch (err) {
        showToast(`Erro ao alternar streamer: ${err.message}`, 'danger');
      }
    });
  }

  // 2.2 Excluir Streamer da Lista Salva
  if (btnDeleteCreator) {
    btnDeleteCreator.addEventListener('click', async () => {
      const selectedId = selectSavedCreator ? selectSavedCreator.value : '';
      if (!selectedId) return;

      const found = savedCreatorsList.find(c => String(c.sharedId) === String(selectedId) || String(c.userId) === String(selectedId));
      const streamerName = found ? found.name : `ID ${selectedId}`;

      if (confirm(`Deseja remover a streamer "${streamerName}" da sua lista rápida de salvas?`)) {
        try {
          const res = await fetch('/api/bot/creators', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: selectedId })
          });
          const d = await res.json();
          if (d.success) {
            showToast(`Streamer "${streamerName}" removida da lista.`, 'info');
            if (inputCreatorUserId && inputCreatorUserId.value === selectedId) {
              inputCreatorUserId.value = '';
            }
            await loadSavedCreators();
            await syncBotStatus();
          }
        } catch (e) {
          showToast(`Erro ao excluir streamer: ${e.message}`, 'danger');
        }
      }
    });
  }

  // 3. Conectar à Streamer / Detectar Live Ativa
  if (btnDetectLive) {
    btnDetectLive.addEventListener('click', async () => {
      const creatorId = inputCreatorUserId ? inputCreatorUserId.value.trim() : botConfig.creatorUserId;
      if (!creatorId) {
        showToast('Digite o ID, Shared ID ou Nome da streamer para conectar.', 'warning');
        return;
      }
      btnDetectLive.disabled = true;
      btnDetectLive.innerHTML = '<span>⏳ Conectando...</span>';
      try {
        const res = await fetch('/api/bot/switch-creator', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ creatorUserId: creatorId })
        });
        const d = await res.json();
        if (d.success && d.creator) {
          const info = d.creator;
          botConfig.creatorUserId = info.sharedId || info.userId || creatorId;
          if (inputCreatorUserId) inputCreatorUserId.value = info.sharedId || info.userId || creatorId;
          if (info.livestreamId) {
            botConfig.livestreamId = info.livestreamId;
          } else {
            botConfig.livestreamId = '';
          }
          saveBotConfig(false);

          if (info.isLive || info.liveFound || info.livestreamId) {
            showToast(`🔴 Live #${info.livestreamId || creatorId} de "${info.name}" detectada! Moderação iniciada!`, 'success', 5000);
          } else {
            showToast(`🛡️ Perfil de "${info.name}" (ID: ${info.sharedId || info.userId}) conectado! Modo Vigilante ATIVADO!`, 'success', 5000);
          }
        } else {
          showToast(d.error || 'Nenhum perfil ou live encontrado com o identificador informado.', 'danger');
        }
        await loadSavedCreators();
        await syncBotStatus();
      } catch (e) {
        showToast(`Erro ao conectar: ${e.message}`, 'danger');
      } finally {
        btnDetectLive.disabled = false;
        btnDetectLive.innerHTML = '<span>🔍 Conectar</span>';
      }
    });
  }

  // 3.1 Tecla Enter no campo de ID da streamer
  if (inputCreatorUserId && btnDetectLive) {
    inputCreatorUserId.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        btnDetectLive.click();
      }
    });
  }

  // 4. Adicionar Palavra Mute
  if (btnAddMuteWord && inputNewMuteWord) {
    const handleAddMute = () => {
      const word = inputNewMuteWord.value.trim();
      if (!word) return;
      if (!botConfig.muteWords.includes(word)) {
        botConfig.muteWords.push(word);
        renderMuteTags();
        inputNewMuteWord.value = '';
        saveBotConfig(false);
      }
    };
    btnAddMuteWord.addEventListener('click', handleAddMute);
    inputNewMuteWord.addEventListener('keypress', (e) => { if (e.key === 'Enter') handleAddMute(); });
  }

  // 5. Adicionar Palavra Ban
  if (btnAddBanWord && inputNewBanWord) {
    const handleAddBan = () => {
      const word = inputNewBanWord.value.trim();
      if (!word) return;
      if (!botConfig.banWords.includes(word)) {
        botConfig.banWords.push(word);
        renderBanTags();
        inputNewBanWord.value = '';
        saveBotConfig(false);
      }
    };
    btnAddBanWord.addEventListener('click', handleAddBan);
    inputNewBanWord.addEventListener('keypress', (e) => { if (e.key === 'Enter') handleAddBan(); });
  }

  // 6. Remover Tags (Mute / Ban)
  document.addEventListener('click', (e) => {
    if (e.target && e.target.classList.contains('tag-remove-btn')) {
      const type = e.target.getAttribute('data-type');
      const idx = parseInt(e.target.getAttribute('data-index'));
      if (type === 'mute' && !isNaN(idx)) {
        botConfig.muteWords.splice(idx, 1);
        renderMuteTags();
        saveBotConfig(false);
      } else if (type === 'ban' && !isNaN(idx)) {
        botConfig.banWords.splice(idx, 1);
        renderBanTags();
        saveBotConfig(false);
      }
    }
  });

  // 7. Adicionar Mensagem à Fila Recorrente
  if (btnAddQueueMsg && inputNewQueueMsg) {
    const handleAddQueue = () => {
      const msg = inputNewQueueMsg.value.trim();
      if (!msg) return;
      botConfig.recurringMessages.push(msg);
      renderQueueList();
      inputNewQueueMsg.value = '';
      saveBotConfig(false);
      showToast('Nova mensagem adicionada ao ciclo!', 'success');
    };
    btnAddQueueMsg.addEventListener('click', handleAddQueue);
    inputNewQueueMsg.addEventListener('keypress', (e) => { if (e.key === 'Enter') handleAddQueue(); });
  }

  // 8. Reordenar e Excluir Mensagens da Fila
  if (queueList) {
    queueList.addEventListener('click', (e) => {
      const target = e.target.closest('button');
      if (!target) return;
      const idx = parseInt(target.getAttribute('data-index'));
      if (isNaN(idx)) return;

      if (target.classList.contains('btn-queue-up') && idx > 0) {
        const item = botConfig.recurringMessages.splice(idx, 1)[0];
        botConfig.recurringMessages.splice(idx - 1, 0, item);
        renderQueueList();
        saveBotConfig(false);
      } else if (target.classList.contains('btn-queue-down') && idx < botConfig.recurringMessages.length - 1) {
        const item = botConfig.recurringMessages.splice(idx, 1)[0];
        botConfig.recurringMessages.splice(idx + 1, 0, item);
        renderQueueList();
        saveBotConfig(false);
      } else if (target.classList.contains('btn-queue-del')) {
        botConfig.recurringMessages.splice(idx, 1);
        renderQueueList();
        saveBotConfig(false);
        showToast('Mensagem removida da fila.', 'info');
      }
    });
  }

  // 8.1 Controles do Ciclo Recorrente
  if (toggleRecurring) {
    toggleRecurring.addEventListener('change', () => {
      botConfig.recurringEnabled = toggleRecurring.checked;
      saveBotConfig(false);
      showToast(toggleRecurring.checked ? 'Ciclo de avisos recorrentes ativado!' : 'Avisos recorrentes desativados.', 'info');
    });
  }

  if (selectRecurringInterval) {
    selectRecurringInterval.addEventListener('change', () => {
      botConfig.recurringIntervalSeconds = parseInt(selectRecurringInterval.value) || 120;
      saveBotConfig(false);
      showToast(`Intervalo de envio definido para ${selectRecurringInterval.options[selectRecurringInterval.selectedIndex].text}`, 'info');
    });
  }

  // 8.2 Disparo Manual de Teste da Próxima Mensagem Recorrente
  const btnTestRecurring = document.getElementById('btnTestRecurringNow');
  if (btnTestRecurring) {
    btnTestRecurring.addEventListener('click', async () => {
      btnTestRecurring.disabled = true;
      btnTestRecurring.innerHTML = '<span>⏳ Disparando...</span>';
      try {
        const liveId = botStatus.activeLive ? botStatus.activeLive.livestream_id : (botConfig.livestreamId || (inputCreatorUserId ? inputCreatorUserId.value.trim() : ''));
        const res = await fetch('/api/bot/test-recurring', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ livestreamId: liveId })
        });
        const d = await res.json();
        if (d.success) {
          showToast(`Aviso #${d.messageIndex} enviado no chat: "${d.sentMessage}"`, 'success');
        } else {
          showToast(`Erro ao disparar aviso: ${d.error || 'Erro na API'}`, 'danger');
        }
        await syncBotStatus();
      } catch (e) {
        showToast(`Erro de envio: ${e.message}`, 'danger');
      } finally {
        btnTestRecurring.disabled = false;
        btnTestRecurring.innerHTML = '<span>▶️ Disparar Mensagem Agora (Teste)</span>';
      }
    });
  }

  // 9. Template da DM - Inserção de Tags Variáveis
  document.querySelectorAll('.var-tag-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const varTag = btn.getAttribute('data-var');
      if (txtDmTemplate && varTag) {
        const start = txtDmTemplate.selectionStart || txtDmTemplate.value.length;
        const end = txtDmTemplate.selectionEnd || txtDmTemplate.value.length;
        const text = txtDmTemplate.value;
        txtDmTemplate.value = text.substring(0, start) + varTag + text.substring(end);
        txtDmTemplate.focus();
        updateDmPreview();
        saveBotConfig(false);
      }
    });
  });

  if (txtDmTemplate) {
    txtDmTemplate.addEventListener('input', () => {
      updateDmPreview();
      saveBotConfig(false);
    });
  }

  // 10. Enviar DM de Teste Agora
  if (btnTestDm) {
    btnTestDm.addEventListener('click', async () => {
      const creatorId = inputCreatorUserId ? inputCreatorUserId.value.trim() : botConfig.creatorUserId;
      btnTestDm.disabled = true;
      btnTestDm.innerHTML = '<span>⏳ Enviando DM...</span>';
      try {
        const res = await fetch('/api/bot/test-dm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            creatorUserId: creatorId,
            creatorName: 'Criadora',
            viewers: 142,
            diamonds: 2850,
            followers: 19,
            duration: '1h 45min'
          })
        });
        const d = await res.json();
        if (d.success) {
          showToast('DM de teste enviada com sucesso para a criadora!', 'success');
        } else {
          showToast(`Falha ao enviar DM: ${d.error || 'Erro desconhecido'}`, 'danger');
        }
        await syncBotStatus();
      } catch (e) {
        showToast(`Erro: ${e.message}`, 'danger');
      } finally {
        btnTestDm.disabled = false;
        btnTestDm.innerHTML = '<span>📩 Enviar DM de Teste Agora</span>';
      }
    });
  }

  // 11. Envio Manual de Mensagem no Chat Oficial
  if (btnSendManualChat && inputManualChat) {
    const handleSendChat = async () => {
      const text = inputManualChat.value.trim();
      if (!text) return;
      btnSendManualChat.disabled = true;
      try {
        const res = await fetch('/api/bot/test-chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, livestreamId: botStatus.activeLive ? botStatus.activeLive.livestream_id : '' })
        });
        const d = await res.json();
        if (d.success) {
          showToast('Mensagem enviada no chat oficial com sucesso!', 'success');
          inputManualChat.value = '';
          await syncBotStatus();
        } else {
          showToast(`Erro ao enviar no chat: ${d.error || 'Erro na API'}`, 'danger');
        }
      } catch (e) {
        showToast(`Erro de envio: ${e.message}`, 'danger');
      } finally {
        btnSendManualChat.disabled = false;
      }
    };
    btnSendManualChat.addEventListener('click', handleSendChat);
    inputManualChat.addEventListener('keypress', (e) => { if (e.key === 'Enter') handleSendChat(); });
  }

  // 12. Ações Rápidas Mute / Ban pelo Chat Feed
  if (chatFeedContainer) {
    chatFeedContainer.addEventListener('click', async (e) => {
      const btnMute = e.target.closest('.btn-quick-mute');
      const btnBan = e.target.closest('.btn-quick-ban');

      if (btnMute) {
        const uid = btnMute.getAttribute('data-userid');
        const name = btnMute.getAttribute('data-name');
        const text = btnMute.getAttribute('data-text');
        if (confirm(`Deseja silenciar (MUTE) o usuário ${name} (ID: ${uid})?`)) {
          await fetch('/api/bot/test-mute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: uid, userName: name, text })
          });
          showToast(`Comando de MUTE enviado para ${name}!`, 'warning');
          await syncBotStatus();
        }
      } else if (btnBan) {
        const uid = btnBan.getAttribute('data-userid');
        const name = btnBan.getAttribute('data-name');
        const text = btnBan.getAttribute('data-text');
        if (confirm(`Deseja banir (KICK) o usuário ${name} (ID: ${uid}) da transmissão?`)) {
          await fetch('/api/bot/test-kick', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: uid, userName: name, text })
          });
          showToast(`Comando de BAN enviado para ${name}!`, 'danger');
          await syncBotStatus();
        }
      }
    });
  }

  // 13. Limpar Logs de Auditoria
  if (btnClearLogs) {
    btnClearLogs.addEventListener('click', async () => {
      await fetch('/api/bot/clear-logs', { method: 'POST' });
      showToast('Logs de auditoria e histórico do chat limpos.', 'info');
      await syncBotStatus();
    });
  }

  // Inicia carregamento e sincronização
  loadBotConfig().then(() => syncBotStatus());

  // Loop de polling contínuo (a cada 2 segundos) para alimentar os consoles e métricas em tempo real
  if (!pollInterval) {
    pollInterval = setInterval(syncBotStatus, 2000);
  }

  // Loop de decremento contínuo segundo a segundo para contagem fluida e responsiva na tela
  setInterval(() => {
    if (botStatus && botStatus.isMonitoring && botConfig && botConfig.recurringEnabled) {
      if (botStatus.countdownSeconds > 0) {
        botStatus.countdownSeconds--;
      } else {
        botStatus.countdownSeconds = Number(botConfig.recurringIntervalSeconds) || 120;
      }
      if (countdownTimerText) {
        countdownTimerText.textContent = formatCountdown(botStatus.countdownSeconds);
      }
      if (statCountdownTrend) {
        statCountdownTrend.textContent = `Próximo envio em: ${formatCountdown(botStatus.countdownSeconds)}`;
      }
    } else if (!botStatus || !botStatus.isMonitoring) {
      const staticInterval = Number(botConfig ? botConfig.recurringIntervalSeconds : 120) || 120;
      if (countdownTimerText) {
        countdownTimerText.textContent = formatCountdown(staticInterval);
      }
    }
  }, 1000);
}

// =========================================================================
// 16. WIDGET FLUTUANTE DE PREVIEW DA LIVE E CHAT AO VIVO NO CANTINHO
// =========================================================================
// =========================================================================
// 16. WIDGET FLUTUANTE DE PREVIEW DA LIVE, PLAYER DE VÍDEO & CHAT AO VIVO
// =========================================================================
let videoCanvasAnimId = null;
let isAudioMonitorActive = false;
let audioContextInstance = null;

function initCornerLiveWidget() {
  const widget = document.getElementById('cornerLiveWidget');
  const btnMinimize = document.getElementById('btnMinimizeCorner');
  const btnClose = document.getElementById('btnCloseCorner');
  const btnToggle = document.getElementById('btnToggleCornerWidget');
  const inputChat = document.getElementById('cornerInputChat');
  const btnSendChat = document.getElementById('cornerBtnSendChat');
  const btnAudioToggle = document.getElementById('btnCornerAudioToggle');
  const btnRefreshPreview = document.getElementById('btnCornerRefreshPreview');

  // Inicializa o motor gráfico do canvas de vídeo
  initCornerVideoCanvas();

  if (btnMinimize && widget) {
    btnMinimize.addEventListener('click', () => {
      widget.classList.toggle('minimized');
      btnMinimize.textContent = widget.classList.contains('minimized') ? '□' : '_';
      btnMinimize.title = widget.classList.contains('minimized') ? 'Expandir Preview' : 'Minimizar';
    });
  }

  if (btnClose && widget) {
    btnClose.addEventListener('click', () => {
      widget.style.display = 'none';
      showToast('Preview no cantinho ocultado. Use o botão no menu para reabrir.', 'info');
    });
  }

  if (btnToggle && widget) {
    btnToggle.addEventListener('click', () => {
      widget.style.display = 'flex';
      widget.classList.remove('minimized');
      if (btnMinimize) btnMinimize.textContent = '_';
      widget.scrollIntoView({ behavior: 'smooth' });
    });
  }

  // Toggle do Monitor de Áudio
  if (btnAudioToggle) {
    btnAudioToggle.addEventListener('click', () => {
      isAudioMonitorActive = !isAudioMonitorActive;
      if (isAudioMonitorActive) {
        btnAudioToggle.textContent = '🔊';
        btnAudioToggle.style.borderColor = '#10b981';
        btnAudioToggle.style.color = '#10b981';
        showToast('Monitor de Áudio WebRTC ATIVADO', 'info', 2000);
        try {
          if (!audioContextInstance) {
            audioContextInstance = new (window.AudioContext || window.webkitAudioContext)();
          }
          if (audioContextInstance.state === 'suspended') {
            audioContextInstance.resume();
          }
          const osc = audioContextInstance.createOscillator();
          const gain = audioContextInstance.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(580, audioContextInstance.currentTime);
          gain.gain.setValueAtTime(0.04, audioContextInstance.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.0001, audioContextInstance.currentTime + 0.25);
          osc.connect(gain);
          gain.connect(audioContextInstance.destination);
          osc.start();
          osc.stop(audioContextInstance.currentTime + 0.3);
        } catch (e) {}
      } else {
        btnAudioToggle.textContent = '🔇';
        btnAudioToggle.style.borderColor = '';
        btnAudioToggle.style.color = '';
        showToast('Monitor de Áudio silenciado', 'info', 1800);
      }
    });
  }

  // Botão de Atualizar Sinal de Vídeo
  if (btnRefreshPreview) {
    btnRefreshPreview.addEventListener('click', async () => {
      btnRefreshPreview.innerHTML = '⏳';
      try {
        const creatorId = document.getElementById('botCreatorUserId')?.value?.trim();
        if (creatorId) {
          const res = await fetch('/api/bot/detect-live', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ creatorUserId: creatorId })
          });
          const d = await res.json();
          if (d.success && d.data) {
            showToast(`Sinal de vídeo sincronizado: ${d.data.name}`, 'success');
          }
        }
      } catch (e) {}
      setTimeout(() => { btnRefreshPreview.innerHTML = '🔄'; }, 500);
    });
  }

  // Envio rápido pelo mini chat do cantinho
  if (btnSendChat && inputChat) {
    const handleCornerSend = async () => {
      const text = inputChat.value.trim();
      if (!text) return;
      btnSendChat.disabled = true;
      try {
        const res = await fetch('/api/bot/test-chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text })
        });
        const d = await res.json();
        if (d.success) {
          inputChat.value = '';
          showToast('Mensagem enviada no chat da live!', 'success');
        } else {
          showToast(`Erro ao enviar: ${d.error || 'Erro'}`, 'danger');
        }
      } catch (e) {
        showToast(`Erro de envio: ${e.message}`, 'danger');
      } finally {
        btnSendChat.disabled = false;
      }
    };

    btnSendChat.addEventListener('click', handleCornerSend);
    inputChat.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') handleCornerSend();
    });
  }
}

// --- Motor Gráfico do Player de Vídeo no Canvas ---
function initCornerVideoCanvas() {
  const canvas = document.getElementById('cornerVideoCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const resize = () => {
    canvas.width = canvas.parentElement ? canvas.parentElement.clientWidth : 320;
    canvas.height = canvas.parentElement ? canvas.parentElement.clientHeight : 180;
  };
  resize();
  window.addEventListener('resize', resize);

  let frame = 0;
  function renderFrame() {
    frame++;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const isLive = document.getElementById('cornerLiveWidget')?.classList.contains('live-active');

    // 1. Scanlines leves para estética profissional de monitor de vídeo
    ctx.fillStyle = 'rgba(0, 0, 0, 0.1)';
    for (let y = 0; y < canvas.height; y += 3) {
      ctx.fillRect(0, y, canvas.width, 1);
    }

    if (isLive) {
      // 2. Ondas de Frequência do Stream de Áudio / Vídeo em Tempo Real
      const bars = 28;
      const barWidth = canvas.width / bars;
      for (let i = 0; i < bars; i++) {
        const h = Math.abs(Math.sin((frame * 0.08) + (i * 0.35))) * 22 + 4;
        const grad = ctx.createLinearGradient(0, canvas.height - h, 0, canvas.height);
        grad.addColorStop(0, 'rgba(99, 102, 241, 0.85)');
        grad.addColorStop(1, 'rgba(236, 72, 153, 0.25)');
        ctx.fillStyle = grad;
        ctx.fillRect(i * barWidth + 1, canvas.height - h, barWidth - 2, h);
      }

      // 3. Indicador de frame ao vivo
      const pulse = Math.abs(Math.sin(frame * 0.05));
      ctx.fillStyle = `rgba(239, 68, 68, ${0.15 + pulse * 0.25})`;
      ctx.beginPath();
      ctx.arc(canvas.width - 24, 20, 4 + pulse * 3, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Modo Standby / Vigilante: Radar de varredura buscando transmissão
      const sweepX = (frame * 1.8) % (canvas.width + 80) - 40;
      const grad = ctx.createLinearGradient(sweepX - 40, 0, sweepX + 40, 0);
      grad.addColorStop(0, 'rgba(99, 102, 241, 0)');
      grad.addColorStop(0.5, 'rgba(99, 102, 241, 0.18)');
      grad.addColorStop(1, 'rgba(99, 102, 241, 0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    videoCanvasAnimId = requestAnimationFrame(renderFrame);
  }

  if (videoCanvasAnimId) cancelAnimationFrame(videoCanvasAnimId);
  renderFrame();
}

function renderCornerLiveWidget(data) {
  const widget = document.getElementById('cornerLiveWidget');
  if (!widget) return;

  const headerDot = document.getElementById('cornerHeaderLiveDot');
  const headerTitle = document.getElementById('cornerHeaderTitle');
  const videoLivePill = document.getElementById('cornerVideoLivePill');
  const videoLiveText = document.getElementById('cornerVideoLiveText');
  const viewersBadge = document.getElementById('cornerVideoViewersBadge');
  const viewersCount = document.getElementById('cornerVideoViewersCount');
  const streamerAvatar = document.getElementById('cornerStreamerAvatar');
  const streamerName = document.getElementById('cornerStreamerName');
  const streamerTitle = document.getElementById('cornerStreamerTitle');
  const diamondsCount = document.getElementById('cornerDiamondsCount');
  const liveIdTag = document.getElementById('cornerLiveIdTag');
  const audioWaves = document.getElementById('cornerAudioWaves');
  const videoBg = document.getElementById('cornerVideoBg');
  const signalIndicator = document.getElementById('cornerSignalStatus');

  // Chat do Cantinho
  const chatMessagesContainer = document.getElementById('cornerChatMessages');
  const chatCount = document.getElementById('cornerChatCount');

  const activeCreator = data.activeCreator || null;
  const isLive = !!(data.activeLive && data.activeLive.livestream_id);

  // Perfil da Criadora (persistente no banco de dados!)
  const creatorPhoto = (data.activeLive && data.activeLive.thumbnail_url) 
    || (activeCreator ? activeCreator.avatar : '') 
    || '';
  const creatorNameStr = (data.activeLive && data.activeLive.creator_name) 
    || (activeCreator ? activeCreator.name : '') 
    || (data.config ? `Conta #${data.config.creatorUserId}` : 'Aguardando Perfil');
  const creatorSharedId = (activeCreator ? (activeCreator.sharedId || activeCreator.userId) : '') 
    || (data.config ? data.config.creatorUserId : '--');
  const creatorDiamonds = (data.activeLive ? data.activeLive.live_diamonds : (activeCreator ? activeCreator.diamonds : 0)) || 0;

  // Atualiza Foto de Fundo e Avatar com Glassmorphism
  if (creatorPhoto) {
    if (videoBg) videoBg.style.backgroundImage = `url('${creatorPhoto}')`;
    if (streamerAvatar) {
      streamerAvatar.style.backgroundImage = `url('${creatorPhoto}')`;
      streamerAvatar.textContent = '';
      streamerAvatar.classList.add('has-creator');
    }
  } else {
    if (videoBg) videoBg.style.backgroundImage = 'none';
    if (streamerAvatar) {
      streamerAvatar.style.backgroundImage = 'none';
      streamerAvatar.textContent = '👤';
      streamerAvatar.classList.remove('has-creator');
    }
  }

  if (streamerName) streamerName.textContent = creatorNameStr;
  if (diamondsCount) diamondsCount.textContent = creatorDiamonds.toLocaleString();
  if (liveIdTag) {
    liveIdTag.textContent = isLive 
      ? `LIVE #${data.activeLive.livestream_id}` 
      : (creatorSharedId !== '--' ? `ID: #${creatorSharedId}` : 'ID: --');
  }

  if (isLive) {
    widget.classList.add('live-active');
    if (headerDot) headerDot.className = 'live-dot-pulse';
    if (headerTitle) headerTitle.textContent = `LIVE AO VIVO (#${data.activeLive.livestream_id})`;
    if (videoLivePill) videoLivePill.className = 'live-pill active';
    if (videoLiveText) videoLiveText.textContent = 'AO VIVO';
    if (viewersBadge) viewersBadge.style.display = 'flex';
    if (viewersCount) viewersCount.textContent = (data.activeLive.viewer_count || 0).toLocaleString();
    if (streamerTitle) streamerTitle.textContent = data.activeLive.headline || 'Transmissão ao Vivo';
    if (audioWaves) audioWaves.style.display = 'flex';
    if (signalIndicator) signalIndicator.textContent = '🔴 SINAL AO VIVO';
  } else {
    widget.classList.remove('live-active');
    if (headerTitle) headerTitle.textContent = 'PREVIEW DA LIVE & CHAT';
    if (videoLivePill) videoLivePill.className = 'live-pill offline';
    if (videoLiveText) videoLiveText.textContent = data.isMonitoring ? 'VIGILANTE' : 'STANDBY';
    if (viewersBadge) viewersBadge.style.display = 'none';
    if (audioWaves) audioWaves.style.display = data.isMonitoring ? 'flex' : 'none';
    if (streamerTitle) {
      streamerTitle.textContent = data.isMonitoring 
        ? '🛰️ Modo Vigilante Ativo (Aguardando Live)' 
        : 'Inicie a transmissão no app SuperLive';
    }
    if (signalIndicator) signalIndicator.textContent = data.isMonitoring ? '🛰️ RTC VIGILANTE' : '⚪ STANDBY';
  }

  // Renderiza Chat no Cantinho
  if (chatMessagesContainer) {
    const feed = data.chatFeed || [];
    if (chatCount) chatCount.textContent = `${feed.length} msgs`;

    if (feed.length === 0) {
      chatMessagesContainer.innerHTML = '<div class="corner-chat-empty">O chat da live aparecerá aqui assim que você iniciar a transmissão.</div>';
    } else {
      // Inverte para exibir mensagens mais recentes embaixo
      const recentChat = [...feed].reverse().slice(-30);
      chatMessagesContainer.innerHTML = '';
      recentChat.forEach((msg) => {
        const item = document.createElement('div');
        item.className = 'corner-chat-item';
        const displayName = msg.name || msg.user_name || (msg.user_id ? `Usuário #${msg.user_id}` : 'Usuário');
        item.innerHTML = `
          <span class="corner-chat-user">${escapeHtml(displayName)}:</span>
          <span class="corner-chat-text">${escapeHtml(msg.text || '')}</span>
        `;
        chatMessagesContainer.appendChild(item);
      });
      // Scroll automático para a mensagem mais recente
      chatMessagesContainer.scrollTop = chatMessagesContainer.scrollHeight;
    }
  }
}

// --- 16. Console Central de Logs & Diagnóstico do Sistema ---
let systemLogsData = [];
let activeLogFilter = 'ALL';
let logSearchQuery = '';
let autoScrollLogs = true;

function initSystemLogsModule() {
  const searchInput = document.getElementById('syslogSearchInput');
  const chkAutoScroll = document.getElementById('chkAutoScrollLogs');
  const btnRefresh = document.getElementById('btnRefreshSystemLogs');
  const btnCopy = document.getElementById('btnCopySystemLogs');
  const btnDownload = document.getElementById('btnDownloadSystemLogs');
  const btnClear = document.getElementById('btnClearSystemLogs');
  const filterBtns = document.querySelectorAll('.syslog-filter-btn');

  // Relógio do terminal
  setInterval(() => {
    const clockEl = document.getElementById('syslogLiveClock');
    if (clockEl) clockEl.textContent = new Date().toLocaleTimeString('pt-BR');
  }, 1000);

  // Botões de Filtro
  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      filterBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeLogFilter = btn.getAttribute('data-filter') || 'ALL';
      renderSystemLogs();
    });
  });

  // Busca em tempo real
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      logSearchQuery = e.target.value.toLowerCase().trim();
      renderSystemLogs();
    });
  }

  // Toggle de auto-scroll
  if (chkAutoScroll) {
    chkAutoScroll.addEventListener('change', (e) => {
      autoScrollLogs = e.target.checked;
    });
  }

  // Ações
  if (btnRefresh) {
    btnRefresh.addEventListener('click', async () => {
      await fetchSystemLogs();
      showToast('Logs do sistema atualizados!', 'info', 1800);
    });
  }

  if (btnCopy) {
    btnCopy.addEventListener('click', () => {
      if (!systemLogsData || systemLogsData.length === 0) {
        showToast('Nenhum log para copiar.', 'warning');
        return;
      }
      const text = systemLogsData.map(l => `[${l.timestamp}] [${l.category}][${l.level}] ${l.message} ${l.details || ''}`).join('\n');
      navigator.clipboard.writeText(text).then(() => {
        showToast('Logs copiados para a área de transferência!', 'success');
      }).catch(() => {
        showToast('Erro ao copiar logs.', 'danger');
      });
    });
  }

  if (btnDownload) {
    btnDownload.addEventListener('click', () => {
      if (!systemLogsData || systemLogsData.length === 0) {
        showToast('Nenhum log para baixar.', 'warning');
        return;
      }
      const text = `=====================================================\nSUPER CLIENT — RELATÓRIO DE LOGS & DIAGNÓSTICO DO SISTEMA\nData de Exportação: ${new Date().toLocaleString('pt-BR')}\n=====================================================\n\n` +
        systemLogsData.map(l => `[${l.timestamp}] [${l.category}][${l.level}] ${l.message} ${l.details ? '\nDetalhes: ' + l.details : ''}`).join('\n');
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `superclient-logs-${Date.now()}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('Download do arquivo de logs iniciado!', 'success');
    });
  }

  if (btnClear) {
    btnClear.addEventListener('click', async () => {
      if (!confirm('Deseja realmente limpar o histórico de logs do servidor?')) return;
      try {
        await fetch('/api/bot/clear-system-logs', { method: 'POST' });
        await fetchSystemLogs();
        showToast('Logs do sistema limpos com sucesso.', 'info');
      } catch (e) {
        showToast(`Erro ao limpar logs: ${e.message}`, 'danger');
      }
    });
  }

  // Busca inicial e polling contínuo
  fetchSystemLogs();
  setInterval(fetchSystemLogs, 3000);
}

async function fetchSystemLogs() {
  try {
    const res = await fetch('/api/bot/system-logs');
    if (!res.ok) return;
    const data = await res.json();
    systemLogsData = data.logs || [];

    // Atualiza badges e métricas de diagnóstico
    const wsStatusEl = document.getElementById('syslogWsStatus');
    const wsDetailEl = document.getElementById('syslogWsDetail');
    const engineStatusEl = document.getElementById('syslogEngineStatus');
    const engineDetailEl = document.getElementById('syslogEngineDetail');
    const errorCountEl = document.getElementById('syslogErrorCount');
    const errorDetailEl = document.getElementById('syslogErrorDetail');
    const totalLogsEl = document.getElementById('syslogTotalLogs');
    const errorBadge = document.getElementById('errorCounterBadge');

    if (wsStatusEl) {
      if (data.wsConnected) {
        wsStatusEl.innerHTML = '<span class="live-dot-pulse" style="background:#10b981;"></span> ONLINE (WS)';
        wsStatusEl.style.color = 'var(--success)';
        if (wsDetailEl) wsDetailEl.textContent = 'WebSocket oficial conectado e ativo';
      } else if (data.dualSyncActive || (data.isMonitoring && data.activeLive)) {
        wsStatusEl.innerHTML = '<span class="live-dot-pulse" style="background:#10b981;"></span> ONLINE (DUAL-SYNC)';
        wsStatusEl.style.color = 'var(--success)';
        if (wsDetailEl) wsDetailEl.textContent = 'REST DualSync oficial ativo (captura e moderação contínua)';
      } else if (data.isMonitoring) {
        wsStatusEl.innerHTML = '<span class="live-dot-pulse" style="background:#6366f1;"></span> MODO VIGILANTE';
        wsStatusEl.style.color = 'var(--accent)';
        if (wsDetailEl) wsDetailEl.textContent = 'Vigilante ativo aguardando início da transmissão';
      } else {
        wsStatusEl.innerHTML = '<span style="color:var(--text-muted);">●</span> STANDBY (PRONTO)';
        wsStatusEl.style.color = 'var(--text-secondary)';
        if (wsDetailEl) wsDetailEl.textContent = 'Robô pronto para entrar na live.';
      }
    }

    if (engineStatusEl) {
      if (botStatus && botStatus.isMonitoring && botStatus.activeLive) {
        engineStatusEl.textContent = `LIVE #${botStatus.activeLive.livestream_id}`;
        engineStatusEl.style.color = 'var(--success)';
        if (engineDetailEl) engineDetailEl.textContent = `Criadora: ${botStatus.activeLive.creator_name || 'Ao Vivo'}`;
      } else if (botStatus && botStatus.isMonitoring) {
        engineStatusEl.textContent = 'VIGILANTE';
        engineStatusEl.style.color = 'var(--accent)';
        if (engineDetailEl) engineDetailEl.textContent = 'Aguardando abertura de live';
      } else {
        engineStatusEl.textContent = 'PRONTO';
        engineStatusEl.style.color = 'var(--text-secondary)';
        if (engineDetailEl) engineDetailEl.textContent = 'Aguardando comando Iniciar';
      }
    }

    const errorCount = data.errorCount !== undefined ? data.errorCount : systemLogsData.filter(l => l.level === 'ERROR').length;
    if (errorCountEl) {
      errorCountEl.textContent = errorCount;
      errorCountEl.style.color = errorCount > 0 ? '#ef4444' : 'var(--success)';
      if (errorDetailEl) errorDetailEl.textContent = errorCount > 0 ? `${errorCount} problema(s) reportado(s)` : 'Nenhum erro reportado';
    }

    if (errorBadge) {
      if (errorCount > 0) {
        errorBadge.textContent = errorCount;
        errorBadge.style.display = 'inline-block';
      } else {
        errorBadge.style.display = 'none';
      }
    }

    if (totalLogsEl) {
      totalLogsEl.textContent = systemLogsData.length;
    }

    renderSystemLogs();
  } catch (e) {
    // ignore
  }
}

function renderSystemLogs() {
  const container = document.getElementById('syslogTerminalBody');
  if (!container) return;

  let filtered = [...systemLogsData];

  // Filtro por categoria / nível
  if (activeLogFilter !== 'ALL') {
    if (activeLogFilter === 'ERROR') {
      filtered = filtered.filter(l => l.level === 'ERROR');
    } else if (activeLogFilter === 'WARN') {
      filtered = filtered.filter(l => l.level === 'WARN');
    } else {
      filtered = filtered.filter(l => l.category === activeLogFilter);
    }
  }

  // Filtro por texto de pesquisa
  if (logSearchQuery) {
    filtered = filtered.filter(l => 
      (l.message && l.message.toLowerCase().includes(logSearchQuery)) ||
      (l.category && l.category.toLowerCase().includes(logSearchQuery)) ||
      (l.details && l.details.toLowerCase().includes(logSearchQuery))
    );
  }

  if (filtered.length === 0) {
    container.innerHTML = '<div class="syslog-empty">Nenhum registro encontrado para os filtros selecionados.</div>';
    return;
  }

  container.innerHTML = '';
  filtered.forEach(item => {
    const line = document.createElement('div');
    const levelClass = item.level ? `level-${item.level.toLowerCase()}` : 'level-info';
    line.className = `syslog-line ${levelClass}`;

    let badgeClass = 'badge-info';
    if (item.level === 'ERROR') badgeClass = 'badge-error';
    else if (item.level === 'WARN') badgeClass = 'badge-warn';
    else if (item.level === 'SUCCESS') badgeClass = 'badge-success';
    else if (item.category === 'WS') badgeClass = 'badge-ws';
    else if (item.category === 'API') badgeClass = 'badge-api';
    else if (item.category === 'MOD') badgeClass = 'badge-mod';
    else if (item.category === 'QUEUE') badgeClass = 'badge-queue';
    else if (item.category === 'SYSTEM') badgeClass = 'badge-system';

    const hasDetails = item.details && item.details !== 'null' && item.details !== '{}';
    const detailId = `detail-${item.id}`;

    line.innerHTML = `
      <span class="syslog-time">[${item.timestamp}]</span>
      <span class="syslog-badge ${badgeClass}">${item.category}</span>
      <div class="syslog-message">
        <span>${escapeHtml(item.message)}</span>
        ${hasDetails ? `<span class="syslog-details-toggle" onclick="toggleSyslogDetails('${detailId}')">detalhes</span>` : ''}
        ${hasDetails ? `<div class="syslog-details-box" id="${detailId}" style="display:none;">${escapeHtml(item.details)}</div>` : ''}
      </div>
    `;

    container.appendChild(line);
  });

  if (autoScrollLogs) {
    container.scrollTop = 0; // Mais recente sempre visível no topo
  }
}

window.toggleSyslogDetails = function(id) {
  const el = document.getElementById(id);
  if (el) {
    el.style.display = el.style.display === 'none' ? 'block' : 'none';
  }
};


