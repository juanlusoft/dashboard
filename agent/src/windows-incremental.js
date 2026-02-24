/**
 * Windows Incremental Backup Integration
 *
 * Enhances BackupManager to support USN Journal incremental backups.
 * Plugs into the existing checkpoint/retry/integrity framework.
 *
 * Usage:
 *   const WindowsIncremental = require('./windows-incremental');
 *   const helper = new WindowsIncremental(backupManager, checkpoint);
 *   const backupType = await helper.determineBackupStrategy(config);
 *   if (backupType === 'incremental') {
 *     // Use helper.getIncrementalFileList() instead of full capture
 *   }
 */

const { USNJournalTracker } = require('./usn-journal');

class WindowsIncrementalHelper {
  constructor(backupManager, checkpointManager) {
    this.manager = backupManager;
    this.checkpoint = checkpointManager;
    this.usn = new USNJournalTracker();
  }

  /**
   * Determine backup strategy (full vs incremental) based on checkpoint state.
   *
   * Returns: {
   *   strategy: 'full' | 'incremental',
   *   reason: string,
   *   changedFiles?: File[],
   *   estimateMinutes?: number,
   *   estimateMB?: number,
   * }
   */
  async determineBackupStrategy(config) {
    const { deviceId, backupType, cpId } = config;

    // Only for Windows image backups
    if (process.platform !== 'win32' || backupType !== 'image') {
      return {
        strategy: 'full',
        reason: 'Non-Windows image backup (always full)',
      };
    }

    // Load checkpoint
    const cp = this.checkpoint.load(cpId);
    if (!cp) {
      return {
        strategy: 'full',
        reason: 'No checkpoint (first backup)',
      };
    }

    try {
      // Ask USN Journal if we can do incremental
      const decision = await this.usn.determineBackupType(cp, 'C:');

      if (decision.type === 'full') {
        return {
          strategy: 'full',
          reason: decision.reason,
        };
      }

      // Decision: incremental is possible
      // Get list of changed files
      const lastUSN = decision.lastUSN || '0x0';
      const changedFiles = await this.usn.getBackupFiles('C:', lastUSN);

      const estimate = this.usn.estimateIncrementalTime(changedFiles);

      return {
        strategy: 'incremental',
        reason: `${changedFiles.length} files changed since last backup`,
        changedFiles,
        estimateMinutes: estimate.estimatedMinutes,
        estimateMB: estimate.estimatedMB,
      };
    } catch (e) {
      console.warn(`[WindowsIncremental] Error determining strategy: ${e.message}`);
      return {
        strategy: 'full',
        reason: `Cannot determine incremental: ${e.message}`,
      };
    }
  }

  /**
   * Get list of changed files for incremental backup.
   * This replaces full WIM capture for incremental scenarios.
   */
  async getIncrementalFileList(cpId) {
    const cp = this.checkpoint.load(cpId);
    if (!cp || !cp.phaseData?.lastUSN) {
      throw new Error('No checkpoint with USN data available');
    }

    const lastUSN = cp.phaseData.lastUSN;
    return await this.usn.getBackupFiles('C:', lastUSN);
  }

  /**
   * Log backup strategy decision to manager's log.
   */
  logStrategy(strategy) {
    this.manager._log(`[USN Journal] Backup strategy: ${strategy.strategy.toUpperCase()}`);
    this.manager._log(`  Reason: ${strategy.reason}`);

    if (strategy.changedFiles) {
      this.manager._log(`  Changed files: ${strategy.changedFiles.length}`);
      this.manager._log(`  Estimated time: ${strategy.estimateMinutes} minutes`);
      this.manager._log(`  Estimated size: ${strategy.estimateMB} MB`);
    }
  }

  /**
   * Update checkpoint after successful incremental backup.
   * This saves the current USN for next backup.
   */
  async updateCheckpointUSN(cpId) {
    const cp = this.checkpoint.load(cpId);
    if (!cp) throw new Error('Checkpoint not found');

    return await this.usn.saveUSNState(cp, 'C:');
  }
}

module.exports = { WindowsIncrementalHelper };
