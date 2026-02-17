/**
 * HomePiNAS v2 - VPN Server Routes (WireGuard)
 *
 * Gestión completa de servidor VPN WireGuard:
 * - Instalar/desinstalar WireGuard
 * - Activar/desactivar el servicio
 * - Crear/eliminar clientes con QR codes
 * - Ver estado y clientes conectados
 * - Configuración de puerto y DNS
 */

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { logSecurityEvent, sudoExec } = require('../utils/security');
const { getData, saveData } = require('../utils/data');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const fs = require('fs');
const path = require('path');

/**
 * Helper: ejecutar comando con stdin usando spawn
 */
function spawnWithStdin(cmd, args, stdinData) {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args);
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (data) => { stdout += data; });
        proc.stderr.on('data', (data) => { stderr += data; });
        proc.on('close', (code) => {
            if (code !== 0) reject(new Error(`${cmd} failed (code ${code}): ${stderr}`));
            else resolve(stdout);
        });
        proc.on('error', (err) => reject(err));
        proc.stdin.write(stdinData);
        proc.stdin.end();
    });
}

// Directorio de configuración de WireGuard
const WG_DIR = '/etc/wireguard';
const WG_CONF = path.join(WG_DIR, 'wg0.conf');
const WG_CLIENTS_DIR = path.join(WG_DIR, 'clients');

// Todas las rutas requieren autenticación
router.use(requireAuth);

// --- Helpers ---

/**
 * Comprobar si WireGuard está instalado
 */
async function isWireguardInstalled() {
    try {
        await execFileAsync('which', ['wg']);
        return true;
    } catch {
        return false;
    }
}

/**
 * Comprobar si el servicio wg-quick@wg0 está activo
 */
async function getServiceStatus() {
    try {
        const { stdout } = await execFileAsync('systemctl', ['is-active', 'wg-quick@wg0']);
        return stdout.trim();
    } catch (err) {
        return err.stdout ? err.stdout.trim() : 'inactive';
    }
}

/**
 * Comprobar si el servicio está habilitado al arranque
 */
async function isServiceEnabled() {
    try {
        const { stdout } = await execFileAsync('systemctl', ['is-enabled', 'wg-quick@wg0']);
        return stdout.trim() === 'enabled';
    } catch {
        return false;
    }
}

/**
 * Obtener la IP local principal del servidor
 */
function getServerLocalIP() {
    const os = require('os');
    const interfaces = os.networkInterfaces();
    for (const iface of Object.values(interfaces)) {
        for (const addr of iface) {
            if (addr.family === 'IPv4' && !addr.internal) {
                return addr.address;
            }
        }
    }
    return '127.0.0.1';
}

/**
 * Obtener la IP pública del servidor
 */
async function getPublicIP() {
    try {
        const response = await fetch('https://api.ipify.org?format=json');
        if (!response.ok) throw new Error('HTTP error');
        const data = await response.json();
        return data.ip;
    } catch {
        return null;
    }
}

/**
 * Generar par de claves WireGuard
 */
async function generateKeyPair() {
    const { stdout: privateKey } = await execFileAsync('wg', ['genkey']);
    const privKey = privateKey.trim();

    // Pasar la clave privada por stdin a wg pubkey
    const pubKeyRaw = await spawnWithStdin('wg', ['pubkey'], privKey);
    const publicKey = pubKeyRaw.trim();

    return {
        privateKey: privKey,
        publicKey
    };
}

/**
 * Generar clave pre-compartida (PSK)
 */
async function generatePresharedKey() {
    const { stdout } = await execFileAsync('wg', ['genpsk']);
    return stdout.trim();
}

/**
 * Leer la configuración VPN almacenada en data.json
 */
function getVpnConfig() {
    const data = getData();
    if (!data.vpn) {
        data.vpn = {
            installed: false,
            port: 51820,
            dns: '1.1.1.1, 8.8.8.8',
            subnet: '10.66.66.0/24',
            endpoint: '',
            serverPublicKey: '',
            serverPrivateKey: '',
            clients: []
        };
    }
    return data.vpn;
}

