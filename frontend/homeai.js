import { authFetch, API_BASE, showNotification } from './main.js';
import { escapeHtml } from './modules/utils.js';

// =============================================================================
// MÓDULO HOMEAI
// =============================================================================

// ─── ESTADO LOCAL DEL CHAT (persiste durante la sesión) ────────────────────
let homeaiChatHistory = [];
let homeaiPollingTimer = null;

// ─── FUNCIÓN PRINCIPAL ──────────────────────────────────────────────────────
async function renderHomeAIView() {
    const content = document.getElementById('dashboard-content');
    content.innerHTML = `<div class="loading-spinner"><div class="spinner"></div><p>Cargando HomeAI...</p></div>`;

    // Cancelar cualquier polling anterior
    if (homeaiPollingTimer) {
        clearTimeout(homeaiPollingTimer);
        homeaiPollingTimer = null;
    }

    let status = { installed: false, running: false, modelLoaded: false, installState: null, uninstallState: null, nvmePath: '/mnt/nvme0' };
    try {
        const res = await authFetch(`${API_BASE}/homeai/status`);
        if (res.ok) {
            const data = await res.json();
            if (data.success) status = { ...status, ...data };
        }
    } catch (e) {
        console.error('[HomeAI] Error al obtener estado:', e);
    }

    // Si hay una instalación/desinstalación en curso, ir directo a ese estado
    if (status.installState && status.installState.running) {
        renderHomeAIInstalling(status.installState);
        startHomeAIInstallPolling();
        return;
    }
    if (status.uninstallState && status.uninstallState.running) {
        renderHomeAIUninstalling(status.uninstallState);
        startHomeAIUninstallPolling();
        return;
    }

    if (!status.installed) {
        renderHomeAINotInstalled(status.nvmePath);
    } else if (status.installed && status.running && status.modelLoaded) {
        renderHomeAIActive(status);
    } else {
        // Instalado pero servicio detenido o modelo no cargado
        renderHomeAIInactive(status);
    }
}

// ─── ESTADO: NO INSTALADO ───────────────────────────────────────────────────
function renderHomeAINotInstalled(defaultNvmePath) {
    const content = document.getElementById('dashboard-content');
    content.innerHTML = `
        <div class="section-header">
            <h2>🤖 HomeAI</h2>
            <p class="section-subtitle">Asistente de IA local integrado en HomeNasOS</p>
        </div>

        <div class="glass-card homeai-card">
            <div class="homeai-header">
                <div class="homeai-status-badge homeai-badge-inactive">⚫ No instalado</div>
            </div>

            <div class="homeai-requirements">
                <h3>📋 Requisitos previos</h3>
                <ul>
                    <li>✅ <strong>Disco M.2 NVMe obligatorio</strong> — mínimo 8 GB libres (protege la eMMC del sistema)</li>
                    <li>✅ <strong>Conexión a internet</strong> — para descargar el modelo base</li>
                    <li>✅ <strong>~1.5 GB de descarga</strong> — modelo <code>gemma2:2b</code> optimizado para ARM64</li>
                    <li>✅ <strong>Sin Docker</strong> — se instala nativamente vía <code>systemd</code>, sin ensuciar el panel de contenedores</li>
                </ul>
                <div class="homeai-info-box">
                    <strong>🔒 Privacidad total:</strong> El modelo corre 100% en local en tu CM5.
                    Ningún mensaje sale de tu red.
                </div>
            </div>

            <div class="homeai-nvme-row">
                <label for="homeai-nvme-path"><strong>📁 Ruta de almacenamiento (NVMe):</strong></label>
                <div class="homeai-nvme-input-group">
                    <input
                        type="text"
                        id="homeai-nvme-path"
                        class="homeai-nvme-input"
                        value="${escapeHtml(defaultNvmePath)}"
                        placeholder="/mnt/nvme0"
                    />
                    <span class="homeai-nvme-suffix">/homenasos_ai</span>
                </div>
                <small class="homeai-hint">Los modelos se guardarán en esta ruta. Debe ser un punto de montaje NVMe.</small>
            </div>

            <div class="homeai-actions">
                <button id="homeai-install-btn" class="btn-primary homeai-btn-install">
                    🚀 Instalar HomeAI
                </button>
            </div>
        </div>
    `;

    document.getElementById('homeai-install-btn').addEventListener('click', async () => {
        const nvmePath = document.getElementById('homeai-nvme-path').value.trim() || '/mnt/nvme0';
        if (!nvmePath.startsWith('/')) {
            showNotification('La ruta NVMe debe ser una ruta absoluta (ej: /mnt/nvme0)', 'error');
            return;
        }

        const btn = document.getElementById('homeai-install-btn');
        btn.disabled = true;
        btn.textContent = '⏳ Iniciando instalación...';

        try {
            const res = await authFetch(`${API_BASE}/homeai/install`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nvmePath })
            });
            const data = await res.json();
            if (!res.ok || !data.success) throw new Error(data.error || 'Error iniciando instalación');

            renderHomeAIInstalling({ progress: 0, step: 'Iniciando...', running: true });
            setTimeout(() => startHomeAIInstallPolling(), 1500);
        } catch (e) {
            showNotification(`Error: ${e.message}`, 'error');
            btn.disabled = false;
            btn.textContent = '🚀 Instalar HomeAI';
        }
    });
}

