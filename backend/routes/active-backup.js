/**
 * HomePiNAS v2 - Active Backup for Business (ABB)
 * Routes for backup device management, backup operations, and recovery
 *
 * This file: Route handlers only (HTTP layer)
 * Delegates to: backup-service, recovery-service, backup-helpers
 */

const express = require('express');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');

const { requireAuth } = require('../middleware/auth');
const { logSecurityEvent } = require('../utils/security');
const { getData, saveData } = require('../utils/data');

// Services
const {
  getVersions,
  runBackup,
  getBackupStatus,
  isBackupRunning,
  getImageFiles,
  parseCronExpression,
  runningBackups,
} = require('../services/backup-service');

const {
  getImageBackupInstructions,
  getSSHSetupInstructions,
  getRecoveryStatus,
  getRecoveryISOPath,
  getRecoveryScriptsDir,
  getRecoveryBuildScript,
} = require('../services/recovery-service');

const {
  ensureSSHKey,
  ensureSambaUser,
  createImageBackupShare,
  getLocalIPs,
  getDeviceDir,
  getDirSize,
  notifyBackupFailure,
  ensureBackupBase,
} = require('../utils/backup-helpers');

const router = express.Router();

ensureBackupBase();

// ══════════════════════════════════════════
// AGENT ENDPOINTS (no auth — use agentToken)
// ══════════════════════════════════════════

/**
 * POST /agent/register - Agent announces itself
 * No auth required (agentToken is assigned here)
 */
router.post('/agent/register', (req, res) => {
  const { hostname, ip, os: agentOS, mac } = req.body;

  if (!hostname) {
    return res.status(400).json({ error: 'hostname is required' });
  }

  const data = getData();
  if (!data.activeBackup) {
    data.activeBackup = { devices: [], pendingAgents: [] };
  }
  if (!data.activeBackup.pendingAgents) {
    data.activeBackup.pendingAgents = [];
  }

  // Check if already registered
  const existing = data.activeBackup.devices.find(
    (d) => d.agentMac === mac || (d.agentHostname === hostname && d.ip === ip),
  );

  if (existing) {
    return res.json({
      success: true,
      agentId: existing.id,
      agentToken: existing.agentToken,
      status: existing.status || 'approved',
    });
  }

  // Check if pending
  const pending = data.activeBackup.pendingAgents.find(
    (a) => a.mac === mac || (a.hostname === hostname && a.ip === ip),
  );

  if (pending) {
    return res.json({
      success: true,
      agentId: pending.id,
      agentToken: pending.agentToken,
      status: 'pending',
    });
  }

  // New agent
  const agentId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const agentToken = crypto.randomBytes(32).toString('hex');

  const agent = {
    id: agentId,
    agentToken,
    hostname,
    ip: ip || req.ip,
    os: agentOS || 'unknown',
    mac: mac || null,
    registeredAt: new Date().toISOString(),
  };

  data.activeBackup.pendingAgents.push(agent);
  saveData(data);

  console.log(`[Active Backup] New agent registered: ${hostname} (${ip || req.ip})`);

  res.json({
    success: true,
    agentId,
    agentToken,
    status: 'pending',
  });
});

/**
 * GET /agent/poll - Agent checks for config and tasks
 * Auth via X-Agent-Token header
 */