/**
 * Guardar configuración VPN
 */
function saveVpnConfig(vpnConfig) {
    const data = getData();
    data.vpn = vpnConfig;
    saveData(data);
}

/**
 * Generar el archivo wg0.conf del servidor
 */
function generateServerConfig(vpnConfig) {
    const serverAddr = vpnConfig.subnet.split('/')[0].replace(/\.\d+$/, '.1');
    let config = '[Interface]\n';
    config += `Address = ${serverAddr}/24\n`;
    config += `ListenPort = ${vpnConfig.port}\n`;
    config += `PrivateKey = ${vpnConfig.serverPrivateKey}\n`;
    config += 'PostUp = iptables -A FORWARD -i wg0 -j ACCEPT; iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE\n';
    config += 'PostDown = iptables -D FORWARD -i wg0 -j ACCEPT; iptables -t nat -D POSTROUTING -o eth0 -j MASQUERADE\n';

    // Añadir peers (clientes)
    const clients = vpnConfig.clients || [];
    for (const client of clients) {
        if (!client.revoked) {
            config += `\n# ${client.name}\n`;
            config += '[Peer]\n';
            config += `PublicKey = ${client.publicKey}\n`;
            config += `PresharedKey = ${client.presharedKey}\n`;
            config += `AllowedIPs = ${client.address}/32\n`;
        }
    }

    return config;
}

/**
 * Generar configuración de cliente
 */
function generateClientConfig(vpnConfig, client) {
    const serverAddress = vpnConfig.endpoint || getServerLocalIP();
    let config = '[Interface]\n';
    config += `PrivateKey = ${client.privateKey}\n`;
    config += `Address = ${client.address}/32\n`;
    config += `DNS = ${vpnConfig.dns}\n`;
    config += '\n';
    config += '[Peer]\n';
    config += `PublicKey = ${vpnConfig.serverPublicKey}\n`;
    config += `PresharedKey = ${client.presharedKey}\n`;
    config += `Endpoint = ${serverAddress}:${vpnConfig.port}\n`;
    config += 'AllowedIPs = 0.0.0.0/0, ::/0\n';
    config += 'PersistentKeepalive = 25\n';
    return config;
}

/**
 * Escribir la configuración del servidor al disco
 */
async function writeServerConfig(vpnConfig) {
    const config = generateServerConfig(vpnConfig);
    const tmpFile = '/tmp/wg0.conf.tmp';
    fs.writeFileSync(tmpFile, config, { mode: 0o600 });
    await sudoExec('cp', [tmpFile, WG_CONF]);
    await sudoExec('chmod', ['600', WG_CONF]);
    fs.unlinkSync(tmpFile);
}

/**
 * Obtener siguiente IP disponible en la subred
 */
function getNextClientIP(vpnConfig) {
    const baseParts = vpnConfig.subnet.split('/')[0].split('.');
    const usedIPs = new Set();

    // .1 es el servidor
    usedIPs.add(1);

    for (const client of (vpnConfig.clients || [])) {
        const lastOctet = parseInt(client.address.split('.').pop());
        usedIPs.add(lastOctet);
    }

    // Buscar siguiente IP libre (2-254)
    for (let i = 2; i <= 254; i++) {
        if (!usedIPs.has(i)) {
            return `${baseParts[0]}.${baseParts[1]}.${baseParts[2]}.${i}`;
        }
    }

    throw new Error('No hay IPs disponibles en la subred');
}

// --- Rutas ---

/**
 * GET /status - Estado general del servidor VPN
 */