// ─── ESTADO: INSTALANDO ──────────────────────────────────────────────────────
function renderHomeAIInstalling(state) {
    const content = document.getElementById('dashboard-content');
    const progress = state.progress || 0;
    const step = escapeHtml(state.step || 'Preparando...');

    content.innerHTML = `
        <div class="section-header">
            <h2>🤖 HomeAI</h2>
            <p class="section-subtitle">Instalación en progreso</p>
        </div>

        <div class="glass-card homeai-card">
            <div class="homeai-header">
                <div class="homeai-status-badge homeai-badge-installing">⏳ Instalando...</div>
            </div>

            <div class="homeai-progress-section">
                <div class="homeai-progress-label">
                    <span id="homeai-step-text">${step}</span>
                    <span id="homeai-progress-pct">${progress}%</span>
                </div>
                <div class="homeai-progress-bar">
                    <div class="homeai-progress-fill" id="homeai-progress-fill" style="width: ${progress}%"></div>
                </div>
            </div>

            <div class="homeai-log-box" id="homeai-log-box">
                <div class="homeai-log-line">▶ Iniciando instalación nativa de Ollama para ARM64...</div>
            </div>

            <small class="homeai-hint" style="margin-top: 1rem; display:block;">
                ⚠️ La descarga del modelo puede tardar varios minutos dependiendo de tu conexión.
                No cierres esta pestaña.
            </small>
        </div>
    `;
}

function updateHomeAIInstallingUI(state) {
    const pct = document.getElementById('homeai-progress-pct');
    const step = document.getElementById('homeai-step-text');
    const fill = document.getElementById('homeai-progress-fill');
    const log = document.getElementById('homeai-log-box');

    if (pct) pct.textContent = `${state.progress || 0}%`;
    if (step) step.textContent = state.step || '';
    if (fill) fill.style.width = `${state.progress || 0}%`;
    if (log && state.step) {
        const line = document.createElement('div');
        line.className = 'homeai-log-line';
        line.textContent = `▶ ${state.step}`;
        log.appendChild(line);
        log.scrollTop = log.scrollHeight;
    }
}