router.get('/agent/poll', (req, res) => {
  const token = req.headers['x-agent-token'];
  if (!token) {
    return res.status(401).json({ error: 'Missing agent token' });
  }

  const data = getData();
  if (!data.activeBackup) {
    return res.status(404).json({ error: 'Not configured' });
  }

  // Check if still pending
  const pending = (data.activeBackup.pendingAgents || []).find((a) => a.agentToken === token);
  if (pending) {
    return res.json({
      status: 'pending',
      message: 'Esperando aprobación del administrador',
    });
  }

  // Check approved device
  const device = data.activeBackup.devices.find((d) => d.agentToken === token);
  if (!device) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  // Build config response
  const response = {
    status: 'approved',
    config: {
      deviceId: device.id,
      deviceName: device.name,
      backupType: device.backupType,
      schedule: device.schedule,
      retention: device.retention,
      paths: device.paths || [],
      enabled: device.enabled,
    },
    lastBackup: device.lastBackup,
    lastResult: device.lastResult,
  };

  // Add Samba config for image backups
  if (device.backupType === 'image' && device.sambaShare) {
    response.config.sambaShare = device.sambaShare;
    response.config.nasAddress = getLocalIPs()[0] || req.hostname;

    // Send credentials only once
    if (!device._credentialsSent) {
      response.config.sambaUser = device.sambaUser || '';
      response.config.sambaPass = device.sambaPass || '';
      device._credentialsSent = true;
      saveData(data);
    }
  }

  // Check for pending manual trigger
  if (device._triggerBackup) {
    response.action = 'backup';
    device._triggerBackup = false;
    saveData(data);
  }

  res.json(response);
});

/**
 * POST /agent/report - Agent reports backup result
 * Auth via X-Agent-Token header
 */
router.post('/agent/report', (req, res) => {
  const token = req.headers['x-agent-token'];
  if (!token) {
    return res.status(401).json({ error: 'Missing agent token' });
  }

  const { status, duration, error: errorMsg } = req.body;

  const data = getData();
  if (!data.activeBackup) {
    return res.status(404).json({ error: 'Not configured' });
  }

  const device = data.activeBackup.devices.find((d) => d.agentToken === token);
  if (!device) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  device.lastBackup = new Date().toISOString();
  device.lastResult = status === 'success' ? 'success' : 'failed';
  device.lastError = status === 'success' ? null : errorMsg || 'Unknown error';
  device.lastDuration = duration || null;

  saveData(data);

  if (status !== 'success') {
    notifyBackupFailure(device, errorMsg || 'Unknown error');
  }

  logSecurityEvent(`active_backup_agent_${status}`, 'agent', {
    device: device.name,
    duration,
  });

  res.json({ success: true });
});

// All remaining routes require auth
router.use(requireAuth);

// ══════════════════════════════════════════
// DEVICE MANAGEMENT
// ══════════════════════════════════════════

/**
 * GET /devices - List all devices with backup status
 */
router.get('/devices', (req, res) => {
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
});

/**
 * GET /devices/:id/images - List image files for device
 */
router.get('/devices/:id/images', (req, res) => {
  const data = getData();
  if (!data.activeBackup) {
    return res.json({ success: true, images: [] });
  }

  const device = data.activeBackup.devices.find((d) => d.id === req.params.id);
  if (!device) {
    return res.status(404).json({ error: 'Device not found' });
  }

  const images = getImageFiles(device.id);
  const dir = getDeviceDir(device.id);

  // List Windows image backups
  const wibPath = path.join(dir, 'WindowsImageBackup');
  let windowsBackups = [];
  if (fs.existsSync(wibPath)) {
    try {
      windowsBackups = fs.readdirSync(wibPath, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => {
          const bPath = path.join(wibPath, d.name);
          return {
            name: d.name,
            size: getDirSize(bPath),
            modified: fs.statSync(bPath).mtime,
            type: 'windows-image',
          };
        });
    } catch (e) {
      // Ignore read errors
    }
  }

  res.json({
    success: true,
    images,
    windowsBackups,
    totalSize: getDirSize(dir),
  });
});

/**
 * GET /devices/:id/instructions - Setup instructions for device
 */