router.get('/status', async (req, res) => {
    try {
        const installed = await isWireguardInstalled();
        const vpnConfig = getVpnConfig();

        let serviceStatus = 'inactive';
        let enabled = false;
        let connectedPeers = [];

        if (installed) {
            serviceStatus = await getServiceStatus();
            enabled = await isServiceEnabled();

            // Obtener peers conectados
            if (serviceStatus === 'active') {
                try {
                    const { stdout } = await sudoExec('wg', ['show', 'wg0', 'dump']);
                    const lines = stdout.trim().split('\n');
                    // Primera línea es el servidor, resto son peers
                    for (let i = 1; i < lines.length; i++) {
                        const parts = lines[i].split('\t');
                        if (parts.length >= 8) {
                            const publicKey = parts[0];
                            const endpoint = parts[2];
                            const allowedIps = parts[3];
                            const latestHandshake = parseInt(parts[4]);
                            const transferRx = parseInt(parts[5]);
                            const transferTx = parseInt(parts[6]);

                            // Buscar nombre del cliente por su clave pública
                            const client = (vpnConfig.clients || []).find(c => c.publicKey === publicKey);

                            connectedPeers.push({
                                name: client ? client.name : 'Desconocido',
                                publicKey: publicKey.substring(0, 12) + '...',
                                endpoint: endpoint === '(none)' ? null : endpoint,
                                allowedIps,
                                latestHandshake: latestHandshake > 0 ? new Date(latestHandshake * 1000).toISOString() : null,
                                transferRx,
                                transferTx,
                                connected: latestHandshake > 0 && (Date.now() / 1000 - latestHandshake) < 180
                            });
                        }
                    }
                } catch (e) {
                    console.error('[VPN] Error leyendo peers:', e.message);
                }
            }
        }

        // Obtener IP pública
        let publicIP = vpnConfig.endpoint || null;
        if (!publicIP) {
            publicIP = await getPublicIP();
        }

        const clients = (vpnConfig.clients || []).map(c => ({
            id: c.id,
            name: c.name,
            address: c.address,
            createdAt: c.createdAt,
            revoked: c.revoked || false
        }));

        res.json({
            success: true,
            installed,
            service: serviceStatus,
            running: serviceStatus === 'active',
            enabled,
            port: vpnConfig.port,
            dns: vpnConfig.dns,
            subnet: vpnConfig.subnet,
            endpoint: vpnConfig.endpoint,
            publicIP,
            clientCount: clients.filter(c => !c.revoked).length,
            clients,
            connectedPeers
        });
    } catch (err) {
        console.error('[VPN] Error obteniendo estado:', err);
        res.status(500).json({ success: false, error: 'Error obteniendo estado VPN' });
    }
});

/**
 * POST /install - Instalar WireGuard
 */
router.post('/install', async (req, res) => {
    try {
        const installed = await isWireguardInstalled();
        if (installed) {
            return res.json({ success: true, message: 'WireGuard ya está instalado' });
        }

        // Instalar WireGuard y qrencode
        await sudoExec('apt-get', ['update'], { timeout: 120000 });
        await sudoExec('apt-get', ['install', '-y', 'wireguard', 'wireguard-tools', 'qrencode'], { timeout: 120000 });

        // Habilitar IP forwarding
        const sysctlContent = 'net.ipv4.ip_forward=1\nnet.ipv6.conf.all.forwarding=1\n';
        const tmpSysctl = '/tmp/99-wireguard.conf';
        fs.writeFileSync(tmpSysctl, sysctlContent);
        await sudoExec('cp', [tmpSysctl, '/etc/sysctl.d/99-wireguard.conf']);
        fs.unlinkSync(tmpSysctl);
        await sudoExec('sysctl', ['--system'], { timeout: 10000 });

        // Crear directorio de clientes
        await sudoExec('mkdir', ['-p', WG_CLIENTS_DIR]);
        await sudoExec('chmod', ['700', WG_DIR]);

        // Generar claves del servidor
        const serverKeys = await generateKeyPair();

        // Configurar
        const vpnConfig = getVpnConfig();
        vpnConfig.installed = true;
        vpnConfig.serverPrivateKey = serverKeys.privateKey;
        vpnConfig.serverPublicKey = serverKeys.publicKey;

        // Obtener endpoint (IP pública o DDNS configurado)
        if (!vpnConfig.endpoint) {
            const data = getData();
            const ddnsServices = (data.network && data.network.ddns) || [];
            const activeDDNS = ddnsServices.find(s => s.enabled);
            if (activeDDNS) {
                vpnConfig.endpoint = activeDDNS.domain || activeDDNS.hostname;
            } else {
                const publicIP = await getPublicIP();
                vpnConfig.endpoint = publicIP || getServerLocalIP();
            }
        }

        // Escribir configuración del servidor
        await writeServerConfig(vpnConfig);
        saveVpnConfig(vpnConfig);

        logSecurityEvent('vpn_installed', {
            user: req.user,
            port: vpnConfig.port
        });

        res.json({ success: true, message: 'WireGuard instalado correctamente' });
    } catch (err) {
        console.error('[VPN] Error instalando:', err);
        res.status(500).json({ success: false, error: `Error instalando WireGuard: ${err.message}` });
    }
});