function startHomeAIInstallPolling() {
    const poll = async () => {
        try {
            const res = await authFetch(`${API_BASE}/homeai/install/progress`);
            const state = await res.json();

            // Actualizar UI si seguimos en la vista de instalación
            if (document.getElementById('homeai-progress-fill')) {
                updateHomeAIInstallingUI(state);
            }

            if (state.completed) {
                showNotification('✅ HomeAI instalado correctamente. ¡Ya puedes usarlo!', 'success');
                homeaiChatHistory = [];
                await renderHomeAIView();
                return;
            }

            if (state.error) {
                showNotification(`❌ Error en la instalación: ${state.error}`, 'error');
                await renderHomeAIView();
                return;
            }

            if (state.running) {
                homeaiPollingTimer = setTimeout(poll, 2000);
            }
        } catch (e) {
            console.error('[HomeAI] Error en polling:', e);
            homeaiPollingTimer = setTimeout(poll, 3000);
        }
    };
    poll();
}

// ─── ESTADO: DESINSTALANDO ───────────────────────────────────────────────────
function renderHomeAIUninstalling(state) {
    const content = document.getElementById('dashboard-content');
    const progress = state.progress || 0;
    content.innerHTML = `
        <div class="section-header">
            <h2>🤖 HomeAI</h2>
            <p class="section-subtitle">Desinstalación en progreso</p>
        </div>
        <div class="glass-card homeai-card">
            <div class="homeai-header">
                <div class="homeai-status-badge homeai-badge-installing">🗑️ Desinstalando...</div>
            </div>
            <div class="homeai-progress-section">
                <div class="homeai-progress-label">
                    <span id="homeai-step-text">${escapeHtml(state.step || 'Preparando...')}</span>
                    <span id="homeai-progress-pct">${progress}%</span>
                </div>
                <div class="homeai-progress-bar">
                    <div class="homeai-progress-fill" id="homeai-progress-fill" style="width: ${progress}%"></div>
                </div>
            </div>
            <div class="homeai-log-box" id="homeai-log-box">
                <div class="homeai-log-line">▶ Iniciando proceso de desinstalación...</div>
            </div>
        </div>
    `;
}

function startHomeAIUninstallPolling() {
    const poll = async () => {
        try {
            const res = await authFetch(`${API_BASE}/homeai/uninstall/progress`);
            const state = await res.json();

            if (document.getElementById('homeai-progress-fill')) {
                updateHomeAIInstallingUI(state);
            }

            if (state.completed) {
                showNotification('✅ HomeAI desinstalado. Espacio NVMe liberado.', 'success');
                homeaiChatHistory = [];
                await renderHomeAIView();
                return;
            }

            if (state.error) {
                showNotification(`❌ Error en la desinstalación: ${state.error}`, 'error');
                await renderHomeAIView();
                return;
            }

            if (state.running) {
                homeaiPollingTimer = setTimeout(poll, 2000);
            }
        } catch (e) {
            homeaiPollingTimer = setTimeout(poll, 3000);
        }
    };
    poll();
}

