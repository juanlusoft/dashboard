/**
 * SMB Connection Helper — DRY wrapper for platform-specific SMB mount/connect
 * with retry + exponential backoff.
 *
 * SECURITY: Uses execFile (no shell) to prevent command injection.
 * Credentials are never interpolated into command strings.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const { retry, NETWORK_ERRORS } = require('./retry');

const execFileAsync = promisify(execFile);

/**
 * Connect to SMB share on Windows via `net use`.
 * @param {string} sharePath - UNC path (e.g. \\192.168.1.100\active-backup)
 * @param {Object} creds - { user, pass }
 * @param {Object} logger - Object with _log() and _setProgress() methods
 */
async function connectWindowsSMB(sharePath, creds, logger) {
  const server = sharePath.split('\\').filter(Boolean)[0];
  await cleanWindowsSMB(server, sharePath);

  await retry(
    async (attempt) => {
      if (attempt > 0) logger._log(`SMB connect retry #${attempt}`);
      await execFileAsync('net', [
        'use', sharePath, `/user:${creds.user}`, creds.pass, '/persistent:no',
      ], { shell: false });
    },
    {
      maxRetries: 5,
      retryableErrors: NETWORK_ERRORS,
      onRetry: (err, attempt, delay) => {
        logger._setProgress('connect', 10, `Connection failed, retry ${attempt} in ${Math.round(delay / 1000)}s...`);
      },
    }
  );

  logger._log(`Connected to ${sharePath}`);
}

/**
 * Connect mapped drive (Z:) on Windows.
 */
async function connectWindowsDrive(driveLetter, sharePath, creds, logger) {
  try { await execFileAsync('net', ['use', `${driveLetter}:`, '/delete', '/y'], { shell: false }); } catch (e) {}

  await retry(
    async (attempt) => {
      if (attempt > 0) logger._log(`SMB drive mount retry #${attempt}`);
      await execFileAsync('net', [
        'use', `${driveLetter}:`, sharePath, `/user:${creds.user}`, creds.pass, '/persistent:no',
      ], { shell: false });
    },
    {
      maxRetries: 5,
      retryableErrors: NETWORK_ERRORS,
      onRetry: (err, attempt, delay) => {
        logger._setProgress('connect', 10, `Drive mount failed, retry ${attempt} in ${Math.round(delay / 1000)}s...`);
      },
    }
  );

  logger._log(`Mapped ${driveLetter}: to ${sharePath}`);
}

/**
 * Clean stale SMB connections on Windows.
 */
async function cleanWindowsSMB(server, sharePath) {
  try { await execFileAsync('net', ['use', `\\\\${server}`, '/delete', '/y'], { shell: false }); } catch (e) {}
  try { await execFileAsync('net', ['use', sharePath, '/delete', '/y'], { shell: false }); } catch (e) {}

  try {
    const { stdout } = await execFileAsync('net', ['use'], { shell: false });
    const lines = stdout.split('\n').filter(l => l.includes(server));
    for (const line of lines) {
      const match = line.match(/([A-Z]:)\s/);
      if (match) {
        try { await execFileAsync('net', ['use', match[1], '/delete', '/y'], { shell: false }); } catch (e) {}
      }
    }
  } catch (e) {}
}

/**
 * Disconnect Windows SMB share.
 */
async function disconnectWindowsSMB(sharePath) {
  try { await execFileAsync('net', ['use', sharePath, '/delete', '/y'], { shell: false }); } catch (e) {}
}

/**
 * Mount CIFS share on Linux.
 * @param {string} nasAddress
 * @param {string} shareName
 * @param {string} mountPoint
 * @param {string} credFile - Path to credentials file (mode 0600)
 * @param {Object} logger
 */
async function mountLinuxCIFS(nasAddress, shareName, mountPoint, credFile, logger) {
  await retry(
    async (attempt) => {
      if (attempt > 0) logger._log(`CIFS mount retry #${attempt}`);
      await execFileAsync('mount', [
        '-t', 'cifs',
        `//${nasAddress}/${shareName}`,
        mountPoint,
        '-o', `credentials=${credFile},vers=3.0`,
      ]);
    },
    {
      maxRetries: 5,
      retryableErrors: NETWORK_ERRORS,
      onRetry: (err, attempt, delay) => {
        logger._setProgress('connect', 10, `Mount failed, retry ${attempt} in ${Math.round(delay / 1000)}s...`);
      },
    }
  );

  logger._log(`Mounted //${nasAddress}/${shareName} at ${mountPoint}`);
}

/**
 * Mount SMB share on macOS via mount_smbfs.
 */
async function mountMacSMB(nasAddress, shareName, creds, mountPoint, logger) {
  const smbUrl = `smb://${encodeURIComponent(creds.user)}:${encodeURIComponent(creds.pass)}@${nasAddress}/${shareName}`;

  await retry(
    async (attempt) => {
      if (attempt > 0) logger._log(`SMB mount retry #${attempt}`);
      await execFileAsync('mount_smbfs', ['-N', smbUrl, mountPoint]);
    },
    {
      maxRetries: 5,
      retryableErrors: NETWORK_ERRORS,
      onRetry: (err, attempt, delay) => {
        logger._setProgress('connect', 10, `Mount failed, retry ${attempt} in ${Math.round(delay / 1000)}s...`);
      },
    }
  );

  logger._log(`Mounted smb://${nasAddress}/${shareName} at ${mountPoint}`);
}

/**
 * Write Linux CIFS credentials to a temp file (mode 0600).
 * Returns the file path. Caller must clean up.
 */
function writeCredFile(creds, pid) {
  const credFile = `/tmp/homepinas-creds-${pid}`;
  fs.writeFileSync(credFile, `username=${creds.user}\npassword=${creds.pass}\n`, { mode: 0o600 });
  return credFile;
}

module.exports = {
  connectWindowsSMB,
  connectWindowsDrive,
  cleanWindowsSMB,
  disconnectWindowsSMB,
  mountLinuxCIFS,
  mountMacSMB,
  writeCredFile,
};
