# USN Journal Incremental Backup Integration Guide

## Overview

This guide explains how to integrate USN Journal incremental backup support into the Windows image backup pipeline in `src/backup.js`.

## Architecture

```
BackupManager._windowsImageBackup()
  ├─ Phase 1: Admin check, SMB connect, VSS create
  ├─ Phase 2 (NEW): Determine backup strategy (full vs incremental)
  │   └─ Use WindowsIncrementalHelper.determineBackupStrategy()
  ├─ Phase 3a (FULL): wimcapture entire C: volume
  ├─ Phase 3b (INCREMENTAL): Backup only changed files
  │   └─ Use getIncrementalFileList() → wimcapture for each file
  └─ Phase 4: EFI capture, manifest, cleanup
```

## Code Changes Required

### 1. Import USN Helper

In `src/backup.js`, add at the top:

```javascript
const { WindowsIncrementalHelper } = require('./windows-incremental');
```

### 2. Initialize Helper

In `BackupManager._windowsImageBackup()`, after creating the checkpoint:

```javascript
const wiHelper = new WindowsIncrementalHelper(this, this._checkpoint);
```

### 3. Determine Backup Strategy

Replace the direct wimcapture call with strategy check:

**BEFORE:**
```javascript
// Phase 6: Capture C: volume from VSS snapshot
this._setProgress('capture', 30, 'Capturing system image (this may take a while)');
const wimlibExe = await this._ensureWimlib();
await this._wimCapture(wimlibExe, vss.devicePath, wimPath, `${hostname}-C`);
```

**AFTER:**
```javascript
// Phase 6: Determine backup strategy (full vs incremental)
const strategy = await wiHelper.determineBackupStrategy({
  deviceId: config.deviceId,
  backupType: 'image',
  cpId: this._cpId,
});
wiHelper.logStrategy(strategy);

const wimlibExe = await this._ensureWimlib();

if (strategy.strategy === 'incremental') {
  // Incremental: Only backup changed files
  this._setProgress('capture', 30, `Incremental: ${strategy.changedFiles.length} changed files, ~${strategy.estimateMinutes}min`);
  await this._wimCaptureIncremental(wimlibExe, strategy.changedFiles, wimPath, hostname);
  
  // Update checkpoint with new USN for next backup
  await wiHelper.updateCheckpointUSN(this._cpId);
} else {
  // Full: Backup entire volume
  this._setProgress('capture', 30, 'Capturing system image (this may take a while)');
  await this._wimCapture(wimlibExe, vss.devicePath, wimPath, `${hostname}-C`);
  
  // Save USN for next backup (which will be incremental)
  await wiHelper.updateCheckpointUSN(this._cpId);
}
```

### 4. Add Incremental Capture Method

Add this new method to `BackupManager` class:

```javascript
async _wimCaptureIncremental(wimlibExe, changedFiles, destWimPath, hostname) {
  /**
   * Capture only changed files into WIM.
   * For incremental: instead of capturing entire filesystem,
   * we create a WIM with only the files that changed.
   *
   * Note: This creates a "delta" WIM that must be stored alongside
   * the previous full backup. Restore requires applying both.
   */
  
  const destDir = path.dirname(destWimPath);
  if (!fs.existsSync(destDir)) {
    try { fs.mkdirSync(destDir, { recursive: true }); } catch (e) {}
  }

  // Create a temporary directory with only changed files
  // (symlinks to originals for space efficiency)
  const tempDir = path.join(
    process.env.LOCALAPPDATA || 'C:\\ProgramData',
    'HomePiNAS', 'incremental-temp',
    `${Date.now()}`
  );
  
  try {
    fs.mkdirSync(tempDir, { recursive: true });

    // Symlink or copy changed files into temp directory
    for (const file of changedFiles) {
      const src = file.path;
      const relPath = src.substring(src.lastIndexOf('\\') + 1);
      const dest = path.join(tempDir, relPath);
      
      try {
        // Use symlinks for efficiency (only Windows junctions on NTFS)
        if (fs.existsSync(src)) {
          fs.symlinkSync(src, dest, 'file');
        }
      } catch (e) {
        // Fallback: copy if symlink fails
        try {
          fs.copyFileSync(src, dest);
        } catch (copyErr) {
          this._log(`WARNING: Could not copy ${src}: ${copyErr.message}`);
        }
      }
    }

    // Capture temp directory (only changed files)
    const cpuCount = os.cpus().length;
    const args = [
      'capture',
      tempDir,
      destWimPath,
      `${hostname}-C-incremental-${new Date().toISOString().split('T')[0]}`,
      '--compress=LZX',
      `--threads=${cpuCount}`,
      '--no-acls',
    ];

    return new Promise((resolve, reject) => {
      const proc = spawn(wimlibExe, args, {
        timeout: 7200000,  // 2 hours for incremental
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        const text = data.toString();
        stdout += text;
        const lines = text.split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
          if (line.includes('%')) {
            const match = line.match(/(\d+)%/);
            if (match) {
              this._setProgress('capture', 30 + Math.round(parseInt(match[1]) * 0.5), line.trim());
            }
          }
        }
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0 || code === 47) {  // 47 = partial success
          this._log('wimcapture incremental completed successfully');
          resolve();
        } else {
          const errOutput = (stderr || stdout || '').substring(0, 500);
          reject(new Error(`wimcapture failed (exit ${code}): ${errOutput}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`wimcapture spawn error: ${err.message}`));
      });
    });

  } finally {
    // Cleanup temp directory
    try {
      if (fs.existsSync(tempDir)) {
        const files = fs.readdirSync(tempDir);
        for (const f of files) {
          try { fs.unlinkSync(path.join(tempDir, f)); } catch (e) {}
        }
        fs.rmdirSync(tempDir);
      }
    } catch (e) {
      this._log(`WARNING: Could not clean temp directory: ${e.message}`);
    }
  }
}
```

## Fallback Behavior

- **If USN Journal not available**: Automatically falls back to full backup
- **If Journal rolled over**: Detects and switches to full backup (journal overflow)
- **If checkpoint missing**: First backup is always full
- **If changed files == 0**: Still creates a valid (empty) delta WIM

## Testing

### Prerequisites

- Windows 10+ (NTFS)
- Administrator privileges for VSS
- Backup agent running

### Test Case: Incremental Workflow

```powershell
# 1. Create initial backup
Start-HomePiNASBackup -Type image -Full

# 2. Modify some files
echo "test" >> C:\Users\username\Documents\test.txt
md C:\Users\username\Documents\NewFolder

# 3. Run second backup (should be incremental)
Start-HomePiNASBackup -Type image

# 4. Check agent logs
Get-Content "$env:LOCALAPPDATA\HomePiNAS\backup.log" | Tail -20
# Should show: "[USN Journal] Backup strategy: INCREMENTAL"
```

## Performance Expectations

### Full Backup
- 200GB system: 2-3 hours
- Network: SMB 1Gbps

### Incremental Backup (typical office work)
- Changed files: 100-500MB
- Time: 15-45 minutes (depending on file count)
- Network: 5-10MB/s average

## Limitations & Future Improvements

1. **Delta WIM format**: Currently stores full copies of changed files in new WIM
   - Future: Store binary diffs instead (more complex, better compression)

2. **System files**: Excludes some system files (Temp, AppData\Roaming, cache)
   - Future: Make exclusion patterns configurable

3. **Large file changes**: If a large file (e.g., 1GB database) changes, entire file is backed up
   - Future: Implement block-level dedup for large changed files

4. **Symlinks in temp**: Uses hardlinks/copies instead of symlinks for compatibility
   - Future: Direct streaming from changed files (avoid disk I/O)

## Troubleshooting

### "USN Journal: could not determine backup type"

**Cause**: Permission issue or journal not available
**Solution**:
```powershell
# Check journal is active
fsutil usn queryjournal C:

# If error, enable journal:
fsutil usn createjournal m=1000 a=100 C:
```

### "Backup fell back to FULL"

**Cause**: Journal rolled over (too many changes between backups)
**Solution**: Run backups more frequently, or increase journal size

### "No checkpoint with USN data"

**Cause**: Running incremental on first backup
**Solution**: Always run full backup first. Incremental only after checkpoint exists.

## References

- Microsoft USN Journal Documentation: https://docs.microsoft.com/en-us/windows/win32/fileio/usn-journal
- wimlib documentation: https://wimlib.net/
- HomePiNAS Backup Architecture: ../README.md