/**
 * POST /start - Activar servicio VPN
 */
router.post('/start', async (req, res) => {
    try {
        const installed = await isWireguardInstalled();
        if (!installed) {
            return res.status(400).json({ success: false, error: 'WireGuard no está instalado' });
        }

        await sudoExec('systemctl', ['enable', 'wg-quick@wg0']);
        await sudoExec('systemctl', ['start', 'wg-quick@wg0']);

        // Verificar
        await new Promise(resolve => setTimeout(resolve, 1000));
        const status = await getServiceStatus();

        logSecurityEvent('vpn_started', { user: req.user });

        res.json({
            success: true,
            message: 'Servidor VPN activado',
            service: status,
            running: status === 'active'
        });
    } catch (err) {
        console.error('[VPN] Error iniciando:', err);
        res.status(500).json({ success: false, error: `Error iniciando VPN: ${err.message}` });
    }
});

/**
 * POST /stop - Detener servicio VPN
 */
router.post('/stop', async (req, res) => {
    try {
        await sudoExec('systemctl', ['stop', 'wg-quick@wg0']);
        await sudoExec('systemctl', ['disable', 'wg-quick@wg0']);

        logSecurityEvent('vpn_stopped', { user: req.user });

        res.json({ success: true, message: 'Servidor VPN detenido' });
    } catch (err) {
        console.error('[VPN] Error deteniendo:', err);
        res.status(500).json({ success: false, error: `Error deteniendo VPN: ${err.message}` });
    }
});

/**
 * POST /restart - Reiniciar servicio VPN
 */
router.post('/restart', async (req, res) => {
    try {
        await sudoExec('systemctl', ['restart', 'wg-quick@wg0']);

        await new Promise(resolve => setTimeout(resolve, 1000));
        const status = await getServiceStatus();

        logSecurityEvent('vpn_restarted', { user: req.user });

        res.json({
            success: true,
            message: 'Servidor VPN reiniciado',
            service: status,
            running: status === 'active'
        });
    } catch (err) {
        console.error('[VPN] Error reiniciando:', err);
        res.status(500).json({ success: false, error: `Error reiniciando VPN: ${err.message}` });
    }
});

/**
 * PUT /config - Actualizar configuración del servidor VPN
 */