// ─── ESTADO: ACTIVO (chat) ───────────────────────────────────────────────────
function renderHomeAIActive(status = {}) {
    const content = document.getElementById('dashboard-content');

    // Reconstruir historial de chat previo
    const historyHtml = homeaiChatHistory.map(msg => {
        if (msg.role === 'user') {
            return `<div class="homeai-message homeai-message-user"><span>${escapeHtml(msg.content)}</span></div>`;
        } else {
            return `<div class="homeai-message homeai-message-ai"><span>🤖</span><div>${escapeHtml(msg.content)}</div></div>`;
        }
    }).join('');

    content.innerHTML = `
        <div class="section-header">
            <h2>🤖 HomeAI</h2>
            <p class="section-subtitle">Asistente SysAdmin local — 100% privado, corre en tu CM5</p>
        </div>

        <div class="glass-card homeai-card homeai-card-active">
            <div class="homeai-header">
                <div class="homeai-status-badge homeai-badge-active">🟢 Activo — ${escapeHtml(status.modelName || 'HomeAI')}</div>
                <div class="homeai-header-actions">
                    <button id="homeai-clear-btn" class="btn-secondary homeai-btn-sm" title="Borrar historial de chat">
                        🗑️ Limpiar chat
                    </button>
                    <button id="homeai-uninstall-btn" class="btn-danger homeai-btn-sm">
                        Desinstalar
                    </button>
                </div>
            </div>

            <div class="homeai-chat-container">
                <div class="homeai-chat-messages" id="homeai-chat-messages">
                    ${historyHtml || `
                        <div class="homeai-welcome">
                            <p>👋 Hola, soy <strong>HomeAI</strong>. Corro localmente en tu CM5.</p>
                            <p>Puedo ayudarte con configuraciones avanzadas, generar <code>docker-compose.yml</code> para nuevos servicios,
                            depurar errores del sistema o crear scripts personalizados para el Scheduler.</p>
                            <p>¿En qué puedo ayudarte?</p>
                        </div>
                    `}
                </div>
            </div>

            <div class="homeai-chat-input-row">
                <textarea
                    id="homeai-input"
                    class="homeai-input"
                    placeholder="Escribe tu pregunta... (Enter para enviar, Shift+Enter para nueva línea)"
                    rows="2"
                ></textarea>
                <button id="homeai-send-btn" class="homeai-send-btn">
                    ➤
                </button>
            </div>
        </div>
    `;

    // Auto-scroll al final del historial
    const messagesEl = document.getElementById('homeai-chat-messages');
    messagesEl.scrollTop = messagesEl.scrollHeight;

    // Enviar mensaje con Enter (Shift+Enter = salto de línea)
    const input = document.getElementById('homeai-input');
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            document.getElementById('homeai-send-btn').click();
        }
    });

    // Botón enviar
    document.getElementById('homeai-send-btn').addEventListener('click', () => sendHomeAIMessage());

    // Limpiar chat
    document.getElementById('homeai-clear-btn').addEventListener('click', () => {
        homeaiChatHistory = [];
        renderHomeAIActive();
    });

    // Desinstalar
    document.getElementById('homeai-uninstall-btn').addEventListener('click', async () => {
        const ok = confirm('¿Desinstalar HomeAI? Se eliminarán los binarios de Ollama y los modelos del NVMe.');
        if (!ok) return;

        try {
            const res = await authFetch(`${API_BASE}/homeai/uninstall`, { method: 'POST' });
            const data = await res.json();
            if (!res.ok || !data.success) throw new Error(data.error || 'Error al iniciar desinstalación');

            renderHomeAIUninstalling({ progress: 0, step: 'Iniciando...', running: true });
            setTimeout(() => startHomeAIUninstallPolling(), 1000);
        } catch (e) {
            showNotification(`Error: ${e.message}`, 'error');
        }
    });

    // Focus en el input
    input.focus();
}