router.get('/devices/:id/instructions', async (req, res) => {
  const data = getData();
  if (!data.activeBackup) {
    return res.status(404).json({ error: 'No devices' });
  }

  const device = data.activeBackup.devices.find((d) => d.id === req.params.id);
  if (!device) {
    return res.status(404).json({ error: 'Device not found' });
  }

  if (device.backupType === 'image') {
    const nasHostname = require('os').hostname();
    const uncPath = `\\\\${nasHostname}\\${device.sambaShare}`;
    const instructions = getImageBackupInstructions(device, uncPath, nasHostname);
    return res.json({ success: true, instructions });
  }

  // File backup SSH instructions
  const pubKey = await ensureSSHKey();
  res.json({
    success: true,
    sshPublicKey: pubKey,
    instructions: getSSHSetupInstructions(pubKey),
  });
});

/**
 * POST /devices - Register new device for backup
 */
router.post('/devices', async (req, res) => {
  try {
    const { name, ip, sshUser, sshPort, paths, excludes, schedule, retention, backupType, os: deviceOS, password } = req.body;

    const isImage = backupType === 'image';

    if (!name || !ip) {
      return res.status(400).json({ error: 'name and ip are required' });
    }

    if (!isImage && !sshUser) {
      return res.status(400).json({ error: 'sshUser required for file backups' });
    }

    let pubKey = null;
    if (!isImage) {
      pubKey = await ensureSSHKey();
    }

    const deviceId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

    const device = {
      id: deviceId,
      name: name.trim(),
      ip: ip.trim(),
      backupType: isImage ? 'image' : 'files',
      os: deviceOS || (isImage ? 'windows' : 'linux'),
      sshUser: sshUser ? sshUser.trim() : '',
      sshPort: parseInt(sshPort) || 22,
      paths: paths || (isImage ? [] : ['/home']),
      excludes: excludes || ['.cache', '*.tmp', 'node_modules', '.Trash*', '.local/share/Trash'],
      schedule: schedule || '0 2 * * *',
      retention: parseInt(retention) || 5,
      enabled: true,
      registeredAt: new Date().toISOString(),
      lastBackup: null,
      lastResult: null,
      lastError: null,
      lastDuration: null,
      sambaShare: isImage ? `backup-${deviceId.slice(0, 8)}` : null,
    };

    const data = getData();
    if (!data.activeBackup) {
      data.activeBackup = { devices: [] };
    }

    data.activeBackup.devices.push(device);
    saveData(data);

    // Create device backup directory
    const dir = getDeviceDir(deviceId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Setup for image backups
    let sambaSetup = null;
    if (isImage) {
      try {
        if (password) {
          await ensureSambaUser(req.user.username, password);
        }
        await createImageBackupShare(device, req.user.username);

        const nasHostname = require('os').hostname();
        const shareName = device.sambaShare;
        const uncPath = `\\\\${device.ip === '127.0.0.1' ? 'localhost' : nasHostname}\\${shareName}`;

        sambaSetup = {
          sharePath: uncPath,
          shareUser: req.user.username,
          instructions: getImageBackupInstructions(device, uncPath, nasHostname),
        };
      } catch (sambaErr) {
        console.error('Failed to create Samba share:', sambaErr.message);
      }
    }

    logSecurityEvent('active_backup_device_added', req.user.username, {
      device: name,
      ip,
      type: device.backupType,
    });

    const response = { success: true, device };
    if (isImage) {
      response.sambaSetup = sambaSetup;
    } else {
      response.sshPublicKey = pubKey;
      response.setupInstructions = `En "${name}" (${ip}), ejecuta:\n\nmkdir -p ~/.ssh && echo '${pubKey}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`;
    }

    res.json(response);
  } catch (err) {
    console.error('Add device error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /devices/:id - Update device configuration
 */
router.put('/devices/:id', (req, res) => {
  const data = getData();
  if (!data.activeBackup) {
    return res.status(404).json({ error: 'No devices configured' });
  }

  const idx = data.activeBackup.devices.findIndex((d) => d.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ error: 'Device not found' });
  }

  const allowed = ['name', 'ip', 'sshUser', 'sshPort', 'paths', 'excludes', 'schedule', 'retention', 'enabled', 'os'];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      data.activeBackup.devices[idx][key] = req.body[key];
    }
  }

  saveData(data);
  res.json({ success: true, device: data.activeBackup.devices[idx] });
});

/**
 * DELETE /devices/:id - Remove device and optionally delete backups
 */
router.delete('/devices/:id', (req, res) => {
  const data = getData();
  if (!data.activeBackup) {
    return res.status(404).json({ error: 'No devices configured' });
  }

  const idx = data.activeBackup.devices.findIndex((d) => d.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ error: 'Device not found' });
  }

  const device = data.activeBackup.devices[idx];
  data.activeBackup.devices.splice(idx, 1);
  saveData(data);

  if (req.query.deleteData === 'true') {
    const dir = getDeviceDir(req.params.id);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  logSecurityEvent('active_backup_device_removed', req.user.username, {
    device: device.name,
  });

  res.json({ success: true, message: `Device "${device.name}" removed` });
});