router.put('/config', async (req, res) => {
    try {
        const { port, dns, endpoint } = req.body;
        const vpnConfig = getVpnConfig();

        // Validar puerto
        if (port !== undefined) {
            const portNum = parseInt(port);
            if (isNaN(portNum) || portNum < 1024 || portNum > 65535) {
                return res.status(400).json({ success: false, error: 'Puerto inválido (1024-65535)' });
            }
            vpnConfig.port = portNum;
        }

        // Validar DNS
        if (dns !== undefined) {
            if (typeof dns !== 'string' || dns.length > 200) {
                return res.status(400).json({ success: false, error: 'DNS inválido' });
            }
            vpnConfig.dns = dns.trim();
        }

        // Validar endpoint
        if (endpoint !== undefined) {
            if (typeof endpoint !== 'string' || endpoint.length > 253) {
                return res.status(400).json({ success: false, error: 'Endpoint inválido' });
            }
            vpnConfig.endpoint = endpoint.trim();
        }

        // Reescribir configuración
        if (vpnConfig.serverPrivateKey) {
            await writeServerConfig(vpnConfig);
        }
        saveVpnConfig(vpnConfig);

        // Reiniciar si estaba activo
        const status = await getServiceStatus();
        if (status === 'active') {
            await sudoExec('systemctl', ['restart', 'wg-quick@wg0']);
        }

        logSecurityEvent('vpn_config_updated', { user: req.user, port: vpnConfig.port });

        res.json({ success: true, message: 'Configuración actualizada' });
    } catch (err) {
        console.error('[VPN] Error actualizando config:', err);
        res.status(500).json({ success: false, error: `Error actualizando configuración: ${err.message}` });
    }
});

/**
 * POST /clients - Crear un nuevo cliente VPN
 */
router.post('/clients', async (req, res) => {
    try {
        const { name } = req.body;

        if (!name || typeof name !== 'string') {
            return res.status(400).json({ success: false, error: 'Nombre de cliente requerido' });
        }

        // Validar nombre (solo alfanumérico, guiones, guiones bajos)
        const safeName = name.trim();
        if (!/^[a-zA-Z0-9_-]{1,32}$/.test(safeName)) {
            return res.status(400).json({ success: false, error: 'Nombre inválido (solo letras, números, - y _, máx 32 caracteres)' });
        }

        const vpnConfig = getVpnConfig();

        // Comprobar nombre duplicado
        if (vpnConfig.clients.some(c => c.name === safeName && !c.revoked)) {
            return res.status(400).json({ success: false, error: 'Ya existe un cliente con ese nombre' });
        }

        // Generar claves
        const clientKeys = await generateKeyPair();
        const presharedKey = await generatePresharedKey();
        const clientIP = getNextClientIP(vpnConfig);

        const client = {
            id: Date.now().toString(36),
            name: safeName,
            privateKey: clientKeys.privateKey,
            publicKey: clientKeys.publicKey,
            presharedKey: presharedKey,
            address: clientIP,
            createdAt: new Date().toISOString(),
            revoked: false
        };

        vpnConfig.clients.push(client);
        saveVpnConfig(vpnConfig);

        // Reescribir config del servidor con el nuevo peer
        await writeServerConfig(vpnConfig);

        // Generar configuración del cliente
        const clientConf = generateClientConfig(vpnConfig, client);

        // Generar QR code como SVG
        let qrSvg = null;
        try {
            const stdout = await spawnWithStdin('qrencode', ['-t', 'SVG', '-o', '-'], clientConf);
            qrSvg = stdout;
        } catch (e) {
            console.warn('[VPN] No se pudo generar QR:', e.message);
        }

        // Si el servicio está activo, recargar la configuración
        const status = await getServiceStatus();
        if (status === 'active') {
            try {
                await sudoExec('systemctl', ['restart', 'wg-quick@wg0']);
            } catch (e) {
                console.warn('[VPN] Error recargando WireGuard:', e.message);
            }
        }

        logSecurityEvent('vpn_client_created', {
            user: req.user,
            clientName: safeName,
            clientIP
        });

        res.status(201).json({
            success: true,
            client: {
                id: client.id,
                name: client.name,
                address: client.address,
                createdAt: client.createdAt
            },
            config: clientConf,
            qrSvg
        });
    } catch (err) {
        console.error('[VPN] Error creando cliente:', err);
        res.status(500).json({ success: false, error: `Error creando cliente: ${err.message}` });
    }
});

