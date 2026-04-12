/**
 * HomePiNAS - Network Routes
 * v1.6.0 - Security Hardening
 *
 * Network interface management
 * SECURITY: All inputs validated
 */

const log = require('../utils/logger');
const express = require('express');
const router = express.Router();
const si = require('systeminformation');
const fs = require('fs');
const { execFileSync } = require('child_process');

const { requireAuth } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/rbac');
const { logSecurityEvent } = require('../utils/security');
const {
    validateInterfaceName,
    validateIPv4,
    validateSubnetMask
} = require('../utils/sanitize');

// Get current IP (public - used by wizard before login)
router.get('/current-ip', async (req, res) => {
    try {
        const netInterfaces = await si.networkInterfaces();
        const physicalPrefixes = ['eth', 'wlan', 'enp', 'ens', 'wlp', 'end'];
        const excludePrefixes = ['lo', 'docker', 'veth', 'br-', 'virbr', 'tun', 'tap'];
        const primary = netInterfaces.find(iface => {
            if (!iface.iface || !validateInterfaceName(iface.iface)) return false;
            const name = iface.iface.toLowerCase();
            if (excludePrefixes.some(p => name.startsWith(p))) return false;
            return physicalPrefixes.some(p => name.startsWith(p)) && iface.ip4;
        });
        res.json({ ip: primary?.ip4 || '', dhcp: primary?.dhcp === true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to read network info' });
    }
});

// Get network interfaces
router.get('/interfaces', requireAuth, async (req, res) => {
    try {
        const netInterfaces = await si.networkInterfaces();

        // Only show real physical interfaces (eth*, wlan*, enp*, ens*, wlp*)
        // Exclude: loopback, docker, virtual bridges, veth
        const physicalPrefixes = ['eth', 'wlan', 'enp', 'ens', 'wlp', 'end'];
        const excludePrefixes = ['lo', 'docker', 'veth', 'br-', 'virbr', 'tun', 'tap'];

        // Get gateway/DNS from nmcli (cached 30s — nmcli is slow)
        let nmcliDetails = {};
        const now = Date.now();
        if (!router._nmcliCache || now - router._nmcliCacheTime > 30000) {
            try {
                const conList = execFileSync('nmcli', ['-t', '-f', 'NAME,DEVICE', 'con', 'show', '--active'], { encoding: 'utf8', timeout: 5000 });
                for (const line of conList.trim().split('\n')) {
                    const [conName, device] = line.split(':');
                    if (!device || !physicalPrefixes.some(p => device.toLowerCase().startsWith(p))) continue;
                    try {
                        const detail = execFileSync('nmcli', ['-t', '-f', 'IP4.GATEWAY,IP4.DNS', 'con', 'show', conName], { encoding: 'utf8', timeout: 3000 });
                        const gw = (detail.match(/IP4\.GATEWAY:(.+)/)||[])[1] || '';
                        const dns = (detail.match(/IP4\.DNS\[1\]:(.+)/)||[])[1] || '';
                        nmcliDetails[device] = { gateway: gw.trim(), dns: dns.trim() };
                    } catch (e) {}
                }
                router._nmcliCache = nmcliDetails;
                router._nmcliCacheTime = now;
            } catch (e) {}
        } else {
            nmcliDetails = router._nmcliCache;
        }

        const interfaces = netInterfaces
            .filter(iface => {
                if (!iface.iface || !validateInterfaceName(iface.iface)) return false;
                const name = iface.iface.toLowerCase();
                // Exclude virtual interfaces
                if (excludePrefixes.some(prefix => name.startsWith(prefix))) return false;
                // Include only physical interfaces
                return physicalPrefixes.some(prefix => name.startsWith(prefix));
            })
            .map(iface => {
                const nmcli = nmcliDetails[iface.iface] || {};
                return {
                    id: iface.iface,
                    name: iface.ifaceName || iface.iface,
                    ip: iface.ip4 || '',
                    subnet: iface.ip4subnet || '',
                    gateway: iface.ip4gateway || nmcli.gateway || '',
                    dns: nmcli.dns || '',
                    dhcp: iface.dhcp === true,
                    status: iface.operstate === 'up' ? 'connected' : 'disconnected',
                    mac: iface.mac || ''
                };
            });

        res.json(interfaces);
    } catch (e) {
        log.error('Network interfaces error:', e);
        res.status(500).json({ error: 'Failed to read network interfaces' });
    }
});

// Configure network interface
router.post('/configure', requireAdmin, (req, res) => {
    try {
        const { id, config } = req.body;

        // Validate interface name
        if (!validateInterfaceName(id)) {
            return res.status(400).json({ error: 'Invalid interface ID' });
        }

        if (!config || typeof config !== 'object') {
            return res.status(400).json({ error: 'Invalid configuration' });
        }

        // Validate DHCP flag
        const isDhcp = config.dhcp === true;

        // Validate IP and subnet if not DHCP
        if (!isDhcp) {
            if (config.ip && !validateIPv4(config.ip)) {
                return res.status(400).json({ error: 'Invalid IP address format' });
            }

            if (config.subnet && !validateSubnetMask(config.subnet)) {
                return res.status(400).json({ error: 'Invalid subnet mask format' });
            }

            if (config.gateway && !validateIPv4(config.gateway)) {
                return res.status(400).json({ error: 'Invalid gateway format' });
            }

            if (config.dns) {
                if (typeof config.dns === 'string') {
                    if (!validateIPv4(config.dns)) {
                        return res.status(400).json({ error: 'Invalid DNS format' });
                    }
                } else if (Array.isArray(config.dns)) {
                    for (const dns of config.dns) {
                        if (!validateIPv4(dns)) {
                            return res.status(400).json({ error: 'Invalid DNS format' });
                        }
                    }
                }
            }
        }

        logSecurityEvent('NETWORK_CONFIG', {
            user: req.user.username,
            interface: id,
            dhcp: isDhcp
        }, req.ip);

        // Apply network configuration using nmcli (NetworkManager)
        try {
            // Resolve connection name from device name (nmcli uses connection names, not device names)
            let conName = id;
            try {
                const conList = execFileSync('nmcli', ['-t', '-f', 'NAME,DEVICE', 'con', 'show'], { encoding: 'utf8', timeout: 5000 });
                const match = conList.split('\n').find(l => l.split(':')[1] === id);
                if (match) conName = match.split(':')[0];
            } catch (e) {}

            if (isDhcp) {
                // Switch to DHCP
                execFileSync('sudo', ['nmcli', 'con', 'mod', conName, 'ipv4.method', 'auto'], { encoding: 'utf8', timeout: 10000 });
                execFileSync('sudo', ['nmcli', 'con', 'mod', conName, 'ipv4.addresses', ''], { encoding: 'utf8', timeout: 10000 });
                execFileSync('sudo', ['nmcli', 'con', 'mod', conName, 'ipv4.gateway', ''], { encoding: 'utf8', timeout: 10000 });
                execFileSync('sudo', ['nmcli', 'con', 'mod', conName, 'ipv4.dns', ''], { encoding: 'utf8', timeout: 10000 });
            } else {
                // Static IP configuration
                const ip = config.ip;
                const subnet = config.subnet || '255.255.255.0';
                const gateway = config.gateway || '';
                const dns = Array.isArray(config.dns) ? config.dns.join(' ') : (config.dns || '');

                // Convert subnet mask to CIDR prefix (count set bits via popcount)
                const cidr = subnet.split('.').reduce((acc, octet) => {
                    let n = parseInt(octet) & 0xFF;
                    let bits = 0;
                    while (n & 0x80) { bits++; n = (n << 1) & 0xFF; }
                    return acc + bits;
                }, 0);

                // Set all static IP params in one nmcli call (method manual requires address)
                const nmcliArgs = ['nmcli', 'con', 'mod', conName,
                    'ipv4.method', 'manual',
                    'ipv4.addresses', `${ip}/${cidr}`
                ];
                if (gateway) {
                    nmcliArgs.push('ipv4.gateway', gateway);
                }
                if (dns) {
                    nmcliArgs.push('ipv4.dns', dns);
                }
                execFileSync('sudo', nmcliArgs, { encoding: 'utf8', timeout: 10000 });
            }

            // Apply changes by reactivating the connection
            execFileSync('sudo', ['nmcli', 'con', 'up', conName], { encoding: 'utf8', timeout: 15000 });

            res.json({
                success: true,
                message: isDhcp 
                    ? `${id} configurado en modo DHCP` 
                    : `${id} configurado con IP estática ${config.ip}`
            });
        } catch (applyErr) {
            log.error('nmcli apply error:', applyErr.message);
            
            // Fallback: try dhcpcd for older systems
            try {
                const dhcpcdConf = '/etc/dhcpcd.conf';
                if (fs.existsSync(dhcpcdConf)) {
                    let content = fs.readFileSync(dhcpcdConf, 'utf8');
                    
                    // Remove existing static config for this interface
                    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const regex = new RegExp(`\\n?interface ${escapedId}[\\s\\S]*?(?=\\ninterface |$)`, 'g');
                    content = content.replace(regex, '');
                    
                    if (!isDhcp) {
                        const subnet = config.subnet || '255.255.255.0';
                        const cidr = subnet.split('.').reduce((acc, octet) => {
                            let n = parseInt(octet) & 0xFF;
                            let bits = 0;
                            while (n & 0x80) { bits++; n = (n << 1) & 0xFF; }
                            return acc + bits;
                        }, 0);

                        content += `\ninterface ${id}\nstatic ip_address=${config.ip}/${cidr}\n`;
                        if (config.gateway) content += `static routers=${config.gateway}\n`;
                        if (config.dns) {
                            const dnsStr = Array.isArray(config.dns) ? config.dns.join(' ') : config.dns;
                            content += `static domain_name_servers=${dnsStr}\n`;
                        }
                    }

                    const tmpPath = '/tmp/homepinas-dhcpcd-tmp';
                    fs.writeFileSync(tmpPath, content, 'utf8');
                    execFileSync('sudo', ['cp', tmpPath, dhcpcdConf], { encoding: 'utf8', timeout: 10000 });
                    fs.unlinkSync(tmpPath);
                    execFileSync('sudo', ['systemctl', 'restart', 'dhcpcd'], { encoding: 'utf8', timeout: 15000 });
                    
                    res.json({
                        success: true,
                        message: isDhcp 
                            ? `${id} configurado en modo DHCP (dhcpcd)` 
                            : `${id} configurado con IP estática ${config.ip} (dhcpcd)`
                    });
                } else {
                    res.json({
                        success: false,
                        message: 'NetworkManager no disponible y dhcpcd no encontrado. Configura la red manualmente.'
                    });
                }
            } catch (dhcpcdErr) {
                log.error('dhcpcd fallback error:', dhcpcdErr.message);
                res.status(500).json({ 
                    error: `No se pudo aplicar la configuración: ${applyErr.message}` 
                });
            }
        }
    } catch (e) {
        log.error('Network config error:', e);
        res.status(500).json({ error: 'Failed to configure network' });
    }
});

// Network bandwidth stats from /proc/net/dev
const _netPrev = {};
router.get('/stats', requireAuth, (req, res) => {
    try {
        const raw = fs.readFileSync('/proc/net/dev', 'utf8');
        const now = Date.now();
        const stats = [];

        for (const line of raw.split('\n').slice(2)) {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 10) continue;
            const iface = parts[0].replace(':', '');
            if (iface === 'lo') continue;

            const rxBytes = parseInt(parts[1]) || 0;
            const txBytes = parseInt(parts[9]) || 0;

            let rxSpeed = 0, txSpeed = 0;
            if (_netPrev[iface]) {
                const dt = (now - _netPrev[iface].ts) / 1000;
                if (dt > 0) {
                    rxSpeed = Math.max(0, (rxBytes - _netPrev[iface].rx) / dt);
                    txSpeed = Math.max(0, (txBytes - _netPrev[iface].tx) / dt);
                }
            }
            _netPrev[iface] = { rx: rxBytes, tx: txBytes, ts: now };
            stats.push({ iface, rxSpeed, txSpeed, rxBytes, txBytes });
        }

        res.json(stats);
    } catch (e) {
        res.status(500).json({ error: 'Failed to read network stats' });
    }
});

module.exports = router;
