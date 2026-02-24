/**
 * Windows Backup — Image (WIM + VSS) and File (robocopy) backup.
 *
 * Separated from BackupManager for single-responsibility.
 * SECURITY: Uses execFile (no shell) to prevent command injection.
 *
 * NOTE: This file exceeds 300 lines because Windows backup is a single cohesive
 * workflow (VSS → wimlib → metadata → manifest) that's harder to split without
 * creating artificial coupling between fragments. All functions are <30 lines
 * except the top-level orchestrators which coordinate the phases.
 */

const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { retry, NETWORK_ERRORS } = require('./retry');
const { generateManifest } = require('./integrity');
const { WindowsIncrementalHelper } = require('./windows-incremental');
const { connectWindowsSMB, connectWindowsDrive, disconnectWindowsSMB } = require('./smb-connect');

const execFileAsync = promisify(execFile);

/**
 * Run Windows backup (dispatches to image or file mode).
 * @param {Object} config - Backup configuration from NAS
 * @param {Object} manager - BackupManager instance (for logging, progress, checkpoint)
 */
async function runWindowsBackup(config, manager) {
  const { nasAddress, backupType, sambaShare, sambaUser, sambaPass } = config;
  const sharePath = `\\\\${nasAddress}\\${sambaShare || 'active-backup'}`;

  if (!sambaUser || !sambaPass) {
    throw new Error('Samba credentials are required for backup');
  }
  const creds = { user: sambaUser, pass: sambaPass };

  if (backupType === 'image') {
    return windowsImageBackup(sharePath, creds, config, manager);
  }
  return windowsFileBackup(sharePath, config.backupPaths, creds, manager);
}

// ─── IMAGE BACKUP ────────────────────────────────────────────────────────────

async function windowsImageBackup(sharePath, creds, config, mgr) {
  let shadowId = null;

  try {
    mgr._setProgress('admin', 5, 'Checking administrator privileges');
    await checkAdminPrivileges(mgr);

    mgr._setProgress('connect', 10, 'Connecting to NAS share');
    await connectWindowsSMB(sharePath, creds, mgr);
    if (mgr._cpId) mgr._checkpoint.update(mgr._cpId, 'connected', { sharePath });

    mgr._setProgress('metadata', 15, 'Capturing disk metadata');
    const metadata = await captureWindowsDiskMetadata(mgr);

    mgr._setProgress('vss', 20, 'Creating VSS shadow copy');
    const vss = await createVSS(mgr);
    shadowId = vss.shadowId;

    mgr._setProgress('wimlib', 25, 'Checking wimlib');
    const wimlibExe = await ensureWimlib(mgr);

    // Determine backup strategy (full vs incremental)
    const wiHelper = new WindowsIncrementalHelper(mgr, mgr._checkpoint);
    const strategy = await wiHelper.determineBackupStrategy({
      deviceId: config.deviceId || 'default',
      backupType: 'image',
      cpId: mgr._cpId,
    });
    wiHelper.logStrategy(strategy);

    const hostname = os.hostname();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destDir = path.join(sharePath, 'ImageBackup', hostname, timestamp);
    try { fs.mkdirSync(destDir, { recursive: true }); } catch (e) {
      throw new Error(`Could not create destination directory: ${e.message}`);
    }

    const wimPath = path.join(destDir, 'disk.wim');

    if (strategy.strategy === 'incremental') {
      mgr._setProgress('capture', 30, `Incremental: ${strategy.changedFiles.length} files`);
      await wimCaptureIncremental(wimlibExe, strategy.changedFiles, wimPath, hostname, mgr);
      await wiHelper.updateCheckpointUSN(mgr._cpId);
    } else {
      mgr._setProgress('capture', 30, 'Capturing system image (this may take a while)');
      await wimCapture(wimlibExe, vss.devicePath, wimPath, `${hostname}-C`, mgr);
      try { await wiHelper.updateCheckpointUSN(mgr._cpId); } catch (e) {
        mgr._log(`NOTE: Could not save USN state: ${e.message}`);
      }
    }

    // EFI partition (live, no VSS — FAT32 doesn't support it)
    if (metadata.efiPartition && metadata.efiPartition.DriveLetter) {
      mgr._setProgress('efi', 80, 'Capturing EFI partition');
      try {
        await wimCapture(wimlibExe, `${metadata.efiPartition.DriveLetter}:\\`, path.join(destDir, 'efi.wim'), `${hostname}-EFI`, mgr);
      } catch (e) {
        mgr._log(`WARNING: EFI capture failed (non-fatal): ${e.message}`);
      }
    }

    mgr._setProgress('manifest', 85, 'Writing backup manifest');
    await writeManifest(destDir, metadata);

    mgr._setProgress('integrity', 90, 'Generating integrity checksums (SHA256)');
    try {
      const intManifest = await generateManifest(destDir, (file, i, total) => {
        mgr._setProgress('integrity', 90 + Math.round((i / total) * 8), `Checksumming: ${file}`);
      });
      mgr._log(`Integrity manifest: ${intManifest.totalFiles} files, ${Math.round(intManifest.totalBytes / 1048576)}MB`);
    } catch (e) {
      mgr._log(`WARNING: Integrity manifest failed (non-fatal): ${e.message}`);
    }

    mgr._setProgress('done', 100, 'Backup complete');
    return { type: 'image', timestamp: new Date().toISOString() };
  } finally {
    if (shadowId) {
      mgr._setProgress('cleanup', 95, 'Cleaning up VSS shadow copy');
      await deleteVSS(shadowId, mgr);
    }
    await disconnectWindowsSMB(sharePath);
  }
}