/**
 * GET /ssh-key - Get NAS public SSH key
 */
router.get('/ssh-key', async (req, res) => {
  try {
    const pubKey = await ensureSSHKey();
    res.json({ success: true, publicKey: pubKey });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate SSH key' });
  }
});

// ══════════════════════════════════════════
// BACKUP OPERATIONS
// ══════════════════════════════════════════

/**
 * POST /devices/:id/backup - Trigger manual backup
 */
router.post('/devices/:id/backup', async (req, res) => {
  const data = getData();
  if (!data.activeBackup) {
    return res.status(404).json({ error: 'No devices configured' });
  }

  const device = data.activeBackup.devices.find((d) => d.id === req.params.id);
  if (!device) {
    return res.status(404).json({ error: 'Device not found' });
  }

  if (isBackupRunning(device.id)) {
    return res.status(409).json({ error: 'Backup already in progress for this device' });
  }

  res.json({ success: true, message: `Backup started for "${device.name}"` });
  runBackup(device);
});

/**
 * GET /devices/:id/status - Get backup progress/status
 */
router.get('/devices/:id/status', (req, res) => {
  const status = getBackupStatus(req.params.id);
  if (!status) {
    return res.status(404).json({ error: 'Device not found' });
  }

  res.json({ success: true, ...status });
});

/**
 * GET /devices/:id/versions - List backup versions
 */
router.get('/devices/:id/versions', (req, res) => {
  const versions = getVersions(req.params.id);
  const dir = getDeviceDir(req.params.id);

  const result = versions.map((v) => {
    const vPath = path.join(dir, v);
    const stat = fs.statSync(vPath);
    return {
      name: v,
      date: stat.mtime,
      size: getDirSize(vPath),
    };
  });

  res.json({ success: true, versions: result });
});

/**
 * GET /devices/:id/browse - Browse files in backup version
 * Query: version, path
 */
