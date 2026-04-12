import { authFetch, API_BASE, navigateTo } from './main.js';
import { escapeHtml } from './modules/utils.js';

// =============================================================================
// MÓDULO HOMEAI — FAB (Floating Action Button)
// =============================================================================
(function () {
  'use strict';

  // ── Estado local del FAB ────────────────────────────────────────────────
  const fabState = {
    open: false,
    aiStatus: null,       // null | 'checking' | 'active' | 'inactive' | 'not_installed'
    chatHistory: [],      // [{ role: 'user'|'assistant', content: string }]
    polling: null,
    sending: false
  };

  // ── Elementos DOM ────────────────────────────────────────────────────────
  const fab         = document.getElementById('homeai-fab');
  const panel       = document.getElementById('homeai-fab-panel');
  const badge       = document.getElementById('homeai-fab-badge');
  const messages    = document.getElementById('homeai-fp-messages');
  const input       = document.getElementById('homeai-fp-input');
  const sendBtn     = document.getElementById('homeai-fp-send');
  const closeBtn    = document.getElementById('homeai-fp-close');
  const clearBtn    = document.getElementById('homeai-fp-clear');
  const fullscBtn   = document.getElementById('homeai-fp-fullscreen');
  const subtitle    = document.getElementById('homeai-fp-subtitle');
  const overlayNI   = document.getElementById('homeai-fp-overlay-notinstalled');
  const gotoInstall = document.getElementById('homeai-fp-goto-install');

  if (!fab) return; // Guard: si el HTML no está en la página, salir

  // ── Helpers ──────────────────────────────────────────────────────────────
  function setBadge(state) {
    badge.style.display = 'block';
    badge.className = 'homeai-fab-badge';
    if (state === 'active')       badge.classList.add('homeai-fab-badge--online');
    else if (state === 'offline') badge.classList.add('homeai-fab-badge--offline');
    else if (state === 'loading') badge.classList.add('homeai-fab-badge--loading');
    else badge.style.display = 'none';
  }

  function setSubtitle(text) {
    if (subtitle) subtitle.textContent = text;
  }

  // Formateador de respuestas Markdown básico
  function formatAIResponse(raw) {
    // escapeHtml está disponible globalmente en main.js
    let s = (typeof escapeHtml === 'function') ? escapeHtml(raw) : raw.replace(/</g,'&lt;').replace(/>/g,'&gt;');
    s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, __, code) => `<pre><code>${code.trim()}</code></pre>`);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\n\n/g, '<br><br>').replace(/\n/g, '<br>');
    return s;
  }

  // ── Comprobar estado de HomeAI ───────────────────────────────────────────
  async function checkStatus() {
    setBadge('loading');
    setSubtitle('Comprobando...');
    try {
      // authFetch es la función de autenticación global de main.js
      const fetchFn = (typeof authFetch === 'function') ? authFetch : fetch;
      const res = await fetchFn(`${API_BASE}/homeai/status`);
      if (!res.ok) throw new Error('no_api');
      const data = await res.json();

      if (!data.installed) {
        fabState.aiStatus = 'not_installed';
        setBadge('offline');
        setSubtitle('No instalado');
        overlayNI.style.display = 'flex';
        input.disabled = true;
        sendBtn.disabled = true;
      } else if (data.running && data.modelLoaded) {
        fabState.aiStatus = 'active';
        setBadge('active');
        setSubtitle('Listo • qwen2.5-coder:3b');
        overlayNI.style.display = 'none';
        input.disabled = false;
        sendBtn.disabled = false;
        fab.classList.add('homeai-fab--active');
      } else {
        fabState.aiStatus = 'inactive';
        setBadge('offline');
        setSubtitle('Servicio detenido');
        overlayNI.style.display = 'none';
        input.disabled = true;
        sendBtn.disabled = true;
      }
    } catch (e) {
      // API no disponible (módulo no instalado aún)
      fabState.aiStatus = 'not_installed';
      setBadge('offline');
      setSubtitle('No instalado');
      overlayNI.style.display = 'flex';
      input.disabled = true;
      sendBtn.disabled = true;
    }
  }

  // ── Abrir / cerrar panel ────────────────────────────────────────────────
  function openPanel() {
    fabState.open = true;
    panel.classList.add('homeai-fab-panel--open');
    panel.setAttribute('aria-hidden', 'false');
    fab.setAttribute('aria-expanded', 'true');

    // Mostrar bienvenida si no hay historial
    if (fabState.chatHistory.length === 0) {
      messages.innerHTML = `
        <div class="homeai-fp-welcome">
          <strong>¡Hola! Soy HomeAI 🤖</strong>
          Tu asistente SysAdmin local. Corro 100% en tu CM5, sin enviar nada a internet.<br><br>
          Puedo ayudarte con configuraciones avanzadas, docker-compose, scripts y troubleshooting.
        </div>`;
    }

    checkStatus();
    if (input && !input.disabled) setTimeout(() => input.focus(), 250);
  }

  function closePanel() {
    fabState.open = false;
    panel.classList.remove('homeai-fab-panel--open');
    panel.setAttribute('aria-hidden', 'true');
    fab.setAttribute('aria-expanded', 'false');
  }

  // ── Toggle ───────────────────────────────────────────────────────────────
  fab.addEventListener('click', () => {
    fabState.open ? closePanel() : openPanel();
  });

  closeBtn.addEventListener('click', closePanel);

  // Cerrar con Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && fabState.open) closePanel();
  });

  // Cerrar al hacer clic fuera del panel
  document.addEventListener('click', (e) => {
    if (fabState.open && !panel.contains(e.target) && e.target !== fab && !fab.contains(e.target)) {
      closePanel();
    }
  });

  // ── Limpiar chat ─────────────────────────────────────────────────────────
  clearBtn.addEventListener('click', () => {
    fabState.chatHistory = [];
    messages.innerHTML = `
      <div class="homeai-fp-welcome">
        <strong>Chat limpiado ✨</strong>
        ¿En qué puedo ayudarte?
      </div>`;
  });

  // ── Abrir en pantalla completa (navegar a la vista HomeAI) ───────────────
  fullscBtn.addEventListener('click', () => {
    closePanel();
    // navigateTo es la función de routing de main.js
    if (typeof navigateTo === 'function') navigateTo('homeai');
    else if (typeof renderHomeAIView === 'function') renderHomeAIView();
    else window.location.hash = '#homeai';
  });

  // ── Ir a instalar ────────────────────────────────────────────────────────
  if (gotoInstall) {
    gotoInstall.addEventListener('click', () => {
      closePanel();
      if (typeof navigateTo === 'function') navigateTo('homeai');
      else window.location.hash = '#homeai';
    });
  }

  // ── Auto-resize del textarea ─────────────────────────────────────────────
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 90) + 'px';
  });

  // Enter para enviar (Shift+Enter = salto de línea)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!sendBtn.disabled) sendMessage();
    }
  });

  sendBtn.addEventListener('click', sendMessage);

  // ── Enviar mensaje ───────────────────────────────────────────────────────
  async function sendMessage() {
    if (fabState.sending) return;
    const text = input.value.trim();
    if (!text) return;

    fabState.sending = true;
    input.disabled = true;
    sendBtn.disabled = true;
    input.value = '';
    input.style.height = 'auto';

    // Quitar bienvenida si existía
    const welcome = messages.querySelector('.homeai-fp-welcome');
    if (welcome) welcome.remove();

    // Burbuja usuario
    fabState.chatHistory.push({ role: 'user', content: text });
    appendMessage('user', text);

    // Burbuja "pensando"
    const thinkingEl = appendThinking();

    try {
      const fetchFn = (typeof authFetch === 'function') ? authFetch : fetch;
      const res = await fetchFn(`${API_BASE}/homeai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: fabState.chatHistory, stream: false })
      });

      thinkingEl.remove();

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      const data = await res.json();
      const aiText = data.message?.content || data.choices?.[0]?.message?.content || '…';

      fabState.chatHistory.push({ role: 'assistant', content: aiText });
      appendMessage('ai', aiText);

    } catch (e) {
      thinkingEl.remove();
      appendError(`No pude conectar con HomeAI: ${e.message}`);
    } finally {
      fabState.sending = false;
      input.disabled = false;
      sendBtn.disabled = false;
      input.focus();
    }
  }

  function appendMessage(role, content) {
    const isUser = role === 'user';
    const div = document.createElement('div');
    div.className = `homeai-fp-msg homeai-fp-msg--${isUser ? 'user' : 'ai'}`;

    if (!isUser) {
      const avatar = document.createElement('div');
      avatar.className = 'homeai-fp-avatar';
      avatar.textContent = 'AI';
      div.appendChild(avatar);
    }

    const bubble = document.createElement('div');
    bubble.className = 'homeai-fp-bubble';
    if (isUser) {
      const s = (typeof escapeHtml === 'function') ? escapeHtml(content) : content;
      bubble.innerHTML = s.replace(/\n/g, '<br>');
    } else {
      bubble.innerHTML = formatAIResponse(content);
    }

    div.appendChild(bubble);
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
    return div;
  }

  function appendThinking() {
    const div = document.createElement('div');
    div.className = 'homeai-fp-msg homeai-fp-msg--ai homeai-fp-thinking';
    div.innerHTML = `
      <div class="homeai-fp-avatar">AI</div>
      <div class="homeai-fp-bubble">
        <div class="homeai-fp-dots"><span></span><span></span><span></span></div>
      </div>`;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
    return div;
  }

  function appendError(msg) {
    const div = document.createElement('div');
    div.style.cssText = 'font-size:0.78rem;color:#ef4444;padding:4px 8px;text-align:center;';
    div.textContent = `⚠️ ${msg}`;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
  }

  // ── Comprobar estado al cargar (con retardo para no bloquear init) ───────
  setTimeout(checkStatus, 2500);

})();