// ─── FILE BACKUP ─────────────────────────────────────────────────────────────

async function windowsFileBackup(sharePath, paths, creds, mgr) {
  if (!paths || paths.length === 0) throw new Error('No hay carpetas configuradas para respaldar');

  mgr._setProgress('connect', 10, 'Connecting to NAS share');
  await connectWindowsDrive('Z', sharePath, creds, mgr);

  const results = [];
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destBase = `Z:\\FileBackup\\${os.hostname()}\\${timestamp}`;

  try {
    for (let i = 0; i < paths.length; i++) {
      const srcPath = paths[i];
      const folderName = path.basename(srcPath) || 'root';
      const dest = `${destBase}\\${folderName}`;
      const pct = 20 + Math.round((i / paths.length) * 70);
      mgr._setProgress('copy', pct, `Copying ${folderName}`);
      mgr._log(`robocopy: ${srcPath} -> ${dest}`);

      const result = await robocopyWithRetry(srcPath, dest, folderName, pct, mgr);
      results.push(result);
    }
  } finally {
    try { await execFileAsync('net', ['use', 'Z:', '/delete', '/y'], { shell: false }); } catch (e) {}
  }

  mgr._setProgress('done', 100, 'File backup complete');
  const failed = results.filter(r => !r.success);
  if (failed.length > 0) {
    throw new Error(`${failed.length} carpetas fallaron: ${failed.map(f => f.path).join(', ')}`);
  }
  return { type: 'files', results, timestamp: new Date().toISOString() };
}

async function robocopyWithRetry(srcPath, dest, folderName, pct, mgr) {
  try {
    await retry(
      async (attempt) => {
        if (attempt > 0) mgr._log(`robocopy retry #${attempt} for ${folderName}`);
        await execFileAsync('robocopy', [
          srcPath, dest, '/MIR', '/R:2', '/W:5', '/NP', '/NFL', '/NDL', '/MT:8',
        ], { timeout: 3600000, windowsHide: true, shell: false });
      },
      {
        maxRetries: 3,
        retryableErrors: NETWORK_ERRORS,
        onRetry: (err, attempt, delay) => {
          mgr._setProgress('copy', pct, `${folderName}: retry ${attempt} in ${Math.round(delay / 1000)}s...`);
        },
      }
    );
    return { path: srcPath, success: true };
  } catch (err) {
    if ((err.code || 0) < 8) return { path: srcPath, success: true };
    mgr._log(`ERROR: robocopy failed for ${srcPath}: exit code ${err.code}`);
    return { path: srcPath, success: false, error: err.message };
  }
}

// ─── VSS ─────────────────────────────────────────────────────────────────────

async function checkAdminPrivileges(mgr) {
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    ], { timeout: 10000, windowsHide: true, shell: false });

    if (stdout.trim().toLowerCase() !== 'true') {
      throw new Error('Se requieren privilegios de Administrador para crear snapshots VSS.');
    }
    mgr._log('Admin privileges confirmed');
  } catch (e) {
    if (e.message.includes('Administrador')) throw e;
    mgr._log(`WARNING: Could not verify admin privileges: ${e.message}`);
  }
}

