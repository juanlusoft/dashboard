/**
 * HomeAI Router
 * Endpoints para gestionar instalación, configuración y ejecución de HomeAI (Ollama)
 * Proporciona control de instalación asíncrona, estado de servicio y proxy de chat
 */

const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const { requireAuth } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/rbac');
const { sudoExec, logSecurityEvent } = require('../utils/security');
const { getData, saveData } = require('../utils/data');

// =============================================================================
// CONSTANTES
// =============================================================================

const SCRIPTS_DIR = path.join(__dirname, '../../scripts');
const INSTALL_SCRIPT = path.join(SCRIPTS_DIR, 'homeai/install_homeai.sh');
const UNINSTALL_SCRIPT = path.join(SCRIPTS_DIR, 'homeai/uninstall_homeai.sh');
const OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const OLLAMA_TIMEOUT = 3000;
const CHAT_TIMEOUT = 120000; // 2 minutos para modelos lentos

// =============================================================================
// ESTADO EN MEMORIA (dos procesos independientes)
// =============================================================================

let installState = {
    running: false,
    step: '',
    progress: 0,
    error: null,
    completed: false
};

let uninstallState = {
    running: false,
    step: '',
    progress: 0,
    error: null,
    completed: false
};

// =============================================================================
// FUNCIONES AUXILIARES
// =============================================================================

/**
 * Ejecuta un script bash y rastrea su progreso
 * Parsea líneas en formato [PROGRESS] X% - mensaje y [DONE], [ERROR]
 */
function runScript(scriptPath, args, stateObj) {
    return new Promise((resolve, reject) => {
        const proc = spawn('bash', [scriptPath, ...args]);

        proc.stdout.on('data', (data) => {
            const lines = data.toString().split('\n').filter(l => l.trim());

            for (const line of lines) {
                // Parsear [PROGRESS] 30% - mensaje
                const progressMatch = line.match(/\[PROGRESS\]\s+(\d+)%\s*-?\s*(.*)/);
                if (progressMatch) {
                    stateObj.progress = parseInt(progressMatch[1]);
                    stateObj.step = progressMatch[2].trim();
                    continue;
                }

                // Parsear [DONE]
                if (line.includes('[DONE]')) {
                    stateObj.progress = 100;
                    stateObj.completed = true;
                    continue;
                }

                // Parsear [ERROR]
                const errorMatch = line.match(/\[ERROR\]\s*(.*)/);
                if (errorMatch) {
                    stateObj.error = errorMatch[1].trim();
                }
            }
        });

        proc.stderr.on('data', (data) => {
            // stderr no es siempre error (curl/apt lo usan), solo loguear
            console.error('[HomeAI script stderr]', data.toString().trim());
        });

        proc.on('close', (code) => {
            if (code !== 0 && !stateObj.error) {
                stateObj.error = `Script terminó con código ${code}`;
            }
            stateObj.running = false;

            if (code === 0) {
                resolve();
            } else {
                reject(new Error(stateObj.error));
            }
        });

        proc.on('error', (err) => {
            stateObj.error = `No se pudo ejecutar el script: ${err.message}`;
            stateObj.running = false;
            reject(err);
        });
    });
}

/**
 * Verifica si Ollama está instalado en el sistema
 */
async function isOllamaInstalled() {
    try {
        const { execFile } = require('child_process');
        const { promisify } = require('util');
        const execFileAsync = promisify(execFile);

        await execFileAsync('which', ['ollama']);
        return true;
    } catch {
        return false;
    }
}

/**
 * Verifica si el servicio Ollama está corriendo
 * Intenta conectar a http://127.0.0.1:11434
 */
function isOllamaRunning() {
    return new Promise((resolve) => {
        const req = http.get(`${OLLAMA_BASE_URL}`, (res) => {
            resolve(res.statusCode === 200);
        });

        req.setTimeout(OLLAMA_TIMEOUT, () => {
            req.destroy();
            resolve(false);
        });

        req.on('error', () => {
            resolve(false);
        });
    });
}

/**
 * Verifica si un modelo de HomeAI está cargado en Ollama
 * Llama a /api/tags y busca modelos que comiencen con "HomeAI"
 */
// Queries Ollama /api/show for the HomeAI model — returns { loaded, modelName }
async function getHomeAIModelInfo() {
    return new Promise((resolve) => {
        const postData = JSON.stringify({ name: 'HomeAI' });
        const options = {
            hostname: '127.0.0.1',
            port: 11434,
            path: '/api/show',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
        };
        const req = http.request(options, (res) => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    if (data.error) { resolve({ loaded: false, modelName: null }); return; }
                    const fromLine = (data.modelfile || '').split('\n').find(l => l.trim().startsWith('FROM '));
                    const modelName = fromLine ? fromLine.replace('FROM', '').trim() : null;
                    resolve({ loaded: true, modelName });
                } catch { resolve({ loaded: false, modelName: null }); }
            });
        });
        req.on('error', () => resolve({ loaded: false, modelName: null }));
        req.setTimeout(OLLAMA_TIMEOUT, () => { req.destroy(); resolve({ loaded: false, modelName: null }); });
        req.write(postData);
        req.end();
    });
}

