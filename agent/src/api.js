/**
 * NAS API Client - Communicate with HomePiNAS backend
 *
 * SECURITY: Uses custom CA certificate for self-signed cert validation.
 * Falls back to TOFU (trust-on-first-use) fingerprint pinning if no CA cert is available.
 */

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Store = require('electron-store');

// Persistent store for TOFU certificate fingerprints
const store = new Store({ encryptionKey: 'homepinas-agent-store-v2' });

/**
 * Get the SHA-256 fingerprint of a TLS peer certificate.
 * @param {import('tls').TLSSocket} socket
 * @returns {string|null}
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
 * Returns true if trusted, false on mismatch.
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
    store.set(storeKey, fingerprint);
    console.info(`[NASApi TOFU] Trusted and saved certificate for ${host}: ${fingerprint}`);
    return true;
  }

  if (saved === fingerprint) {
    return true;
  }

  console.error(`[NASApi TOFU] Certificate mismatch for ${host}! Expected ${saved}, got ${fingerprint}`);
  return false;
}

class NASApi {
  constructor(options = {}) {
    this._pinnedFingerprint = options.pinnedFingerprint || null;
    this._caPath = options.caPath || path.join(__dirname, '..', 'config', 'nas-ca.pem');

    // Try to load the NAS CA certificate for proper validation
    let ca = null;
    try {
      if (fs.existsSync(this._caPath)) {
        ca = fs.readFileSync(this._caPath);
      }
    } catch (e) {
      console.warn('Could not load NAS CA certificate:', e.message);
    }

    if (ca) {
      // Validate against the NAS's own CA
      this.agent = new https.Agent({ ca, rejectUnauthorized: true });
      this._caLoaded = true;
    } else {
      // Self-signed cert: disable native verification, use TOFU instead
      this.agent = new https.Agent({ rejectUnauthorized: false });
      this._caLoaded = false;
      console.warn('[NASApi] No CA cert found — using TOFU fingerprint pinning for self-signed certs');
    }
  }

  setPinnedFingerprint(fingerprint) {
    this._pinnedFingerprint = fingerprint;
  }

  _request(method, address, port, reqPath, headers = {}, body = null) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: address,
        port,
        path: `/api${reqPath}`,
        method,
        agent: this.agent,
        timeout: 120000,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
      };

      const req = https.request(options, (res) => {
        // TOFU fingerprint verification for self-signed certs (when no CA cert is loaded)
        if (!this._caLoaded && res.socket) {
          if (!verifyTOFU(address, res.socket)) {
            req.destroy();
            return reject(new Error('TLS certificate fingerprint mismatch — possible MITM attack'));
          }
        }

        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode >= 400) {
              reject(new Error(json.error || `HTTP ${res.statusCode}`));
            } else {
              resolve(json);
            }
          } catch (e) {
            reject(new Error(`Invalid response from NAS`));
          }
        });
      });

      req.on('error', (err) => reject(new Error(`Connection failed: ${err.message}`)));
      req.on('timeout', () => { req.destroy(); reject(new Error('Connection timeout')); });

      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  async testConnection(address, port) {
    return this._request('GET', address, port, '/system/stats');
  }

  async authenticate(address, port, username, password) {
    return this._request('POST', address, port, '/login', {}, { username, password });
  }

  async agentRegister(address, port, deviceInfo) {
    return this._request('POST', address, port, '/active-backup/agent/register', {}, deviceInfo);
  }

  async agentPoll(address, port, agentToken) {
    return this._request('GET', address, port, '/active-backup/agent/poll', { 'X-Agent-Token': agentToken });
  }

  async agentReport(address, port, agentToken, result) {
    return this._request('POST', address, port, '/active-backup/agent/report', { 'X-Agent-Token': agentToken }, result);
  }
}

module.exports = { NASApi };
