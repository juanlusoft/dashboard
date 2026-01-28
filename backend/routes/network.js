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
router.get('/interfaces', async (req, res) => {
    try {
        const netInterfaces = await si.networkInterfaces();

        // Filter and sanitize output (exclude loopback interface)
        const interfaces = netInterfaces
            .filter(iface => iface.iface && iface.iface !== 'lo' && validateInterfaceName(iface.iface))
            .map(iface => ({
                id: iface.iface,
                name: iface.ifaceName || iface.iface,
                ip: iface.ip4 || '',
                subnet: iface.ip4subnet || '',
                dhcp: iface.dhcp === true,
                status: iface.operstate === 'up' ? 'connected' : 'disconnected'
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

        // In a real scenario, this would trigger netplan/nmcli configuration
        // For now, we just acknowledge the request
        res.json({
            success: true,
            message: `Configuration for ${id} received (Hardware apply pending)`
        });
    } catch (e) {
        console.error('Network config error:', e);
        res.status(500).json({ error: 'Failed to configure network' });
    }
});

module.exports = router;
