/**
 * NAS Discovery - Find HomePiNAS on the local network
 * Identifies HomePiNAS by checking for _sig:'hnv2' in /api/system/status
 */

const https = require('https');
const crypto = require('crypto');
const os = require('os');
const Store = require('electron-store');

// Persistent store for TOFU certificate fingerprints
const store = new Store({ encryptionKey: 'homepinas-agent-store-v2' });

/**
 * Get the SHA-256 fingerprint of a TLS peer certificate.
 * @param {import('tls').TLSSocket} socket
 * @returns {string|null} hex fingerprint or null
 */
function getCertFingerprint(socket) {
  try {
    const cert = socket.getPeerCertificate();
    if (!cert || !cert.raw) return null;
    return crypto.createHash('sha256').update(cert.raw).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Verify or record the TOFU fingerprint for a given host.
 * Returns true if the connection is trusted, false if fingerprint mismatch.
 * @param {string} host
 * @param {import('tls').TLSSocket} socket
 * @returns {boolean}
 */
function verifyTOFU(host, socket) {
  const fingerprint = getCertFingerprint(socket);
  if (!fingerprint) return false;

  const storeKey = `tofu_fingerprint_${host}`;
  const saved = store.get(storeKey);

  if (!saved) {
    // First connection: trust and save
    store.set(storeKey, fingerprint);
    console.info(`[TOFU] Trusted and saved certificate for ${host}: ${fingerprint}`);
    return true;
  }

  if (saved === fingerprint) {
    return true;
  }

  // Fingerprint mismatch — possible MITM
  console.error(`[TOFU] Certificate mismatch for ${host}! Expected ${saved}, got ${fingerprint}`);
  return false;
}

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
      // TOFU: accept self-signed certs but verify/pin fingerprint
      const agent = new https.Agent({
        rejectUnauthorized: false,
        checkServerIdentity: (hostname, cert) => {
          // Actual TOFU check happens after connection via socket event below
          return undefined;
        },
      });
      const req = https.get({
        hostname: host,
        port,
        path: '/api/system/status',
        timeout: this.timeout,
        agent,
      }, (res) => {
        // TOFU verification: check fingerprint once socket is available
        if (res.socket) {
          if (!verifyTOFU(host, res.socket)) {
            req.destroy();
            return resolve(null);
          }
        }

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
                method: 'scan',
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