router.get('/devices/:id/browse', (req, res) => {
  const version = req.query.version || 'latest';
  const browsePath = req.query.path || '/';

  const safe = req.params.id.replace(/[^a-zA-Z0-9_-]/g, '');
  const safeVersion = version.replace(/[^a-zA-Z0-9_.-]/g, '');

  let basePath = path.join(getDeviceDir(req.params.id), safeVersion);

  // Resolve latest symlink
  if (safeVersion === 'latest') {
    try {
      const target = fs.readlinkSync(basePath);
      basePath = path.join(getDeviceDir(req.params.id), target);
    } catch (e) {
      return res.status(404).json({ error: 'No backups available' });
    }
  }

  const cleanPath = browsePath.replace(/\0/g, '').replace(/^\/+/, '');
  const fullPath = path.resolve(basePath, cleanPath);

  // Security: verify we're inside device directory
  const deviceBase = path.resolve(getDeviceDir(req.params.id));
  if (!fullPath.startsWith(deviceBase)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  if (!fs.existsSync(fullPath)) {
    return res.status(404).json({ error: 'Path not found' });
  }

  const stat = fs.statSync(fullPath);
  if (!stat.isDirectory()) {
    return res.status(400).json({ error: 'Not a directory' });
  }

  try {
    const items = fs.readdirSync(fullPath, { withFileTypes: true })
      .map((entry) => {
        const entryPath = path.join(fullPath, entry.name);
        let size = 0;
        let modified = null;

        try {
          const s = fs.statSync(entryPath);
          size = s.size;
          modified = s.mtime;
        } catch (e) {
          // Ignore stat errors
        }

        return {
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
          size,
          modified,
        };
      })
      .sort((a, b) => {
        if (a.type === 'directory' && b.type !== 'directory') return -1;
        if (a.type !== 'directory' && b.type === 'directory') return 1;
        return a.name.localeCompare(b.name);
      });

    res.json({
      success: true,
      path: browsePath,
      version: safeVersion,
      items,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to browse directory' });
  }
});

/**
 * GET /devices/:id/download - Download file from backup
 * Query: version, path
 */
router.get('/devices/:id/download', (req, res) => {
  const version = req.query.version || 'latest';
  const filePath = req.query.path || '';

  const safe = req.params.id.replace(/[^a-zA-Z0-9_-]/g, '');
  const safeVersion = version.replace(/[^a-zA-Z0-9_.-]/g, '');

  let basePath = path.join(getDeviceDir(req.params.id), safeVersion);

  if (safeVersion === 'latest') {
    try {
      const target = fs.readlinkSync(basePath);
      basePath = path.join(getDeviceDir(req.params.id), target);
    } catch (e) {
      return res.status(404).json({ error: 'No backups available' });
    }
  }

  const cleanPath = filePath.replace(/\0/g, '').replace(/^\/+/, '');
  const fullPath = path.resolve(basePath, cleanPath);

  const deviceBase = path.resolve(getDeviceDir(req.params.id));
  if (!fullPath.startsWith(deviceBase)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
    return res.status(404).json({ error: 'File not found' });
  }

  res.download(fullPath);
});

/**
 * POST /devices/:id/restore - Restore files from backup to source device
 * Body: { version, sourcePath, destPath? }
 */
router.post('/devices/:id/restore', async (req, res) => {
  const data = getData();
  if (!data.activeBackup) {
    return res.status(404).json({ error: 'No devices' });
  }

  const device = data.activeBackup.devices.find((d) => d.id === req.params.id);
  if (!device) {
    return res.status(404).json({ error: 'Device not found' });
  }

  const { version, sourcePath, destPath } = req.body;
  if (!version || !sourcePath) {
    return res.status(400).json({ error: 'version and sourcePath required' });
  }

  const safe = device.id.replace(/[^a-zA-Z0-9_-]/g, '');
  const safeVersion = version.replace(/[^a-zA-Z0-9_.-]/g, '');
  let basePath = path.join(getDeviceDir(device.id), safeVersion);

  if (safeVersion === 'latest') {
    try {
      const target = fs.readlinkSync(basePath);
      basePath = path.join(getDeviceDir(device.id), target);
    } catch (e) {
      return res.status(404).json({ error: 'No backups available' });
    }
  }

  const cleanPath = sourcePath.replace(/\0/g, '').replace(/^\/+/, '');
  const localPath = path.resolve(basePath, cleanPath);

  const deviceBase = path.resolve(getDeviceDir(device.id));
  if (!localPath.startsWith(deviceBase)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  if (!fs.existsSync(localPath)) {
    return res.status(404).json({ error: 'Source path not found' });
  }

  const remoteDest = destPath || `/${cleanPath}`;
  const { getSSHCommand } = require('../utils/backup-helpers');
  const execFileAsync = promisify(require('child_process').execFile);

  try {
    const isDir = fs.statSync(localPath).isDirectory();
    const sshCmd = getSSHCommand(device.sshPort || 22);

    const args = [
      '-az', '--progress',
      '-e', sshCmd,
      isDir ? `${localPath}/` : localPath,
      `${device.sshUser}@${device.ip}:${remoteDest}${isDir ? '/' : ''}`,
    ];

    const { stdout } = await execFileAsync('rsync', args, { timeout: 300000 });

    logSecurityEvent('active_backup_restore', req.user.username, {
      device: device.name,
      version,
      path: sourcePath,
    });

    res.json({
      success: true,
      message: `Restored to ${device.ip}:${remoteDest}`,
      output: stdout,
    });
  } catch (err) {
    res.status(500).json({ error: `Restore failed: ${err.message}` });
  }
});

/**
 * POST /devices/:id/trigger - Trigger immediate backup (agent-based)
 */
router.post('/devices/:id/trigger', (req, res) => {
  const data = getData();
  if (!data.activeBackup) {
    return res.status(404).json({ error: 'Not configured' });
  }

  const device = data.activeBackup.devices.find((d) => d.id === req.params.id);
  if (!device) {
    return res.status(404).json({ error: 'Device not found' });
  }

  if (!device.agentToken) {
    return res.status(400).json({ error: 'Device is not agent-managed' });
  }

  device._triggerBackup = true;
  saveData(data);

  res.json({
    success: true,
    message: `Backup triggered for "${device.name}". Agent will start on next poll.`,
  });
});

/**
 * POST /devices/:id/verify - Verify backup integrity
 */
router.post('/devices/:id/verify', async (req, res) => {
  const data = getData();
  if (!data.activeBackup) {
    return res.status(404).json({ error: 'Not configured' });
  }

  const device = data.activeBackup.devices.find((d) => d.id === req.params.id);
  if (!device) {
    return res.status(404).json({ error: 'Device not found' });
  }

  const versions = getVersions(device.id);
  if (versions.length === 0) {
    return res.status(404).json({ error: 'No backups found' });
  }

  const lastVersion = versions[versions.length - 1];
  const backupPath = path.join(getDeviceDir(device.id), lastVersion);

  // Find integrity manifest
  let integrityFile = null;
  const findIntegrity = (dir) => {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.name === '.integrity.json') {
          return full;
        }
        if (e.isDirectory()) {
          const found = findIntegrity(full);
          if (found) {
            return found;
          }
        }
      }
    } catch (e) {
      // Ignore read errors
    }
    return null;
  };

  integrityFile = findIntegrity(backupPath);

  if (!integrityFile) {
    return res.json({
      valid: false,
      error: 'No integrity manifest found.',
      version: lastVersion,
    });
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(integrityFile, 'utf8'));
    const backupDir = path.dirname(integrityFile);
    const cryptoModule = require('crypto');
    const errors = [];
    let checked = 0;

    for (const [relPath, expected] of Object.entries(manifest.files || {})) {
      const filePath = path.join(backupDir, relPath);

      if (!fs.existsSync(filePath)) {
        errors.push({ file: relPath, error: 'missing' });
        continue;
      }

      const stat = fs.statSync(filePath);
      if (stat.size !== expected.size) {
        errors.push({
          file: relPath,
          error: 'size_mismatch',
          expected: expected.size,
          actual: stat.size,
        });
        continue;
      }

      // Skip hash check for large files (>500MB)
      if (stat.size >= 500 * 1024 * 1024) {
        checked++;
        continue;
      }

      // Hash verify
      const hash = cryptoModule.createHash('sha256');
      const stream = fs.createReadStream(filePath);

      const fileHash = await new Promise((resolve, reject) => {
        stream.on('data', (d) => hash.update(d));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
      });

      if (fileHash !== expected.hash) {
        errors.push({ file: relPath, error: 'hash_mismatch' });
        continue;
      }

      checked++;
    }

    res.json({
      valid: errors.length === 0,
      version: lastVersion,
      checkedFiles: checked,
      totalFiles: Object.keys(manifest.files || {}).length,
      errors: errors.slice(0, 50),
      createdAt: manifest.createdAt,
    });
  } catch (e) {
    res.status(500).json({ error: `Verification failed: ${e.message}` });
  }
});

