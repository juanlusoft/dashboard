/**
 * Linux Backup — Image (partclone) and File (rsync) backup.
 *
 * SECURITY: Uses execFile (no shell) to prevent command injection.
 * Credentials written to temp file (mode 0600), never in command args.
 */

const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { retry, NETWORK_ERRORS } = require('./retry');
const { mountLinuxCIFS, writeCredFile } = require('./smb-connect');

const execFileAsync = promisify(execFile);

/**
 * Run Linux backup (dispatches to image or file mode).
 */
async function runLinuxBackup(config, manager) {
  const { nasAddress, backupType, backupPaths, sambaShare, sambaUser, sambaPass } = config;
  const shareName = sambaShare || 'active-backup';

  if (!sambaUser || !sambaPass) throw new Error('Samba credentials are required for backup');
  const creds = { user: sambaUser, pass: sambaPass };

  if (backupType === 'image') return linuxImageBackup(nasAddress, shareName, creds, manager);
  return linuxFileBackup(nasAddress, shareName, creds, backupPaths, manager);
}

async function linuxImageBackup(nasAddress, shareName, creds, mgr) {
  const mountPoint = `/tmp/homepinas-backup-${process.pid}`;
  try { await execFileAsync('mkdir', ['-p', mountPoint]); } catch (e) {}
  const credFile = writeCredFile(creds, process.pid);

  try {
    mgr._setProgress('connect', 10, 'Mounting SMB share');
    await mountLinuxCIFS(nasAddress, shareName, mountPoint, credFile, mgr);

    const hostname = os.hostname();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destPath = `${mountPoint}/ImageBackup/${hostname}/${timestamp}`;
    await execFileAsync('mkdir', ['-p', destPath]);

    const { stdout: rootDev } = await execFileAsync('findmnt', ['-n', '-o', 'SOURCE', '/']);
    const { stdout: rootFs } = await execFileAsync('findmnt', ['-n', '-o', 'FSTYPE', '/']);
    const device = rootDev.trim();
    const fsType = rootFs.trim();

    mgr._log(`Root device: ${device} (${fsType})`);
    mgr._setProgress('capture', 30, `Capturing ${device} with partclone`);

    const imgFile = path.join(destPath, 'root.img.gz');
    await partcloneCapture(fsType, device, imgFile, mgr);

    mgr._setProgress('done', 100, 'Image backup complete');
    return { type: 'image', timestamp: new Date().toISOString() };
  } finally {
    try { await execFileAsync('umount', [mountPoint]); } catch (e) {}
    try { await execFileAsync('rmdir', [mountPoint]); } catch (e) {}
    try { fs.unlinkSync(credFile); } catch (e) {}
  }
}

/**
 * Pipe partclone through gzip to destination.
 */
function partcloneCapture(fsType, device, destFile, mgr) {
  return new Promise((resolve, reject) => {
    const partclone = spawn(`partclone.${fsType}`, ['-c', '-s', device, '-o', '-'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const gzip = spawn('gzip', ['-c'], {
      stdio: ['pipe', fs.openSync(destFile, 'w'), 'pipe'],
    });

    partclone.stdout.pipe(gzip.stdin);

    let stderr = '';
    partclone.stderr.on('data', (d) => { stderr += d.toString(); });

    gzip.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`gzip failed with code ${code}`));
    });

    partclone.on('close', (code) => {
      if (code !== 0) {
        gzip.stdin.end();
        reject(new Error(`partclone failed (code ${code}): ${stderr.substring(0, 300)}`));
      }
    });

    partclone.on('error', (err) => reject(new Error(`partclone error: ${err.message}`)));
    gzip.on('error', (err) => reject(new Error(`gzip error: ${err.message}`)));
  });
}

async function linuxFileBackup(nasAddress, shareName, creds, paths, mgr) {
  if (!paths || paths.length === 0) throw new Error('No hay carpetas configuradas para respaldar');

  const mountPoint = `/tmp/homepinas-backup-${process.pid}`;
  try { await execFileAsync('mkdir', ['-p', mountPoint]); } catch (e) {}
  const credFile = writeCredFile(creds, process.pid);

  try {
    mgr._setProgress('connect', 10, 'Mounting SMB share');
    await mountLinuxCIFS(nasAddress, shareName, mountPoint, credFile, mgr);

    const hostname = os.hostname();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const results = [];

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

    mgr._setProgress('done', 100, 'File backup complete');
    return { type: 'files', results, timestamp: new Date().toISOString() };
  } finally {
    try { await execFileAsync('umount', [mountPoint]); } catch (e) {}
    try { await execFileAsync('rmdir', [mountPoint]); } catch (e) {}
    try { fs.unlinkSync(credFile); } catch (e) {}
  }
}

module.exports = { runLinuxBackup };