async function isHomeAIModelLoaded() {
    const { loaded } = await getHomeAIModelInfo();
    return loaded;
}

/**
 * Obtiene el path del NVMe configurado
 * Lee de config o devuelve el default
 */
function getNvmePath() {
    const data = getData();
    return (data.homeai && data.homeai.nvmePath) || '/mnt/nvme0';
}

// =============================================================================
// MIDDLEWARES
// =============================================================================

// Requerir autenticación y privilegios de admin para todos los endpoints
router.use(requireAuth);
router.use(requireAdmin);

// =============================================================================
// ENDPOINTS
// =============================================================================

/**
 * GET /status
 * Devuelve el estado completo del módulo HomeAI
 */
router.get('/status', async (req, res) => {
    try {
        const installed = await isOllamaInstalled();
        const running = installed ? await isOllamaRunning() : false;
        const modelInfo = running ? await getHomeAIModelInfo() : { loaded: false, modelName: null };
        const data = getData();

        res.json({
            success: true,
            installed,
            running,
            modelLoaded: modelInfo.loaded,
            modelName: modelInfo.modelName,
            nvmePath: getNvmePath(),
            installState: installState.running ? installState : null,
            uninstallState: uninstallState.running ? uninstallState : null
        });
    } catch (err) {
        console.error('[HomeAI /status] Error:', err.message);
        res.status(500).json({
            error: 'Error obteniendo estado del módulo',
            details: err.message
        });
    }
});

/**
 * POST /install
 * Inicia la instalación de HomeAI en background
 * Responde inmediatamente, ejecuta el script en paralelo
 */
router.post('/install', async (req, res) => {
    try {
        // Si ya hay una instalación en curso, devolver el estado actual
        if (installState.running) {
            return res.json({
                success: true,
                message: 'Instalación ya en curso',
                state: installState
            });
        }

        // Verificar que no esté ya instalado
        const installed = await isOllamaInstalled();
        if (installed) {
            return res.status(400).json({
                error: 'HomeAI ya está instalado'
            });
        }

        // Guardar nvmePath si viene en el request
        if (req.body.nvmePath) {
            const data = getData();
            data.homeai = { ...(data.homeai || {}), nvmePath: req.body.nvmePath };
            await saveData(data);
        }

        // Resetear el estado
        installState = {
            running: true,
            step: 'Inicializando instalación...',
            progress: 0,
            error: null,
            completed: false
        };

        // Log del evento de seguridad
        logSecurityEvent('HOMEAI_INSTALL_START', 'Iniciada instalación de HomeAI', {
            nvmePath: getNvmePath()
        });

        // Responder inmediatamente
        res.json({
            success: true,
            message: 'Instalación iniciada',
            state: installState
        });

        // Ejecutar script en background (sin await)
        runScript(INSTALL_SCRIPT, [getNvmePath()], installState)
            .then(() => {
                console.log('[HomeAI] Instalación completada exitosamente');
                logSecurityEvent('HOMEAI_INSTALL_SUCCESS', 'Instalación de HomeAI completada', {
                    nvmePath: getNvmePath()
                });
            })
            .catch((err) => {
                console.error('[HomeAI] Error en instalación:', err.message);
                logSecurityEvent('HOMEAI_INSTALL_ERROR', 'Error en instalación de HomeAI', {
                    error: err.message,
                    nvmePath: getNvmePath()
                });
            });

    } catch (err) {
        console.error('[HomeAI /install] Error:', err.message);
        res.status(500).json({
            error: 'Error iniciando instalación',
            details: err.message
        });
    }
});

/**
 * GET /install/progress
 * Polling del progreso de instalación
 */
router.get('/install/progress', (req, res) => {
    res.json({
        success: true,
        ...installState
    });
});

/**
 * POST /uninstall
 * Inicia la desinstalación de HomeAI en background
 * Mismo patrón que install
 */
router.post('/uninstall', async (req, res) => {
    try {
        // Si ya hay una desinstalación en curso, devolver el estado actual
        if (uninstallState.running) {
            return res.json({
                success: true,
                message: 'Desinstalación ya en curso',
                state: uninstallState
            });
        }

        // Verificar que esté instalado
        const installed = await isOllamaInstalled();
        if (!installed) {
            return res.status(400).json({
                error: 'HomeAI no está instalado'
            });
        }

        // Resetear el estado
        uninstallState = {
            running: true,
            step: 'Inicializando desinstalación...',
            progress: 0,
            error: null,
            completed: false
        };

        // Log del evento de seguridad
        logSecurityEvent('HOMEAI_UNINSTALL_START', 'Iniciada desinstalación de HomeAI', {
            nvmePath: getNvmePath()
        });

        // Responder inmediatamente
        res.json({
            success: true,
            message: 'Desinstalación iniciada',
            state: uninstallState
        });

        // Ejecutar script en background (sin await)
        runScript(UNINSTALL_SCRIPT, [getNvmePath()], uninstallState)
            .then(() => {
                console.log('[HomeAI] Desinstalación completada exitosamente');
                logSecurityEvent('HOMEAI_UNINSTALL_SUCCESS', 'Desinstalación de HomeAI completada', {
                    nvmePath: getNvmePath()
                });
            })
            .catch((err) => {
                console.error('[HomeAI] Error en desinstalación:', err.message);
                logSecurityEvent('HOMEAI_UNINSTALL_ERROR', 'Error en desinstalación de HomeAI', {
                    error: err.message,
                    nvmePath: getNvmePath()
                });
            });

    } catch (err) {
        console.error('[HomeAI /uninstall] Error:', err.message);
        res.status(500).json({
            error: 'Error iniciando desinstalación',
            details: err.message
        });
    }
});

