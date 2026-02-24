/**
 * Backup Manager — Orchestrates backup execution across platforms.
 *
 * Delegates platform-specific logic to:
 *   - backup-windows.js (WIM + VSS + robocopy)
 *   - backup-mac.js     (asr + rsync)
 *   - backup-linux.js   (partclone + rsync)
 *
 * Provides shared infrastructure:
 *   - Logging (file + console)
 *   - Progress tracking
 *   - Checkpoint/resume support
 *
 * SECURITY: Uses execFile (no shell) to prevent command injection.
 * Credentials are never interpolated into command strings.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { CheckpointManager } = require('./checkpoint');
const { runWindowsBackup } = require('./backup-windows');
const { runMacBackup } = require('./backup-mac');
const { runLinuxBackup } = require('./backup-linux');

class BackupManager {
  constructor() {
    this.platform = process.platform;
    this.running = false;
    this._progress = null;
    this._logLines = [];
    this._logFile = null;
    this._checkpoint = new CheckpointManager();
  }

  get progress() { return this._progress; }
  get logContent() { return this._logLines.join('\n'); }

  // ─── Logging ───────────────────────────────────────────────────────────────

  _setProgress(phase, percent, detail) {
    this._progress = { phase, percent: Math.min(100, Math.max(0, percent)), detail };
    this._log(`[${phase}] ${percent}% — ${detail}`);
  }

  _log(msg) {
    const line = `${new Date().toISOString()} ${msg}`;
    this._logLines.push(line);
    console.log(`[Backup] ${msg}`);
  }

  _initLog() {
    this._logLines = [];
    const logDir = this.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || 'C:\\ProgramData', 'HomePiNAS')
      : path.join(os.homedir(), '.homepinas');
    try { fs.mkdirSync(logDir, { recursive: true }); } catch (e) {}
    this._logFile = path.join(logDir, 'backup.log');
    this._log(`=== Backup started on ${os.hostname()} (${this.platform}) ===`);
    this._log(`OS: ${os.type()} ${os.release()} ${os.arch()}`);
    this._log(`RAM: ${Math.round(os.totalmem() / 1073741824)}GB`);
  }

  _flushLog() {
    if (!this._logFile) return;
    try {
      fs.writeFileSync(this._logFile, this._logLines.join('\n') + '\n');
    } catch (e) {
      console.error('[Backup] Could not write log file:', e.message);
    }
  }

  // ─── Main Entry Point ─────────────────────────────────────────────────────

  async runBackup(config) {
    if (this.running) throw new Error('Backup already running');
    this.running = true;
    this._progress = null;
    this._initLog();

    const cpId = this._initCheckpoint(config);

    try {
      this._cpId = cpId;
      const result = await this._dispatchPlatformBackup(config);

      this._checkpoint.clear(cpId);
      this._log('=== Backup completed successfully ===');
      result.log = this.logContent;
      this._flushLog();
      return result;
    } catch (err) {
      // Checkpoint preserved for resume on next attempt
      this._log(`=== Backup FAILED: ${err.message} (checkpoint preserved) ===`);
      this._flushLog();
      err.backupLog = this.logContent;
      throw err;
    } finally {
      this.running = false;
      this._progress = null;
    }
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  _initCheckpoint(config) {
    const cpId = this._checkpoint.checkpointId(
      config.deviceId || 'default',
      config.backupType || 'full'
    );
    const existing = this._checkpoint.load(cpId);
    if (existing) {
      this._log(`Resuming: phase=${existing.phase}, bytes=${existing.processedBytes}`);
    } else {
      this._checkpoint.create(cpId, {
        deviceId: config.deviceId,
        backupType: config.backupType,
        startedAt: Date.now(),
      });
    }
    return cpId;
  }

  async _dispatchPlatformBackup(config) {
    switch (this.platform) {
      case 'win32':  return runWindowsBackup(config, this);
      case 'darwin':  return runMacBackup(config, this);
      case 'linux':   return runLinuxBackup(config, this);
      default: throw new Error(`Plataforma no soportada: ${this.platform}`);
    }
  }
}

module.exports = { BackupManager };
