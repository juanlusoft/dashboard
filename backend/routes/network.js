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
router.post('/configure', requireAuth, async (req, res) => {
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

        // Apply configuration with nmcli
        const { execSync } = require('child_process');
        
        try {
            // Get connection name for this interface
            let connectionName;
            try {
                connectionName = execSync(`nmcli -t -f NAME,DEVICE connection show | grep "${id}$" | cut -d: -f1`, { encoding: 'utf-8' }).trim();
            } catch (e) {
                connectionName = '';
            }
            
            if (!connectionName) {
                // Create new connection if it doesn't exist
                if (isDhcp) {
                    execSync(`sudo nmcli connection add type ethernet con-name "${id}" ifname "${id}" autoconnect yes`, { encoding: 'utf-8' });
                } else {
                    const cidr = subnetToCIDR(config.subnet);
                    const dnsServers = Array.isArray(config.dns) ? config.dns.join(' ') : (config.dns || '8.8.8.8');
                    
                    execSync(`sudo nmcli connection add type ethernet con-name "${id}" ifname "${id}" ` +
                             `ip4 "${config.ip}/${cidr}" gw4 "${config.gateway}" ` +
                             `ipv4.dns "${dnsServers}" autoconnect yes`, { encoding: 'utf-8' });
                }
            } else {
                // Modify existing connection
                if (isDhcp) {
                    execSync(`sudo nmcli connection modify "${connectionName}" ipv4.method auto`, { encoding: 'utf-8' });
                    execSync(`sudo nmcli connection modify "${connectionName}" ipv4.addresses ''`, { encoding: 'utf-8' });
                    execSync(`sudo nmcli connection modify "${connectionName}" ipv4.gateway ''`, { encoding: 'utf-8' });
                } else {
                    const cidr = subnetToCIDR(config.subnet);
                    const dnsServers = Array.isArray(config.dns) ? config.dns.join(' ') : (config.dns || '8.8.8.8');
                    
                    execSync(`sudo nmcli connection modify "${connectionName}" ipv4.method manual`, { encoding: 'utf-8' });
                    execSync(`sudo nmcli connection modify "${connectionName}" ipv4.addresses "${config.ip}/${cidr}"`, { encoding: 'utf-8' });
                    execSync(`sudo nmcli connection modify "${connectionName}" ipv4.gateway "${config.gateway}"`, { encoding: 'utf-8' });
                    execSync(`sudo nmcli connection modify "${connectionName}" ipv4.dns "${dnsServers}"`, { encoding: 'utf-8' });
                }
                
                // Bring connection down and up
                execSync(`sudo nmcli connection down "${connectionName}" && sudo nmcli connection up "${connectionName}"`, { encoding: 'utf-8' });
            }
            
            res.json({
                success: true,
                message: isDhcp ? 'Network configured with DHCP' : `Network configured: ${config.ip}`
            });
        } catch (nmcliError) {
            console.error('nmcli error:', nmcliError);
            res.status(500).json({ 
                error: 'Failed to apply network configuration',
                details: nmcliError.message
            });
        }
    } catch (e) {
        console.error('Network config error:', e);
        res.status(500).json({ error: 'Failed to configure network' });
    }
});

// Helper: Convert subnet mask to CIDR notation
function subnetToCIDR(subnet) {
    const parts = subnet.split('.'). map(Number);
    let cidr = 0;
    
    for (const part of parts) {
        cidr += part.toString(2).split('1').length - 1;
    }
    
    return cidr;
}

module.exports = router;