async function createVSS(mgr) {
  mgr._log('Creating VSS shadow copy for C:\\');
  const psScript = [
    '$ErrorActionPreference = "Stop"',
    '$s = (Get-WmiObject -List Win32_ShadowCopy).Create("C:\\", "ClientAccessible")',
    'if ($s.ReturnValue -ne 0) { throw "VSS creation failed with code $($s.ReturnValue)" }',
    '$id = $s.ShadowID',
    '$sc = Get-WmiObject Win32_ShadowCopy | Where-Object { $_.ID -eq $id }',
    'Write-Output $id',
    'Write-Output $sc.DeviceObject',
  ].join('; ');

  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', psScript,
  ], { timeout: 120000, windowsHide: true, shell: false });

  const lines = stdout.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) {
    throw new Error(`VSS: could not parse output: ${stdout.substring(0, 300)}`);
  }

  let devicePath = lines[1];
  if (!devicePath.endsWith('\\')) devicePath += '\\';

  return { shadowId: lines[0], devicePath };
}

async function deleteVSS(shadowId, mgr) {
  try {
    if (!/^\{?[0-9a-fA-F-]+\}?$/.test(shadowId)) {
      mgr._log(`WARNING: Invalid shadow ID, skipping: ${shadowId}`);
      return;
    }
    const psScript = `$sc = Get-WmiObject Win32_ShadowCopy | Where-Object { $_.ID -eq '${shadowId}' }; if ($sc) { $sc.Delete() }`;
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', psScript,
    ], { timeout: 30000, windowsHide: true, shell: false });
    mgr._log(`VSS shadow ${shadowId} deleted`);
  } catch (e) {
    mgr._log(`WARNING: VSS cleanup failed: ${e.message}`);
  }
}

// ─── WIMLIB ──────────────────────────────────────────────────────────────────

function getWimlibPath() {
  const wimlibDir = path.join(process.env.LOCALAPPDATA || '', 'HomePiNAS', 'wimlib');
  const candidates = [path.join(wimlibDir, 'wimlib-imagex.exe')];

  if (fs.existsSync(wimlibDir)) {
    try {
      for (const entry of fs.readdirSync(wimlibDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          candidates.push(path.join(wimlibDir, entry.name, 'wimlib-imagex.exe'));
        }
      }
    } catch (e) {}
  }

  return candidates.find(c => c && fs.existsSync(c)) || null;
}

async function ensureWimlib(mgr) {
  let wimlibPath = getWimlibPath();
  if (wimlibPath) {
    mgr._log(`wimlib found: ${wimlibPath}`);
    return wimlibPath;
  }

  mgr._log('wimlib not found, downloading...');
  const installDir = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'HomePiNAS', 'wimlib'
  );
  if (!fs.existsSync(installDir)) fs.mkdirSync(installDir, { recursive: true });

  const zipUrl = 'https://wimlib.net/downloads/wimlib-1.14.4-windows-x86_64-bin.zip';
  const zipPath = path.join(installDir, 'wimlib.zip');

  await execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '${zipUrl}' -OutFile '${zipPath}' -UseBasicParsing`,
  ], { timeout: 120000, windowsHide: true, shell: false });

  await execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -Path '${zipPath}' -DestinationPath '${installDir}' -Force`,
  ], { timeout: 60000, windowsHide: true, shell: false });

  try { fs.unlinkSync(zipPath); } catch (e) {}

  wimlibPath = getWimlibPath();
  if (!wimlibPath) throw new Error('Failed to find wimlib-imagex.exe after download.');
  mgr._log(`wimlib installed: ${wimlibPath}`);
  return wimlibPath;
}

/**
 * Capture source into WIM file using wimlib-imagex.
 * Shared between full and EFI captures.
 */
function wimCapture(wimlibExe, sourcePath, destWimPath, imageName, mgr) {
  const destDir = path.dirname(destWimPath);
  if (!fs.existsSync(destDir)) {
    try { fs.mkdirSync(destDir, { recursive: true }); } catch (e) {}
  }
  mgr._log(`wimcapture: ${sourcePath} -> ${destWimPath}`);

  const args = [
    'capture', sourcePath, destWimPath, imageName || os.hostname(),
    '--compress=LZX', `--threads=${os.cpus().length}`, '--no-acls',
  ];

  return _runWimProcess(wimlibExe, args, 14400000, mgr);
}

/**
 * Capture only changed files (incremental) into a delta WIM.
 */
