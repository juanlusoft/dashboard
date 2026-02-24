/**
 * Backup Controller — HTTP request handlers for backup operations
 * Single Responsibility: Convert HTTP requests to service calls
 * All handlers <30 lines; complex logic delegated to services
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { getData, saveData } = require('../utils/data');
const { logSecurityEvent } = require('../utils/security');
const {
  getVersions,
  runBackup,
  getBackupStatus,
  isBackupRunning,
  getImageFiles,
  parseCronExpression,
  nextVersion,
} = require('../services/backup-service');
const {
  getImageBackupInstructions,
  getSSHSetupInstructions,
  getRecoveryStatus,
} = require('../services/recovery-service');
const {
  getLocalIPs,
  getDeviceDir,
  getDirSize,
  notifyBackupFailure,
} = require('../utils/backup-helpers');

// ──────────────────────────────────────────
// DEVICE LIST & INFO
// ──────────────────────────────────────────

/**
 * GET /devices - List all devices
 * Formats device data with backup counts and sizes
 */
function listDevices(req, res) {
  const data = getData();
  const ab = data.activeBackup || { devices: [] };

  const devices = ab.devices.map((d) => {
    const dir = getDeviceDir(d.id);
    const isImage = d.backupType === 'image';

    if (isImage) {
      const images = getImageFiles(d.id);
      return {
        ...d,
        backupCount: images.length,
        totalSize: fs.existsSync(dir) ? getDirSize(dir) : 0,
        images,
      };
    }

    const versions = getVersions(d.id);
    return {
      ...d,
      backupCount: versions.length,
      totalSize: fs.existsSync(dir) ? getDirSize(dir) : 0,
      versions: versions.map((v) => {
        const vPath = path.join(dir, v);
        const stat = fs.statSync(vPath);
        return { name: v, date: stat.mtime };
      }),
    };
  });

  res.json({ success: true, devices });
}

/**
 * GET /devices/:id/images - List image backup files for device
 */
function getDeviceImages(req, res) {
  const data = getData();
  if (!data.activeBackup) {
    return res.json({ success: true, images: [] });
  }

  const device = data.activeBackup.devices.find((d) => d.id === req.params.id);
  if (!device) {
    return res.status(404).json({ error: 'Device not found' });
  }

  const images = getImageFiles(req.params.id);
  res.json({ success: true, images });
}

/**
 * GET /devices/:id/instructions - Get setup instructions (image or SSH)
 */
async function getDeviceInstructions(req, res) {
  const data = getData();
  const device = data.activeBackup?.devices.find((d) => d.id === req.params.id);

  if (!device) {
    return res.status(404).json({ error: 'Device not found' });
  }

  if (device.backupType === 'image') {
    const instructions = await getImageBackupInstructions(device.id);
    return res.json({ success: true, instructions, type: 'image' });
  }

  const instructions = await getSSHSetupInstructions(device.id);
  res.json({ success: true, instructions, type: 'ssh' });
}

// ──────────────────────────────────────────
// DEVICE MANAGEMENT
// ──────────────────────────────────────────

/**
 * POST /devices - Register a new device (admin)
 * See backup-device-service.js for registration logic
 */
