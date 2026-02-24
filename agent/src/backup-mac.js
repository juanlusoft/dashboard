/**
 * macOS Backup — Image (asr) and File (rsync) backup.
 *
 * SECURITY: Uses execFile (no shell) to prevent command injection.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const os = require('os');
const path = require('path');
const { retry, NETWORK_ERRORS } = require('./retry');
const { mountMacSMB } = require('./smb-connect');

const execFileAsync = promisify(execFile);

/**
 * Run macOS backup (dispatches to image or file mode).
 */
async function runMacBackup(config, manager) {
  const { nasAddress, backupType, backupPaths, sambaShare, sambaUser, sambaPass } = config;
  const shareName = sambaShare || 'active-backup';

  if (!sambaUser || !sambaPass) throw new Error('Samba credentials are required for backup');
  const creds = { user: sambaUser, pass: sambaPass };

  if (backupType === 'image') return macImageBackup(nasAddress, shareName, creds, manager);
  return macFileBackup(nasAddress, shareName, creds, backupPaths, manager);
}

async function macImageBackup(nasAddress, shareName, creds, mgr) {
  const mountPoint = '/Volumes/homepinas-backup';
  try { await execFileAsync('mkdir', ['-p', mountPoint]); } catch (e) {}

  mgr._setProgress('connect', 10, 'Mounting SMB share');
  await mountMacSMB(nasAddress, shareName, creds, mountPoint, mgr);

  const hostname = os.hostname();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destPath = `${mountPoint}/ImageBackup/${hostname}/${timestamp}`;

  try {
    await execFileAsync('mkdir', ['-p', destPath]);
    mgr._setProgress('capture', 30, 'Creating system image with asr');
    await execFileAsync('sudo', [
      'asr', 'create', '--source', '/', '--target', `${destPath}/system.dmg`, '--erase', '--noprompt',
    ], { timeout: 7200000 });
    mgr._setProgress('done', 100, 'Image backup complete');
    return { type: 'image', timestamp: new Date().toISOString() };
  } finally {
    try { await execFileAsync('umount', [mountPoint]); } catch (e) {}
  }
}

async function macFileBackup(nasAddress, shareName, creds, paths, mgr) {
  if (!paths || paths.length === 0) throw new Error('No hay carpetas configuradas para respaldar');

  const mountPoint = '/Volumes/homepinas-backup';
  try { await execFileAsync('mkdir', ['-p', mountPoint]); } catch (e) {}

  mgr._setProgress('connect', 10, 'Mounting SMB share');
  await mountMacSMB(nasAddress, shareName, creds, mountPoint, mgr);

  const hostname = os.hostname();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const results = [];

  try {
    for (let i = 0; i < paths.length; i++) {
      const srcPath = paths[i];
      const folderName = path.basename(srcPath) || 'root';
      const dest = `${mountPoint}/FileBackup/${hostname}/${timestamp}/${folderName}`;
      const pct = 20 + Math.round((i / paths.length) * 70);
      mgr._setProgress('copy', pct, `Copying ${folderName}`);

      try {
        await execFileAsync('mkdir', ['-p', dest]);
        await retry(
          async (attempt) => {
            if (attempt > 0) mgr._log(`rsync retry #${attempt} for ${folderName}`);
            await execFileAsync('rsync', ['-az', '--delete', `${srcPath}/`, `${dest}/`], { timeout: 3600000 });
          },
          { maxRetries: 3, retryableErrors: NETWORK_ERRORS, baseDelayMs: 2000 }
        );
        results.push({ path: srcPath, success: true });
      } catch (err) {
        results.push({ path: srcPath, success: false, error: err.message });
      }
    }
  } finally {
    try { await execFileAsync('umount', [mountPoint]); } catch (e) {}
  }

  mgr._setProgress('done', 100, 'File backup complete');
  return { type: 'files', results, timestamp: new Date().toISOString() };
}

module.exports = { runMacBackup };
