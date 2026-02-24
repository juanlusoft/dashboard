/**
 * Checkpoint Manager - Resume interrupted backups
 * 
 * Saves progress to a local JSON file so backups can continue
 * from where they left off after crashes, reboots, or network failures.
 * 
 * Flow:
 *   1. Before backup: loadOrCreate(backupId)
 *   2. During backup: update(phase, data) after each significant step
 *   3. On success: clear(backupId)
 *   4. On next run: load() → if checkpoint exists, resume from saved phase
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

class CheckpointManager {
  constructor() {
    this.dir = process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || 'C:\\ProgramData', 'HomePiNAS', 'checkpoints')
      : path.join(os.homedir(), '.homepinas', 'checkpoints');

    try { fs.mkdirSync(this.dir, { recursive: true }); } catch (e) {}
  }

  /**
   * Generate a deterministic checkpoint ID for a device+type combo.
   * This ensures we find the right checkpoint even across restarts.
   */
  checkpointId(deviceId, backupType) {
    return `${deviceId}-${backupType}`;
  }

  _filePath(cpId) {
    // Sanitize to prevent path traversal
    const safe = cpId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.dir, `${safe}.json`);
  }

  /**
   * Load existing checkpoint or return null if none exists.
   */
  load(cpId) {
    const filePath = this._filePath(cpId);
    try {
      if (!fs.existsSync(filePath)) return null;
      const raw = fs.readFileSync(filePath, 'utf8');
      const cp = JSON.parse(raw);

      // Validate checkpoint is not too old (max 72 hours)
      const ageMs = Date.now() - (cp.updatedAt || 0);
      if (ageMs > 72 * 3600 * 1000) {
        console.log(`[Checkpoint] Expired (${Math.round(ageMs / 3600000)}h old), removing`);
        this.clear(cpId);
        return null;
      }

      return cp;
    } catch (e) {
      console.error(`[Checkpoint] Failed to load: ${e.message}`);
      return null;
    }
  }

  /**
   * Create a new checkpoint.
   */
  create(cpId, metadata = {}) {
    const cp = {
      id: cpId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      phase: 'init',
      phaseData: {},
      completedPhases: [],
      metadata,
      completedFiles: [],
      totalBytes: 0,
      processedBytes: 0,
    };
    this._save(cpId, cp);
    return cp;
  }

  /**
   * Update checkpoint with current phase and progress data.
   * Call this after each significant step completes.
   */
  update(cpId, phase, phaseData = {}, extraFields = {}) {
    const cp = this.load(cpId) || this.create(cpId);

    // Mark previous phase as completed if different
    if (cp.phase !== phase && cp.phase !== 'init' && !cp.completedPhases.includes(cp.phase)) {
      cp.completedPhases.push(cp.phase);
    }

    cp.phase = phase;
    cp.phaseData = phaseData;
    cp.updatedAt = Date.now();

    // Merge extra fields (processedBytes, completedFiles, etc.)
    Object.assign(cp, extraFields);

    this._save(cpId, cp);
    return cp;
  }

  /**
   * Mark a file as completed (for file-level resume in file backups).
   */
  markFileCompleted(cpId, filePath, size, hash) {
    const cp = this.load(cpId);
    if (!cp) return;

    cp.completedFiles.push({ path: filePath, size, hash, at: Date.now() });
    cp.processedBytes = (cp.processedBytes || 0) + (size || 0);
    cp.updatedAt = Date.now();
    this._save(cpId, cp);
  }

  /**
   * Check if a specific phase was already completed.
   */
  isPhaseCompleted(cpId, phase) {
    const cp = this.load(cpId);
    return cp ? cp.completedPhases.includes(phase) : false;
  }

  /**
   * Delete checkpoint (call on successful backup completion).
   */
  clear(cpId) {
    const filePath = this._filePath(cpId);
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (e) {
      console.error(`[Checkpoint] Failed to clear: ${e.message}`);
    }
  }

  /**
   * List all active checkpoints.
   */
  listActive() {
    try {
      return fs.readdirSync(this.dir)
        .filter(f => f.endsWith('.json'))
        .map(f => {
          try { return JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')); }
          catch (e) { return null; }
        })
        .filter(Boolean);
    } catch (e) {
      return [];
    }
  }

  _save(cpId, cp) {
    const filePath = this._filePath(cpId);
    try {
      // Write to temp file first, then rename (atomic on most filesystems)
      const tmpPath = filePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(cp, null, 2), 'utf8');
      fs.renameSync(tmpPath, filePath);
    } catch (e) {
      console.error(`[Checkpoint] Failed to save: ${e.message}`);
    }
  }
}

module.exports = { CheckpointManager };