/**
 * GET /uninstall/progress
 * Polling del progreso de desinstalación
 */
router.get('/uninstall/progress', (req, res) => {
    res.json({
        success: true,
        ...uninstallState
    });
});

/**
 * POST /config
 * Guardar configuración del módulo (nvmePath)
 */
router.post('/config', async (req, res) => {
    try {
        const { nvmePath } = req.body;

        if (!nvmePath || typeof nvmePath !== 'string') {
            return res.status(400).json({
                error: 'nvmePath requerido y debe ser un string'
            });
        }

        const data = getData();
        data.homeai = { ...(data.homeai || {}), nvmePath };
        await saveData(data);

        logSecurityEvent('HOMEAI_CONFIG_UPDATED', 'Configuración de HomeAI actualizada', {
            nvmePath
        });

        res.json({
            success: true,
            message: 'Configuración guardada',
            nvmePath
        });
    } catch (err) {
        console.error('[HomeAI /config] Error:', err.message);
        res.status(500).json({
            error: 'Error guardando configuración',
            details: err.message
        });
    }
});

/**
 * POST /chat
 * Proxy a la API de chat de Ollama
 * Endpoint más importante: permite comunicación en tiempo real con HomeAI
 */
router.post('/chat', async (req, res) => {
    try {
        // Validar que Ollama está corriendo
        const running = await isOllamaRunning();
        if (!running) {
            return res.status(503).json({
                error: 'HomeAI no está disponible en este momento'
            });
        }

        const { messages, stream = false } = req.body;

        // Validar que messages es un array
        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({
                error: 'messages requerido (array)'
            });
        }

        // Construir el payload para Ollama
        const payload = JSON.stringify({
            model: 'HomeAI',
            messages,
            stream
        });

        const options = {
            hostname: '127.0.0.1',
            port: 11434,
            path: '/api/chat',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        };

        const proxyReq = http.request(options, (proxyRes) => {
            // Copiar headers de respuesta
            res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'application/json');
            res.statusCode = proxyRes.statusCode;

            // Pipear la respuesta del servidor de Ollama
            proxyRes.pipe(res);
        });

        // Configurar timeout
        proxyReq.setTimeout(CHAT_TIMEOUT);

        proxyReq.on('error', (err) => {
            if (!res.headersSent) {
                res.status(502).json({
                    error: 'Error comunicando con HomeAI',
                    details: err.message
                });
            } else {
                res.end();
            }
        });

        // Enviar el payload y finalizar
        proxyReq.write(payload);
        proxyReq.end();

    } catch (err) {
        console.error('[HomeAI /chat] Error:', err.message);
        if (!res.headersSent) {
            res.status(500).json({
                error: 'Error procesando solicitud de chat',
                details: err.message
            });
        }
    }
});

/**
 * GET /models
 * Listar modelos disponibles en Ollama
 * Proxy a /api/tags de Ollama
 */
router.get('/models', async (req, res) => {
    try {
        const running = await isOllamaRunning();
        if (!running) {
            return res.status(503).json({
                error: 'HomeAI no está disponible en este momento'
            });
        }

        const options = {
            hostname: '127.0.0.1',
            port: 11434,
            path: '/api/tags',
            method: 'GET',
            headers: {
                'Accept': 'application/json'
            }
        };

        const proxyReq = http.request(options, (proxyRes) => {
            res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'application/json');
            res.statusCode = proxyRes.statusCode;
            proxyRes.pipe(res);
        });

        proxyReq.setTimeout(OLLAMA_TIMEOUT);

        proxyReq.on('error', (err) => {
            if (!res.headersSent) {
                res.status(502).json({
                    error: 'Error comunicando con HomeAI',
                    details: err.message
                });
            } else {
                res.end();
            }
        });

        proxyReq.end();

    } catch (err) {
        console.error('[HomeAI /models] Error:', err.message);
        if (!res.headersSent) {
            res.status(500).json({
                error: 'Error obteniendo lista de modelos',
                details: err.message
            });
        }
    }
});

// =============================================================================
// EXPORT
// =============================================================================

module.exports = router;
