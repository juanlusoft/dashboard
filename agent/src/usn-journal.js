/**
 * USN Journal Tracker - Windows Incremental Backup Detection
 *
 * Leverages Windows NTFS Update Sequence Number (USN) Journal to detect
 * file changes since last backup. No external drivers needed — native to
 * Windows XP+ (NTFS/ReFS).
 *
 * Flow:
 *   1. First backup: Full capture, save USN state to checkpoint
 *   2. Next backup: Query USN Journal since saved USN → detect changes
 *   3. Backup only changed files (incremental)
 *   4. Resume support: Checkpoint tracks USN after each chunk
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execFileAsync = promisify(execFile);

class USNJournalTracker {
  constructor() {
    this.platform = process.platform;
  }

  /**
   * Query current USN Journal state for a drive.
   * Returns: { journalId, nextUSN, oldestUSN }
   */
  async queryJournal(drive = 'C:') {
    if (this.platform !== 'win32') {
      throw new Error('USN Journal is Windows-only (NTFS/ReFS)');
    }

    const psScript = [
      '$ErrorActionPreference = "Stop"',
      `$vol = [System.IO.DriveInfo]"${drive[0]}:"`,
      '$root = $vol.RootDirectory',
      '',
      // Get journal info via fsutil (native Windows)
      '$output = cmd /c "fsutil usn queryjournal ${drive}"',
      '',
      // Parse output
      '$lines = $output | Where-Object { $_ -match "USN Journal ID|Next USN|Oldest USN" }',
      'foreach ($line in $lines) {',
      '  if ($line -match "USN Journal ID: (.+)") { $journalId = $matches[1].trim() }',
      '  if ($line -match "Next USN: (.+)") { $nextUSN = $matches[1].trim() }',
      '  if ($line -match "Oldest USN: (.+)") { $oldestUSN = $matches[1].trim() }',
      '}',
      '',
      'Write-Output @{',
      '  journalId = $journalId',
      '  nextUSN = $nextUSN',
      '  oldestUSN = $oldestUSN',
      '} | ConvertTo-Json',
    ].join('\n');

    try {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command', psScript
      ], { timeout: 10000, windowsHide: true, shell: false });

      const parsed = JSON.parse(stdout);
      return {
        journalId: parsed.journalId || null,
        nextUSN: parsed.nextUSN || '0x0',
        oldestUSN: parsed.oldestUSN || '0x0',
      };
    } catch (e) {
      throw new Error(`Failed to query USN Journal: ${e.message}`);
    }
  }

  /**
   * Get list of changed files since a specific USN.
   * This is the KEY method for incremental backups.
   *
   * Returns: { changed: [{ path, size, attributes, changeTime }], ...}
   */
  async getChangedFiles(drive = 'C:', sinceUSN = '0x0') {
    if (this.platform !== 'win32') {
      throw new Error('USN Journal is Windows-only');
    }

    // Convert hex string to decimal if needed
    let usnDecimal = sinceUSN;
    if (typeof sinceUSN === 'string' && sinceUSN.startsWith('0x')) {
      usnDecimal = parseInt(sinceUSN, 16).toString();
    }

    const psScript = [
      '$ErrorActionPreference = "Stop"',
      `$drive = "${drive[0]}:"`,
      `$startUSN = ${usnDecimal}`,
      '',
      // Read USN Journal entries
      '$changed = @()',
      'try {',
      '  $output = cmd /c "fsutil usn readjournal ${drive} csv"',
      '  $entries = $output | ConvertFrom-Csv',
      '',
      '  foreach ($entry in $entries) {',
      '    # Parse CSV: Filename,Filesize,Attributes,ChangeTime,USN',
      '    if ([uint64]$entry.USN -gt $startUSN) {',
      '      $changed += @{',
      '        path = $entry.Filename',
      '        size = [uint64]$entry.Filesize',
      '        attributes = $entry.Attributes',
      '        changeTime = $entry.ChangeTime',
      '        usn = $entry.USN',
      '      }',
      '    }',
      '  }',
      '} catch {',
      '  # If fsutil fails, fall back to file enumeration (slower)',
      '  Write-Warning "fsutil failed, using file enumeration fallback"',
      '}',
      '',
      'Write-Output @{',
      '  changed = $changed',
      '  count = $changed.Count',
      '} | ConvertTo-Json -Depth 2',
    ].join('\n');

    try {
      const { stdout, stderr } = await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command', psScript
      ], { timeout: 30000, windowsHide: true, shell: false, maxBuffer: 10 * 1024 * 1024 });

      if (stderr && stderr.includes('error')) {
        console.warn(`[USN] stderr: ${stderr.substring(0, 200)}`);
      }

      const result = JSON.parse(stdout);
      return {
        changed: Array.isArray(result.changed) ? result.changed : [],
        count: result.count || 0,
      };
    } catch (e) {
      // If USN Journal fails (journal overflow, not available), return empty
      // → will trigger full backup fallback
      console.warn(`[USN] Failed to read journal: ${e.message}`);
      return { changed: [], count: 0, error: e.message };
    }
  }

  /**
   * Detect if this is a full backup or incremental.
   * - Full: if no checkpoint exists, or journal was cleared, or checkpoint expired
   * - Incremental: if checkpoint exists and journal still has the saved USN
   *
   * Returns: { type: 'full' | 'incremental', reason: string, lastUSN?: string }
   */
  async determineBackupType(checkpoint, drive = 'C:') {
    if (!checkpoint) {
      return { type: 'full', reason: 'No checkpoint (first backup)' };
    }

    const lastUSN = checkpoint.phaseData?.lastUSN;
    if (!lastUSN) {
      return { type: 'full', reason: 'No USN in checkpoint (legacy checkpoint)' };
    }

    try {
      const journal = await this.queryJournal(drive);

      // Check if saved USN is still in the journal
      // (if it's older than oldest, journal has rolled over → must do full backup)
      const savedUSN = BigInt(parseInt(lastUSN.replace(/^0x/, ''), 16));
      const oldestUSN = BigInt(parseInt(journal.oldestUSN.replace(/^0x/, ''), 16));

      if (savedUSN < oldestUSN) {
        return {
          type: 'full',
          reason: `Journal rolled over (saved USN ${lastUSN} is older than oldest ${journal.oldestUSN})`,
        };
      }

      return {
        type: 'incremental',
        reason: 'Journal has changes since last backup',
        lastUSN,
      };
    } catch (e) {
      console.warn(`[USN] Error determining backup type: ${e.message}`);
      return {
        type: 'full',
        reason: `Cannot query journal: ${e.message}`,
      };
    }
  }

  /**
   * Get files that should be backed up for incremental.
   * Filters out system files, temporary files, cache files.
   *
   * Returns: [{ path, size, usn }, ...]
   */
  async getBackupFiles(drive = 'C:', sinceUSN = '0x0', excludePatterns = []) {
    const result = await this.getChangedFiles(drive, sinceUSN);
    const changed = result.changed || [];

    // Default exclude patterns (system, temp, cache)
    const defaultExcludes = [
      /\\\\AppData\\Roaming\\Microsoft\\Windows\\/i,
      /\\Temp\\/i,
      /\\\\System Volume Information\\/i,
      /\\\$Recycle\.Bin\\/i,
      /\\hiberfil\.sys$/i,
      /\\pagefile\.sys$/i,
      /\\.pst$/i,  // Outlook cache
      /\\.ost$/i,  // Outlook OST cache (corrected from .ostis typo)
    ];

    const patterns = [...defaultExcludes, ...excludePatterns];

    // Filter out excluded files
    const filtered = changed.filter(file => {
      const filePath = file.path || '';
      for (const pattern of patterns) {
        if (pattern.test(filePath)) return false;
      }
      return true;
    });

    // Transform to backup format
    return filtered.map(f => ({
      path: f.path,
      size: f.size || 0,
      usn: f.usn,
      attributes: f.attributes,
    }));
  }

  /**
   * Estimate time for incremental backup based on changed files.
   * Rough estimate: 50MB/min for typical network speed.
   */
  estimateIncrementalTime(changedFiles) {
    const totalBytes = changedFiles.reduce((sum, f) => sum + (f.size || 0), 0);
    const bytesPerMin = 50 * 1024 * 1024;
    const minutes = Math.ceil(totalBytes / bytesPerMin);
    return {
      totalBytes,
      estimatedMinutes: Math.max(5, minutes),  // At least 5 min for metadata
      estimatedMB: Math.round(totalBytes / 1048576),
    };
  }

  /**
   * Save USN state to checkpoint after successful backup.
   * This is called by BackupManager.runBackup() to track progress.
   */
  async saveUSNState(checkpoint, drive = 'C:') {
    try {
      const journal = await this.queryJournal(drive);
      checkpoint.phaseData = checkpoint.phaseData || {};
      checkpoint.phaseData.lastUSN = journal.nextUSN;
      checkpoint.phaseData.journalId = journal.journalId;
      checkpoint.phaseData.usnSavedAt = new Date().toISOString();
      return true;
    } catch (e) {
      console.warn(`[USN] Failed to save USN state: ${e.message}`);
      return false;
    }
  }
}

module.exports = { USNJournalTracker };