// ─── ESTADO: INACTIVO (instalado pero servicio detenido) ────────────────────
function renderHomeAIInactive(status) {
    const content = document.getElementById('dashboard-content');
    content.innerHTML = `
        <div class="section-header">
            <h2>🤖 HomeAI</h2>
        </div>
        <div class="glass-card homeai-card">
            <div class="homeai-header">
                <div class="homeai-status-badge homeai-badge-inactive">🟡 Instalado — Servicio detenido</div>
            </div>
            <p>Ollama está instalado pero el servicio no está activo o el modelo no está cargado.</p>
            <div class="homeai-actions">
                <button id="homeai-start-btn" class="btn-primary">▶ Iniciar servicio</button>
                <button id="homeai-uninstall-btn" class="btn-danger">Desinstalar</button>
            </div>
        </div>
    `;

    document.getElementById('homeai-start-btn').addEventListener('click', async () => {
        try {
            const res = await authFetch(`${API_BASE}/homeai/start`, { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                showNotification('Servicio iniciado', 'success');
                await renderHomeAIView();
            } else {
                showNotification(data.error || 'Error al iniciar', 'error');
            }
        } catch (e) {
            showNotification(e.message, 'error');
        }
    });

    document.getElementById('homeai-uninstall-btn').addEventListener('click', async () => {
        const ok = confirm('¿Desinstalar HomeAI? Se eliminarán los modelos del NVMe.');
        if (!ok) return;
        try {
            await authFetch(`${API_BASE}/homeai/uninstall`, { method: 'POST' });
            renderHomeAIUninstalling({ progress: 0, step: 'Iniciando...', running: true });
            setTimeout(() => startHomeAIUninstallPolling(), 1000);
        } catch (e) {
            showNotification(e.message, 'error');
        }
    });
}

// ─── ENVIAR MENSAJE AL CHAT ──────────────────────────────────────────────────
async function sendHomeAIMessage() {
    const input = document.getElementById('homeai-input');
    const sendBtn = document.getElementById('homeai-send-btn');
    const messagesEl = document.getElementById('homeai-chat-messages');

    const text = input.value.trim();
    if (!text) return;

    // Añadir mensaje del usuario al historial y UI
    homeaiChatHistory.push({ role: 'user', content: text });
    const userMsg = document.createElement('div');
    userMsg.className = 'homeai-message homeai-message-user';
    userMsg.innerHTML = `<span>${escapeHtml(text)}</span>`;
    messagesEl.appendChild(userMsg);

    // Placeholder "pensando..."
    const thinkingEl = document.createElement('div');
    thinkingEl.className = 'homeai-message homeai-message-ai homeai-thinking';
    thinkingEl.innerHTML = `<span>🤖</span><div class="homeai-dots"><span></span><span></span><span></span></div>`;
    messagesEl.appendChild(thinkingEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    input.value = '';
    input.disabled = true;
    sendBtn.disabled = true;

    try {
        const res = await authFetch(`${API_BASE}/homeai/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: homeaiChatHistory, stream: false })
        });

        const data = await res.json();

        // Quitar "pensando..."
        thinkingEl.remove();

        if (!res.ok) throw new Error(data.error || 'Error en la respuesta');

        // Extraer contenido de la respuesta de Ollama
        const aiContent = data.message?.content || data.choices?.[0]?.message?.content || 'Sin respuesta';

        homeaiChatHistory.push({ role: 'assistant', content: aiContent });

        const aiMsg = document.createElement('div');
        aiMsg.className = 'homeai-message homeai-message-ai';
        // Renderizar markdown básico: bloques de código, negrita
        aiMsg.innerHTML = `<span>🤖</span><div>${homeaiFormatResponse(aiContent)}</div>`;
        messagesEl.appendChild(aiMsg);
        messagesEl.scrollTop = messagesEl.scrollHeight;

    } catch (e) {
        thinkingEl.remove();
        const errMsg = document.createElement('div');
        errMsg.className = 'homeai-message homeai-message-error';
        errMsg.textContent = `❌ Error: ${e.message}`;
        messagesEl.appendChild(errMsg);
        showNotification(`HomeAI no respondió: ${e.message}`, 'error');
    } finally {
        input.disabled = false;
        sendBtn.disabled = false;
        input.focus();
    }
}

// ─── FORMATEADOR DE RESPUESTAS (markdown básico) ────────────────────────────
function homeaiFormatResponse(text) {
    // Escapar HTML primero
    let safe = escapeHtml(text);

    // Bloques de código ```...```
    safe = safe.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
        return `<pre class="homeai-code-block"><code>${code.trim()}</code></pre>`;
    });

    // Código inline `...`
    safe = safe.replace(/`([^`]+)`/g, '<code class="homeai-inline-code">$1</code>');

    // Negrita **...**
    safe = safe.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

    // Saltos de línea
    safe = safe.replace(/\n\n/g, '</p><p>');
    safe = safe.replace(/\n/g, '<br>');

    return `<p>${safe}</p>`;
}

export { renderHomeAIView };

// =============================================================================