// ══════════════════════════════════════════
// SCHEDULER
// ══════════════════════════════════════════

/**
 * Check every minute if scheduled backups should run
 */
setInterval(() => {
  const now = new Date();
  const data = getData();
  if (!data.activeBackup?.devices) {
    return;
  }

  for (const device of data.activeBackup.devices) {
    if (!device.enabled || !device.schedule) {
      continue;
    }

    if (isBackupRunning(device.id)) {
      continue;
    }

    const parsed = parseCronExpression(device.schedule);
    if (!parsed) {
      continue;
    }

    if (now.getHours() === parsed.hour && now.getMinutes() === parsed.minute) {
      console.log(`[Active Backup] Starting scheduled backup for ${device.name}`);
      runBackup(device);
    }
  }
}, 60000); // Check every 60 seconds

// ══════════════════════════════════════════
// RECOVERY USB
// ══════════════════════════════════════════

/**
 * GET /recovery/status - Check recovery ISO status
 */
router.get('/recovery/status', (req, res) => {
  const status = getRecoveryStatus();
  res.json({ success: true, ...status });
});

/**
 * POST /recovery/build - Build recovery ISO (background)
 */
router.post('/recovery/build', (req, res) => {
  const buildScript = getRecoveryBuildScript();

  if (!buildScript) {
    return res.status(404).json({ error: 'Build script not found' });
  }

  res.json({
    success: true,
    message: 'ISO build started. This will take several minutes.',
  });

  // Build in background
  const isoDir = path.dirname(buildScript);
  const proc = spawn('sudo', ['bash', buildScript], {
    cwd: isoDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  proc.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });

  proc.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

  proc.on('close', (code) => {
    if (code === 0) {
      logSecurityEvent('recovery_iso_built', 'system', { success: true });
      console.log('[Active Backup] Recovery ISO built successfully');
    } else {
      logSecurityEvent('recovery_iso_build_failed', 'system', {
        code,
        output: output.slice(-500),
      });
      console.error('[Active Backup] Recovery ISO build failed:', output.slice(-500));
    }
  });
});