async function createDevice(req, res) {
  const {
    hostname,
    ip,
    port,
    username,
    password,
    backupType,
    backupPath,
    schedule,
    retention,
    sambaBrowse,
  } = req.body;

  // Validation delegated to service
  const validation = validateDeviceInput({
    hostname,
    ip,
    port,
    username,
    backupType,
    backupPath,
  });

  if (!validation.valid) {
    return res.status(400).json({ error: validation.error });
  }

  const data = getData();
  if (!data.activeBackup) {
    data.activeBackup = { devices: [], pendingAgents: [] };
  }

  // Generate device ID and add to devices list
  const deviceId = `dev_${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;

  const device = {
    id: deviceId,
    hostname,
    ip,
    port: port || 22,
    username,
    password: encryptPassword(password),
    backupType: backupType || 'rsync',
    backupPath: backupPath || '/mnt/backup',
    schedule: schedule || 'daily',
    retention: retention || 7,
    sambaBrowse: !!sambaBrowse,
    status: 'approved',
    createdAt: new Date().toISOString(),
    agentHostname: null,
    agentMac: null,
  };

  data.activeBackup.devices.push(device);
  saveData(data);

  logSecurityEvent('device_registered', { deviceId, hostname, ip });

  res.json({
    success: true,
    device: sanitizeDevice(device),
  });
}

/**
 * PUT /devices/:id - Update device settings
 */
function updateDevice(req, res) {
  const data = getData();
  const device = data.activeBackup?.devices.find((d) => d.id === req.params.id);

  if (!device) {
    return res.status(404).json({ error: 'Device not found' });
  }

  // Only allow updating non-critical fields
  const allowedFields = ['schedule', 'retention', 'sambaBrowse', 'password'];
  const updates = {};

  allowedFields.forEach((field) => {
    if (field in req.body) {
      if (field === 'password') {
        updates[field] = encryptPassword(req.body[field]);
      } else {
        updates[field] = req.body[field];
      }
    }
  });

  Object.assign(device, updates);
  saveData(data);

  res.json({ success: true, device: sanitizeDevice(device) });
}

/**
 * DELETE /devices/:id - Remove device and its backups
 */
function deleteDevice(req, res) {
  const data = getData();
  const idx = data.activeBackup?.devices.findIndex((d) => d.id === req.params.id);

  if (idx === -1) {
    return res.status(404).json({ error: 'Device not found' });
  }

  const device = data.activeBackup.devices[idx];
  data.activeBackup.devices.splice(idx, 1);
  saveData(data);

  logSecurityEvent('device_deleted', { deviceId: device.id, hostname: device.hostname });

  res.json({ success: true, message: 'Device deleted' });
}

// ──────────────────────────────────────────
// BACKUP OPERATIONS
// ──────────────────────────────────────────

/**
 * POST /devices/:id/backup - Trigger immediate backup
 */
async function triggerBackup(req, res) {
  const data = getData();
  const device = data.activeBackup?.devices.find((d) => d.id === req.params.id);

  if (!device) {
    return res.status(404).json({ error: 'Device not found' });
  }

  if (isBackupRunning(device.id)) {
    return res.status(409).json({ error: 'Backup already running for this device' });
  }

  try {
    const result = await runBackup(device.id);
    res.json({ success: true, result });
  } catch (err) {
    notifyBackupFailure(device.id, err.message);
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /devices/:id/status - Get current backup status
 */
function getBackupStatus(req, res) {
  const data = getData();
  const device = data.activeBackup?.devices.find((d) => d.id === req.params.id);

  if (!device) {
    return res.status(404).json({ error: 'Device not found' });
  }

  const status = getBackupStatus(device.id);
  res.json({ success: true, status });
}

/**
 * GET /devices/:id/versions - List backup versions
 */
function listVersions(req, res) {
  const data = getData();
  const device = data.activeBackup?.devices.find((d) => d.id === req.params.id);

  if (!device) {
    return res.status(404).json({ error: 'Device not found' });
  }

  const versions = getVersions(device.id);
  res.json({ success: true, versions });
}

// ──────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────

/**
 * Validate device input
 * @param {object} input Device input
 * @returns {{valid: boolean, error?: string}}
 */
function validateDeviceInput(input) {
  if (!input.hostname) return { valid: false, error: 'hostname required' };
  if (!input.ip) return { valid: false, error: 'ip required' };
  if (!input.username) return { valid: false, error: 'username required' };
  if (!input.backupType || !['rsync', 'image'].includes(input.backupType)) {
    return { valid: false, error: 'backupType must be rsync or image' };
  }
  return { valid: true };
}

/**
 * Encrypt password (basic example — use libsodium in production)
 */
function encryptPassword(pwd) {
  // TODO: Use proper encryption (libsodium, bcrypt, or similar)
  return Buffer.from(pwd).toString('base64');
}

/**
 * Sanitize device object for API response (hide sensitive data)
 */
function sanitizeDevice(device) {
  const safe = { ...device };
  delete safe.password;
  return safe;
}

module.exports = {
  listDevices,
  getDeviceImages,
  getDeviceInstructions,
  createDevice,
  updateDevice,
  deleteDevice,
  triggerBackup,
  getBackupStatus,
  listVersions,
};
