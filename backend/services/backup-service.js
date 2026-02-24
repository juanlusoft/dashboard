/**
 * Backup Service — Core backup operations and device management
 * Single Responsibility: Backup logic, version management, retention
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getData, saveData } = require('../utils/data');
const { logSecurityEvent } = require('../utils/security');
const {
  getSSHCommand,
  getDeviceDir,
  getDirSize,
  notifyBackupFailure,
  BACKUP_BASE,
} = require('../utils/backup-helpers');

// ── Version Management ──

/**
 * List all backup versions for a device
 * @param {string} deviceId Device ID
 * @returns {string[]} Version names (v1, v2, ...)
 */
function getVersions(deviceId) {
  const dir = getDeviceDir(deviceId);
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs.readdirSync(dir)
    .filter((d) => {
      const fullPath = path.join(dir, d);
      return d.startsWith('v') && fs.statSync(fullPath).isDirectory();
    })
    .sort((a, b) => {
      const na = parseInt(a.slice(1));
      const nb = parseInt(b.slice(1));
      return na - nb;
    });
}

/**
 * Get next version number for a device
 * @param {string} deviceId Device ID
 * @returns {number} Next version number
 */
function nextVersion(deviceId) {
  const versions = getVersions(deviceId);
  if (versions.length === 0) {
    return 1;
  }

  return parseInt(versions[versions.length - 1].slice(1)) + 1;
}

/**
 * Enforce retention policy by deleting oldest versions
 * @param {string} deviceId Device ID
 * @param {number} retention Keep this many versions
 */
function enforceRetention(deviceId, retention) {
  const versions = getVersions(deviceId);
  const toDelete = versions.slice(0, Math.max(0, versions.length - retention));

  for (const v of toDelete) {
    const vPath = path.join(getDeviceDir(deviceId), v);
    try {
      fs.rmSync(vPath, { recursive: true, force: true });
    } catch (e) {
      console.error(`Failed to delete old version ${v}:`, e.message);
    }
  }

  // Update 'latest' symlink
  const remaining = getVersions(deviceId);
  const latestLink = path.join(getDeviceDir(deviceId), 'latest');

  try {
    fs.unlinkSync(latestLink);
  } catch (e) {
    // Latest link doesn't exist yet
  }

  if (remaining.length > 0) {
    fs.symlinkSync(remaining[remaining.length - 1], latestLink);
  }
}

// ── Backup Execution ──

// Track running backups (deviceId → { startedAt, output })
const runningBackups = new Map();

/**
 * Run backup for a device with rsync (file-based) or agent (image-based)
 * @param {object} device Device configuration
 */
async function runBackup(device) {
  const startTime = Date.now();
  const backupState = {
    startedAt: new Date().toISOString(),
    output: '',
  };

  runningBackups.set(device.id, backupState);

  try {
    const dir = getDeviceDir(device.id);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // For agent-based backups, skip rsync (agent handles it)
    if (device.agentToken) {
      await runLocalBackupSetup(device, dir, backupState);
    } else {
      // Direct rsync-based backup
      await runRsyncBackup(device, dir, backupState);
    }

    // Success
    const duration = Math.round((Date.now() - startTime) / 1000);
    updateDeviceStatus(device.id, {
      lastBackup: new Date().toISOString(),
      lastResult: 'success',
      lastError: null,
      lastDuration: duration,
    });

    enforceRetention(device.id, device.retention || 5);

    // Update latest symlink
    const vNum = nextVersion(device.id) - 1; // We already incremented
    const latestLink = path.join(getDeviceDir(device.id), 'latest');
    try {
      fs.unlinkSync(latestLink);
    } catch (e) {
      // Doesn't exist
    }
    fs.symlinkSync(`v${vNum}`, latestLink);

    logSecurityEvent('active_backup_success', 'system', {
      device: device.name,
      version: vNum,
      duration,
    });
  } catch (err) {
    console.error(`Backup failed for ${device.name}:`, err.message);

    // Clean up failed version directory
    const versions = getVersions(device.id);
    if (versions.length > 0) {
      const lastV = versions[versions.length - 1];
      const vPath = path.join(getDeviceDir(device.id), lastV);
      try {
        fs.rmSync(vPath, { recursive: true, force: true });
      } catch (e) {
        // Already cleaned up
      }
    }

    const duration = Math.round((Date.now() - startTime) / 1000);
    updateDeviceStatus(device.id, {
      lastBackup: new Date().toISOString(),
      lastResult: 'failed',
      lastError: err.message.slice(0, 500),
      lastDuration: duration,
    });

    // Notify failure
    await notifyBackupFailure(device, err.message.slice(0, 200));

    logSecurityEvent('active_backup_failed', 'system', {
      device: device.name,
      error: err.message.slice(0, 200),
    });
  } finally {
    runningBackups.delete(device.id);
  }
}

/**
 * Run rsync backup from remote device
 * Splits work path into separate function: buildRsyncArgs, executeRsyncCommand
 * @private
 */
