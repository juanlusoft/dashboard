/**
 * Active Backup Helpers — Utilities for SSH keys, Samba, file operations
 * Single Responsibility: Infrastructure and OS-level operations
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const crypto = require('crypto');

const execFileAsync = promisify(execFile);

const SSH_KEY_PATH = path.join(os.homedir(), '.ssh', 'homepinas_backup_rsa');
const BACKUP_BASE = '/mnt/storage/active-backup';

// ── SSH Key Management ──

/**
 * Ensure SSH key pair exists; return public key
 * @returns {Promise<string>} Public key content
 */
async function ensureSSHKey() {
  if (fs.existsSync(SSH_KEY_PATH)) {
    return fs.readFileSync(SSH_KEY_PATH + '.pub', 'utf8').trim();
  }

  const sshDir = path.dirname(SSH_KEY_PATH);
  if (!fs.existsSync(sshDir)) {
    fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  }

  await execFileAsync('ssh-keygen', [
    '-t', 'rsa', '-b', '4096',
    '-f', SSH_KEY_PATH,
    '-N', '',
    '-C', 'homepinas-backup',
  ]);

  fs.chmodSync(SSH_KEY_PATH, 0o600);
  return fs.readFileSync(SSH_KEY_PATH + '.pub', 'utf8').trim();
}

/**
 * Get SSH command with proper options
 * @param {number} port SSH port
 * @returns {string} SSH command string
 */
function getSSHCommand(port = 22) {
  return `ssh -i ${SSH_KEY_PATH} -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${port}`;
}

// ── Samba Share Management ──

/**
 * Ensure Samba user exists with password
 * @param {string} username User to add
 * @param {string} password User password
 */
async function ensureSambaUser(username, password) {
  try {
    const { stdout } = await execFileAsync('sudo', ['pdbedit', '-L']);
    if (!stdout.includes(`${username}:`)) {
      // Create user in Samba
      await new Promise((resolve, reject) => {
        const proc = spawn('sudo', ['smbpasswd', '-a', username, '-s'], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        proc.on('error', reject);
        proc.on('close', (code) => {
          code === 0 ? resolve() : reject(new Error(`smbpasswd exited ${code}`));
        });
        proc.stdin.write(`${password}\n${password}\n`);
        proc.stdin.end();
      });

      await execFileAsync('sudo', ['smbpasswd', '-e', username]);
    }
  } catch (e) {
    console.error('Samba user setup warning:', e.message);
  }
}

/**
 * Create Samba share for device backup
 * @param {object} device Device config
 * @param {string} sambaUser Samba username
 */
async function createImageBackupShare(device, sambaUser) {
  const shareName = device.sambaShare;
  const sharePath = getDeviceDir(device.id);

  // Ensure directory exists
  if (!fs.existsSync(sharePath)) {
    fs.mkdirSync(sharePath, { recursive: true });
  }

  // Set ownership
  try {
    await execFileAsync('sudo', [
      'chown', '-R',
      `${sambaUser}:sambashare`,
      sharePath,
    ]);
    await execFileAsync('sudo', ['chmod', '-R', '775', sharePath]);
  } catch (e) {
    console.error('Permission setup warning:', e.message);
  }

  // Add share block to smb.conf
  const smbConfPath = '/etc/samba/smb.conf';
  const shareBlock = `\n[${shareName}]\n   path = ${sharePath}\n   browseable = no\n   writable = yes\n   guest ok = no\n   valid users = ${sambaUser}\n   create mask = 0660\n   directory mask = 0770\n   comment = HomePiNAS Image Backup - ${device.name}\n`;

  try {
    const currentConf = fs.readFileSync(smbConfPath, 'utf8');
    if (!currentConf.includes(`[${shareName}]`)) {
      await new Promise((resolve, reject) => {
        const proc = spawn('sudo', ['tee', '-a', smbConfPath], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        proc.on('error', reject);
        proc.on('close', (code) => {
          code === 0 ? resolve() : reject(new Error(`tee exited ${code}`));
        });
        proc.stdin.write(shareBlock);
        proc.stdin.end();
      });

      await execFileAsync('sudo', ['systemctl', 'reload', 'smbd']);
    }
  } catch (e) {
    console.error('Samba share creation error:', e.message);
    throw e;
  }
}

// ── Local IP Discovery ──

/**
 * Get local network IPv4 addresses
 * @returns {string[]} List of IPv4 addresses
 */
function getLocalIPs() {
  const nets = os.networkInterfaces();
  const ips = [];

  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push(net.address);
      }
    }
  }

  return ips;
}

// ── File Operations ──

/**
 * Get sanitized device backup directory
 * @param {string} deviceId Device ID
 * @returns {string} Backup directory path
 */
function getDeviceDir(deviceId) {
  const safe = deviceId.replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(BACKUP_BASE, safe);
}

/**
 * Ensure backup base directory exists
 */
function ensureBackupBase() {
  if (!fs.existsSync(BACKUP_BASE)) {
    try {
      fs.mkdirSync(BACKUP_BASE, { recursive: true });
    } catch (e) {
      // ignore if already exists
    }
  }
}

/**
 * Calculate directory size recursively
 * @param {string} dirPath Directory path
 * @returns {number} Size in bytes
 */
function getDirSize(dirPath) {
  let total = 0;

  try {
    const items = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const item of items) {
      const full = path.join(dirPath, item.name);
      if (item.isDirectory()) {
        total += getDirSize(full);
      } else {
        try {
          total += fs.statSync(full).size;
        } catch (e) {
          // Skip files we can't stat
        }
      }
    }
  } catch (e) {
    // Directory doesn't exist or can't be read
  }

  return total;
}

/**
 * Send backup failure notification via configured channels
 * @param {object} device Device that failed
 * @param {string} error Error message
 */
async function notifyBackupFailure(device, error) {
  const { getData } = require('./data');

  const data = getData();
  const notifConfig = data.notifications || {};
  const message = `⚠️ Active Backup FAILED\n\nDevice: ${device.name} (${device.ip})\nTime: ${new Date().toLocaleString('es-ES')}\nError: ${error}`;

  // Telegram notification
  if (notifConfig.telegram?.enabled && notifConfig.telegram?.token && notifConfig.telegram?.chatId) {
    try {
      const url = `https://api.telegram.org/bot${notifConfig.telegram.token}/sendMessage`;
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: notifConfig.telegram.chatId,
          text: message,
        }),
      });
    } catch (e) {
      console.error('Telegram notify error:', e.message);
    }
  }

  // Email notification
  if (notifConfig.email?.host && notifConfig.email?.to) {
    try {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host: notifConfig.email.host,
        port: notifConfig.email.port || 587,
        secure: notifConfig.email.secure || false,
        auth: {
          user: notifConfig.email.user,
          pass: notifConfig.email.password,
        },
      });

      await transporter.sendMail({
        from: notifConfig.email.from || notifConfig.email.user,
        to: notifConfig.email.to,
        subject: `⚠️ HomePiNAS: Backup failed - ${device.name}`,
        text: message,
      });
    } catch (e) {
      console.error('Email notify error:', e.message);
    }
  }
}

module.exports = {
  ensureSSHKey,
  getSSHCommand,
  ensureSambaUser,
  createImageBackupShare,
  getLocalIPs,
  getDeviceDir,
  ensureBackupBase,
  getDirSize,
  notifyBackupFailure,
  SSH_KEY_PATH,
  BACKUP_BASE,
};