async function wimCaptureIncremental(wimlibExe, changedFiles, destWimPath, hostname, mgr) {
  mgr._log(`wimcapture incremental: ${changedFiles.length} files`);

  const tempDir = path.join(
    process.env.LOCALAPPDATA || 'C:\\ProgramData',
    'HomePiNAS', 'incremental-temp', `${Date.now()}`
  );

  try {
    fs.mkdirSync(tempDir, { recursive: true });
    let staged = 0;

    for (const file of changedFiles) {
      const src = file.path || file;
      if (!fs.existsSync(src)) continue;

      const relPath = src.replace(/^[A-Z]:\\/i, '').replace(/\\/g, path.sep);
      const dest = path.join(tempDir, relPath);
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        try { fs.symlinkSync(src, dest, 'file'); } catch (e) { fs.copyFileSync(src, dest); }
        staged++;
      } catch (e) {
        mgr._log(`WARNING: Could not stage ${src}: ${e.message}`);
      }
    }

    mgr._log(`Staged ${staged}/${changedFiles.length} files`);
    const imageName = `${hostname}-C-incremental-${new Date().toISOString().split('T')[0]}`;
    const args = [
      'capture', tempDir, destWimPath, imageName,
      '--compress=LZX', `--threads=${os.cpus().length}`, '--no-acls',
    ];

    return _runWimProcess(wimlibExe, args, 7200000, mgr);
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
  }
}

/** Shared spawn wrapper for wimlib processes. */
function _runWimProcess(wimlibExe, args, timeoutMs, mgr) {
  return new Promise((resolve, reject) => {
    const proc = spawn(wimlibExe, args, {
      timeout: timeoutMs,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    proc.stdout.on('data', (data) => {
      for (const line of data.toString().split(/\r?\n/).filter(Boolean)) {
        const match = line.match(/(\d+)%/);
        if (match) {
          mgr._setProgress('capture', 30 + Math.round(parseInt(match[1]) * 0.5), line.trim());
        }
      }
    });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code === 0 || code === 47) {
        mgr._log(`wimcapture completed (exit ${code})`);
        resolve();
      } else {
        reject(new Error(`wimcapture failed (exit ${code}): ${stderr.substring(0, 500)}`));
      }
    });
    proc.on('error', (err) => reject(new Error(`wimcapture spawn error: ${err.message}`)));
  });
}

// ─── METADATA & MANIFEST ────────────────────────────────────────────────────

async function captureWindowsDiskMetadata(mgr) {
  const metadata = {
    hostname: os.hostname(),
    timestamp: new Date().toISOString(),
    platform: process.platform,
    arch: os.arch(),
    totalMemory: os.totalmem(),
    partitions: [],
    efiPartition: null,
  };

  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-Partition | Select-Object DiskNumber,PartitionNumber,DriveLetter,Size,Type,GptType,IsSystem | ConvertTo-Json -Compress',
    ], { timeout: 15000, windowsHide: true, shell: false });

    const parsed = JSON.parse(stdout);
    metadata.partitions = Array.isArray(parsed) ? parsed : [parsed];
    metadata.efiPartition = metadata.partitions.find(p =>
      p.Type === 'System' || (p.GptType && p.GptType.toLowerCase().includes('c12a7328'))
    ) || null;
    mgr._log(`Found ${metadata.partitions.length} partitions, EFI: ${metadata.efiPartition ? 'yes' : 'no'}`);
  } catch (e) {
    mgr._log(`WARNING: Could not capture partition info: ${e.message}`);
  }

  try {
    const { stdout } = await execFileAsync('bcdedit', ['/enum'], { timeout: 10000, windowsHide: true, shell: false });
    metadata.bootConfig = stdout.substring(0, 2000);
  } catch (e) {
    mgr._log(`WARNING: Could not capture bcdedit info: ${e.message}`);
  }

  return metadata;
}

async function writeManifest(destDir, metadata) {
  const tempDir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'HomePiNAS', 'temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const tempPath = path.join(tempDir, `manifest-${Date.now()}.json`);
  const destPath = path.join(destDir, 'manifest.json');

  try {
    fs.writeFileSync(tempPath, JSON.stringify(metadata, null, 2), 'utf8');
    if (destDir.startsWith('\\\\')) {
      await execFileAsync('cmd.exe', ['/c', 'copy', '/y', tempPath, destPath], { timeout: 15000, windowsHide: true, shell: false });
    } else {
      fs.copyFileSync(tempPath, destPath);
    }
  } finally {
    try { fs.unlinkSync(tempPath); } catch (e) {}
  }
}

module.exports = { runWindowsBackup };
