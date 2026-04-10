/**
 * NAS Discovery - Find HomePiNAS on the local network
 * Identifies HomePiNAS by checking for _sig:'hnv2' in /api/system/status
 */

const https = require('https');
const os = require('os');

class NASDiscovery {
  constructor() {
    this.timeout = 3000;
  }

  async discover(manualIP = null) {
    const results = [];

    // Method 1: Manual IP provided by user
    if (manualIP) {
      const result = await this._checkHost(manualIP, 443);
      if (result) return [result];
    }

    // Method 2: Subnet scan
    try {
      const scanResults = await this._scanSubnet();
      results.push(...scanResults);
    } catch (e) {}

    // Deduplicate by IP
    const seen = new Set();
    return results.filter(r => {
      if (seen.has(r.address)) return false;
      seen.add(r.address);
      return true;
    });
  }

  async _checkHost(host, port) {
    return new Promise((resolve) => {
      const agent = new https.Agent({ rejectUnauthorized: false });
      const req = https.get({
        hostname: host,
        port,
        path: '/api/system/status',
        timeout: this.timeout,
        agent,
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            // Identify HomePiNAS by hidden signature
            if (json._sig === 'hnv2') {
              resolve({
                address: host,
                port,
                name: 'HomePiNAS',
                version: json.version || '',
                method: host === host ? 'scan' : 'manual',
              });
            } else {
              resolve(null);
            }
          } catch (e) {
            resolve(null);
          }
        });
      });

      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
  }

  async _scanSubnet() {
    const localIP = this._getLocalIP();
    if (!localIP) return [];

    const subnet = localIP.replace(/\.\d+$/, '.');
    const results = [];
    const promises = [];

    for (let i = 1; i <= 254; i++) {
      const ip = subnet + i;
      if (ip === localIP) continue;

      promises.push(
        this._checkHost(ip, 443).then(result => {
          if (result) results.push({ ...result, method: 'scan' });
        }).catch(() => {})
      );

      // Batch: 30 concurrent
      if (promises.length >= 30) {
        await Promise.allSettled(promises.splice(0, 30));
      }
    }

    await Promise.allSettled(promises);
    return results;
  }

  _getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
    return null;
  }
}

module.exports = { NASDiscovery };