/**
 * GET /recovery/download - Download recovery ISO
 */
router.get('/recovery/download', (req, res) => {
  const isoPath = getRecoveryISOPath();

  if (!isoPath) {
    return res.status(404).json({
      error: 'Recovery ISO not found. Build it first.',
    });
  }

  res.download(isoPath, 'homepinas-recovery.iso');
});

/**
 * GET /recovery/scripts - Download recovery scripts
 */
router.get('/recovery/scripts', (req, res) => {
  const scriptsDir = getRecoveryScriptsDir();

  if (!scriptsDir) {
    return res.status(404).json({ error: 'Recovery scripts not found' });
  }

  const archiveName = 'homepinas-recovery-scripts.tar.gz';
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${archiveName}"`,
  );

  const tar = spawn('tar', ['-czf', '-', '-C', path.dirname(scriptsDir), 'recovery-usb'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  tar.stdout.pipe(res);
});

// ══════════════════════════════════════════
// AGENT MANAGEMENT
// ══════════════════════════════════════════

/**
 * GET /pending - List pending agents
 */
router.get('/pending', (req, res) => {
  const data = getData();
  const pending = (data.activeBackup?.pendingAgents) || [];
  res.json({ success: true, pending });
});

/**
 * POST /pending/:id/approve - Approve pending agent
 * Body: { backupType, schedule, retention, paths }
 */
router.post('/pending/:id/approve', async (req, res) => {
  try {
    const { backupType, schedule, retention, paths } = req.body;
    const data = getData();

    if (!data.activeBackup?.pendingAgents) {
      return res.status(404).json({ error: 'No pending agents' });
    }

    const idx = data.activeBackup.pendingAgents.findIndex((a) => a.id === req.params.id);
    if (idx === -1) {
      return res.status(404).json({ error: 'Pending agent not found' });
    }

    const agent = data.activeBackup.pendingAgents[idx];
    const isImage = backupType === 'image';
    const deviceId = agent.id;

    const sambaPass = crypto.randomBytes(16).toString('hex');

    const device = {
      id: deviceId,
      name: agent.hostname,
      ip: agent.ip,
      agentHostname: agent.hostname,
      agentMac: agent.mac,
      agentToken: agent.agentToken,
      backupType: isImage ? 'image' : 'files',
      os: agent.os === 'win32' ? 'windows' : (agent.os === 'darwin' ? 'macos' : agent.os),
      sshUser: '',
      sshPort: 22,
      paths: paths || (isImage ? [] : []),
      excludes: ['.cache', '*.tmp', 'node_modules', '.Trash*', '.local/share/Trash'],
      schedule: schedule || '0 3 * * *',
      retention: parseInt(retention) || 3,
      enabled: true,
      status: 'approved',
      registeredAt: agent.registeredAt,
      approvedAt: new Date().toISOString(),
      approvedBy: req.user.username,
      lastBackup: null,
      lastResult: null,
      lastError: null,
      lastDuration: null,
      sambaShare: isImage ? `backup-${deviceId.slice(0, 8)}` : null,
      sambaUser: null,
      sambaPass: null,
    };

    // Setup for image backups
    if (isImage) {
      const sambaUser = `backup-${deviceId.slice(0, 8)}`;
      device.sambaUser = sambaUser;
      device.sambaPass = sambaPass;

      // Create system user
      const execFileAsync = promisify(require('child_process').execFile);
      try {
        await execFileAsync('sudo', ['useradd', '-r', '-s', '/usr/sbin/nologin', sambaUser]);
      } catch (e) {
        // User might exist
      }

      try {
        await execFileAsync('sudo', ['usermod', '-aG', 'sambashare', sambaUser]);
      } catch (e) {
        // Might fail
      }

      // Set Samba password
      await new Promise((resolve, reject) => {
        const proc = spawn('sudo', ['smbpasswd', '-a', sambaUser, '-s'], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        proc.on('error', reject);
        proc.on('close', (code) => {
          code === 0 ? resolve() : reject(new Error(`smbpasswd exited ${code}`));
        });
        proc.stdin.write(`${sambaPass}\n${sambaPass}\n`);
        proc.stdin.end();
      });

      await execFileAsync('sudo', ['smbpasswd', '-e', sambaUser]);

      // Create share
      await createImageBackupShare(device, sambaUser);
    }

    // Move from pending to devices
    data.activeBackup.pendingAgents.splice(idx, 1);
    if (!data.activeBackup.devices) {
      data.activeBackup.devices = [];
    }

    data.activeBackup.devices.push(device);
    saveData(data);

    logSecurityEvent('active_backup_agent_approved', req.user.username, {
      device: agent.hostname,
      ip: agent.ip,
    });

    res.json({ success: true, device });
  } catch (err) {
    console.error('Approve agent error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /pending/:id/reject - Reject pending agent
 */
router.post('/pending/:id/reject', (req, res) => {
  const data = getData();
  if (!data.activeBackup?.pendingAgents) {
    return res.status(404).json({ error: 'No pending agents' });
  }

  const idx = data.activeBackup.pendingAgents.findIndex((a) => a.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ error: 'Pending agent not found' });
  }

  const agent = data.activeBackup.pendingAgents[idx];
  data.activeBackup.pendingAgents.splice(idx, 1);
  saveData(data);

  logSecurityEvent('active_backup_agent_rejected', req.user.username, {
    hostname: agent.hostname,
  });

  res.json({ success: true, message: `Agent "${agent.hostname}" rejected` });
});

module.exports = router;