async function runRsyncBackup(device, dir, backupState) {
  const vNum = nextVersion(device.id);
  const vDir = path.join(dir, `v${vNum}`);
  const versions = getVersions(device.id);
  const prevDir = versions.length > 0
    ? path.join(dir, versions[versions.length - 1])
    : null;

  // Run rsync for each path
  for (const srcPath of device.paths) {
    const args = buildRsyncArgs({
      srcPath,
      device,
      vDir,
      prevDir,
      excludes: device.excludes || [],
    });

    const destSub = path.join(vDir, srcPath);
    if (!fs.existsSync(destSub)) {
      fs.mkdirSync(destSub, { recursive: true });
    }

    await executeRsyncCommand(args, backupState);
  }
}

/**
 * Build rsync command arguments
 * @private
 */
function buildRsyncArgs({ srcPath, device, vDir, prevDir, excludes }) {
  const sshCmd = getSSHCommand(device.sshPort || 22);
  const args = ['-az', '--delete', '--stats', '-e', sshCmd];

  // Hardlink to previous version for space efficiency
  if (prevDir) {
    args.push(`--link-dest=${prevDir}`);
  }

  // Add excludes
  for (const exc of excludes) {
    args.push(`--exclude=${exc}`);
  }

  const remoteSrc = `${device.sshUser}@${device.ip}:${srcPath}/`;
  const destSub = path.join(vDir, srcPath);

  args.push(remoteSrc, `${destSub}/`);
  return args;
}

/**
 * Execute rsync process and track output
 * @private
 */
async function executeRsyncCommand(args, backupState) {
  return new Promise((resolve, reject) => {
    const proc = spawn('rsync', args);

    proc.stdout.on('data', (chunk) => {
      backupState.output += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      backupState.output += chunk.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(
          `rsync exited with code ${code}\n${backupState.output.slice(-500)}`,
        ));
      }
    });

    proc.on('error', reject);
  });
}

/**
 * Setup local backup directory (for agent-based backups)
 * @private
 */
async function runLocalBackupSetup(device, dir, backupState) {
  // Agent handles the backup; we just ensure directory structure
  const vNum = nextVersion(device.id);
  const vDir = path.join(dir, `v${vNum}`);

  if (!fs.existsSync(vDir)) {
    fs.mkdirSync(vDir, { recursive: true });
  }

  backupState.output = `Agent backup initialized for version ${vNum}`;
}

// ── Device Status ──

/**
 * Update device status after backup attempt
 * @param {string} deviceId Device ID
 * @param {object} updates Status fields to update
 */
function updateDeviceStatus(deviceId, updates) {
  const data = getData();
  if (!data.activeBackup) {
    return;
  }

  const device = data.activeBackup.devices.find((d) => d.id === deviceId);
  if (!device) {
    return;
  }

  Object.assign(device, updates);
  saveData(data);
}

/**
 * Get backup status for a device
 * @param {string} deviceId Device ID
 * @returns {object} Status object
 */
function getBackupStatus(deviceId) {
  const running = runningBackups.get(deviceId);
  if (running) {
    return {
      status: 'running',
      startedAt: running.startedAt,
      output: running.output.slice(-2000),
    };
  }

  const data = getData();
  if (!data.activeBackup) {
    return { status: 'idle' };
  }

  const device = data.activeBackup.devices.find((d) => d.id === deviceId);
  if (!device) {
    return null;
  }

  return {
    status: 'idle',
    lastBackup: device.lastBackup,
    lastResult: device.lastResult,
    lastError: device.lastError,
    lastDuration: device.lastDuration,
  };
}

/**
 * Check if a backup is currently running
 * @param {string} deviceId Device ID
 * @returns {boolean}
 */
function isBackupRunning(deviceId) {
  return runningBackups.has(deviceId);
}

// ── Image Backup Files ──

/**
 * List image backup files for a device
 * @param {string} deviceId Device ID
 * @returns {object[]} List of image files
 */
function getImageFiles(deviceId) {
  const dir = getDeviceDir(deviceId);
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs.readdirSync(dir)
    .filter((f) => {
      const ext = f.toLowerCase();
      return (
        ext.endsWith('.vhd')
        || ext.endsWith('.vhdx')
        || ext.endsWith('.img')
        || ext.endsWith('.img.gz')
        || ext.endsWith('.pcl.gz')
        || ext.endsWith('.xml')
        || f === 'WindowsImageBackup'
        || f.startsWith('backup-')
      );
    })
    .map((f) => {
      const fPath = path.join(dir, f);
      const stat = fs.statSync(fPath);
      return {
        name: f,
        size: stat.isDirectory() ? getDirSize(fPath) : stat.size,
        modified: stat.mtime,
        type: stat.isDirectory() ? 'directory' : 'file',
      };
    })
    .sort((a, b) => new Date(b.modified) - new Date(a.modified));
}

// ── Cron Parsing ──

/**
 * Parse simple cron expression (M H * * *)
 * @param {string} cronExpr Cron expression
 * @returns {object|null} { hour, minute } or null if invalid
 */
function parseCronExpression(cronExpr) {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 5) {
    return null;
  }

  const minute = parseInt(parts[0]);
  const hour = parseInt(parts[1]);

  if (isNaN(minute) || isNaN(hour)) {
    return null;
  }

  return { hour, minute };
}

module.exports = {
  getVersions,
  nextVersion,
  enforceRetention,
  runBackup,
  updateDeviceStatus,
  getBackupStatus,
  isBackupRunning,
  getImageFiles,
  parseCronExpression,
  runningBackups,
};