/**
 * GET /clients/:id/config - Obtener configuración de un cliente (para descargar/QR)
 */
router.get('/clients/:id/config', async (req, res) => {
    try {
        const vpnConfig = getVpnConfig();
        const client = vpnConfig.clients.find(c => c.id === req.params.id);

        if (!client) {
            return res.status(404).json({ success: false, error: 'Cliente no encontrado' });
        }

        if (client.revoked) {
            return res.status(400).json({ success: false, error: 'Cliente revocado' });
        }

        const clientConf = generateClientConfig(vpnConfig, client);

        // Generar QR
        let qrSvg = null;
        try {
            const stdout = await spawnWithStdin('qrencode', ['-t', 'SVG', '-o', '-'], clientConf);
            qrSvg = stdout;
        } catch (e) {
            console.warn('[VPN] No se pudo generar QR:', e.message);
        }

        res.json({
            success: true,
            client: {
                id: client.id,
                name: client.name,
                address: client.address
            },
            config: clientConf,
            qrSvg
        });
    } catch (err) {
        console.error('[VPN] Error obteniendo config cliente:', err);
        res.status(500).json({ success: false, error: 'Error obteniendo configuración del cliente' });
    }
});

/**
 * DELETE /clients/:id - Revocar/eliminar un cliente VPN
 */
router.delete('/clients/:id', async (req, res) => {
    try {
        const vpnConfig = getVpnConfig();
        const clientIndex = vpnConfig.clients.findIndex(c => c.id === req.params.id);

        if (clientIndex === -1) {
            return res.status(404).json({ success: false, error: 'Cliente no encontrado' });
        }

        const client = vpnConfig.clients[clientIndex];
        client.revoked = true;
        client.revokedAt = new Date().toISOString();
        // Limpiar claves privadas por seguridad
        client.privateKey = '[REVOKED]';

        saveVpnConfig(vpnConfig);

        // Reescribir config del servidor sin este peer
        await writeServerConfig(vpnConfig);

        // Reiniciar si activo
        const status = await getServiceStatus();
        if (status === 'active') {
            try {
                await sudoExec('systemctl', ['restart', 'wg-quick@wg0']);
            } catch (e) {
                console.warn('[VPN] Error recargando WireGuard:', e.message);
            }
        }

        logSecurityEvent('vpn_client_revoked', {
            user: req.user,
            clientName: client.name,
            clientId: client.id
        });

        res.json({ success: true, message: `Cliente ${client.name} revocado` });
    } catch (err) {
        console.error('[VPN] Error revocando cliente:', err);
        res.status(500).json({ success: false, error: 'Error revocando cliente' });
    }
});

/**
 * POST /uninstall - Desinstalar WireGuard
 */
router.post('/uninstall', async (req, res) => {
    try {
        // Detener servicio
        try {
            await sudoExec('systemctl', ['stop', 'wg-quick@wg0']);
            await sudoExec('systemctl', ['disable', 'wg-quick@wg0']);
        } catch (e) {
            // Puede que ya esté parado
        }

        // Desinstalar paquetes
        await sudoExec('apt-get', ['remove', '-y', 'wireguard', 'wireguard-tools'], { timeout: 60000 });

        // Limpiar configuración local
        const vpnConfig = getVpnConfig();
        vpnConfig.installed = false;
        vpnConfig.serverPrivateKey = '';
        vpnConfig.serverPublicKey = '';
        vpnConfig.clients = [];
        saveVpnConfig(vpnConfig);

        logSecurityEvent('vpn_uninstalled', { user: req.user });

        res.json({ success: true, message: 'WireGuard desinstalado' });
    } catch (err) {
        console.error('[VPN] Error desinstalando:', err);
        res.status(500).json({ success: false, error: `Error desinstalando: ${err.message}` });
    }
});

module.exports = router;
