/**
 * HomePiNAS - Network Routes
 * v1.6.0 - Security Hardening
 *
 * Network interface management
 * SECURITY: All inputs validated
 */

const express = require('express');
const router = express.Router();
const si = require('systeminformation');

const { requireAuth } = require('../middleware/auth');
const { logSecurityEvent } = require('../utils/security');
const {
    validateInterfaceName,
    validateIPv4,
    validateSubnetMask
} = require('../utils/sanitize');

// Get network interfaces
router.get('/interfaces', requireAuth, async (req, res) => {
    try {
        const netInterfaces = await si.networkInterfaces();

        // Only show real physical interfaces (eth*, wlan*, enp*, ens*, wlp*)
        // Exclude: loopback, docker, virtual bridges, veth
        const physicalPrefixes = ['eth', 'wlan', 'enp', 'ens', 'wlp', 'end'];
        const excludePrefixes = ['lo', 'docker', 'veth', 'br-', 'virbr', 'tun', 'tap'];

        const interfaces = netInterfaces
            .filter(iface => {
                if (!iface.iface || !validateInterfaceName(iface.iface)) return false;
                const name = iface.iface.toLowerCase();
                // Exclude virtual interfaces
                if (excludePrefixes.some(prefix => name.startsWith(prefix))) return false;
                // Include only physical interfaces
                return physicalPrefixes.some(prefix => name.startsWith(prefix));
            })
            .map(iface => ({
                id: iface.iface,
                name: iface.ifaceName || iface.iface,
                ip: iface.ip4 || '',
                subnet: iface.ip4subnet || '',
                gateway: iface.ip4gateway || '',
                dhcp: iface.dhcp === true,
                status: iface.operstate === 'up' ? 'connected' : 'disconnected',
                mac: iface.mac || ''
            }));

        res.json(interfaces);
    } catch (e) {
        console.error('Network interfaces error:', e);
        res.status(500).json({ error: 'Failed to read network interfaces' });
    }
});

// Configure network interface
router.post('/configure', requireAuth, (req, res) => {
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
            if (isDhcp) {
                // Switch to DHCP
                execFileSync('sudo', ['nmcli', 'con', 'mod', id, 'ipv4.method', 'auto'], { encoding: 'utf8', timeout: 10000 });
                execFileSync('sudo', ['nmcli', 'con', 'mod', id, 'ipv4.addresses', ''], { encoding: 'utf8', timeout: 10000 });
                execFileSync('sudo', ['nmcli', 'con', 'mod', id, 'ipv4.gateway', ''], { encoding: 'utf8', timeout: 10000 });
                execFileSync('sudo', ['nmcli', 'con', 'mod', id, 'ipv4.dns', ''], { encoding: 'utf8', timeout: 10000 });
            } else {
                // Static IP configuration
                const ip = config.ip;
                const subnet = config.subnet || '255.255.255.0';
                const gateway = config.gateway || '';
                const dns = Array.isArray(config.dns) ? config.dns.join(' ') : (config.dns || '');

                // Convert subnet mask to CIDR prefix
                const cidr = subnet.split('.').reduce((acc, octet) => 
                    acc + (parseInt(octet) >>> 0).toString(2).split('1').length - 1, 0);

                execFileSync('sudo', ['nmcli', 'con', 'mod', id, 'ipv4.method', 'manual'], { encoding: 'utf8', timeout: 10000 });
                execFileSync('sudo', ['nmcli', 'con', 'mod', id, 'ipv4.addresses', `${ip}/${cidr}`], { encoding: 'utf8', timeout: 10000 });
                
                if (gateway) {
                    execFileSync('sudo', ['nmcli', 'con', 'mod', id, 'ipv4.gateway', gateway], { encoding: 'utf8', timeout: 10000 });
                }
                if (dns) {
                    execFileSync('sudo', ['nmcli', 'con', 'mod', id, 'ipv4.dns', dns], { encoding: 'utf8', timeout: 10000 });
                }
            }

            // Apply changes by reactivating the connection
            execFileSync('sudo', ['nmcli', 'con', 'up', id], { encoding: 'utf8', timeout: 15000 });

            res.json({
                success: true,
                message: isDhcp 
                    ? `${id} configurado en modo DHCP` 
                    : `${id} configurado con IP estática ${config.ip}`
            });
        } catch (applyErr) {
            console.error('nmcli apply error:', applyErr.message);
            
            // Fallback: try dhcpcd for older systems
            try {
                const dhcpcdConf = '/etc/dhcpcd.conf';
                if (fs.existsSync(dhcpcdConf)) {
                    let content = fs.readFileSync(dhcpcdConf, 'utf8');
                    
                    // Remove existing static config for this interface
                    const regex = new RegExp(`\\n?interface ${id}[\\s\\S]*?(?=\\ninterface |$)`, 'g');
                    content = content.replace(regex, '');
                    
                    if (!isDhcp) {
                        const subnet = config.subnet || '255.255.255.0';
                        const cidr = subnet.split('.').reduce((acc, octet) => 
                            acc + (parseInt(octet) >>> 0).toString(2).split('1').length - 1, 0);
                        
                        content += `\ninterface ${id}\nstatic ip_address=${config.ip}/${cidr}\n`;
                        if (config.gateway) content += `static routers=${config.gateway}\n`;
                        if (config.dns) {
                            const dnsStr = Array.isArray(config.dns) ? config.dns.join(' ') : config.dns;
                            content += `static domain_name_servers=${dnsStr}\n`;
                        }
                    }
                    
                    fs.writeFileSync(dhcpcdConf, content);
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
                console.error('dhcpcd fallback error:', dhcpcdErr.message);
                res.status(500).json({ 
                    error: `No se pudo aplicar la configuración: ${applyErr.message}` 
                });
            }
        }
    } catch (e) {
        console.error('Network config error:', e);
        res.status(500).json({ error: 'Failed to configure network' });
    }
});

module.exports = router;
