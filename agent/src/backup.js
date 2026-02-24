/**
 * Backup Manager - Execute backups on Windows/Mac/Linux
 * Windows: wimcapture (image) or robocopy (files)
 * Linux:   partclone (image) or rsync (files)
 * Mac:     rsync (files only — Apple restrictions prevent full image restore)
 *
 * SECURITY: Uses execFile (no shell) to prevent command injection.
 * Credentials are never interpolated into command strings.
 */

const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CheckpointManager } = require('./checkpoint');
const { generateManifest, hashFile } = require('./integrity');
const { retry, NETWORK_ERRORS } = require('./retry');
const { WindowsIncrementalHelper } = require('./windows-incremental');

const execFileAsync = promisify(execFile);

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

  _setProgress(phase, percent, detail) {
    this._progress = { phase, percent: Math.min(100, Math.max(0, percent)), detail };
    this._log(`[${phase}] ${percent}% — ${detail}`);
  }

  _log(msg) {
    const ts = new Date().toISOString();
    const line = `${ts} ${msg}`;
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
    if (this._logFile) {
      try {
        fs.writeFileSync(this._logFile, this._logLines.join('\n') + '\n');
      } catch (e) {
        console.error('[Backup] Could not write log file:', e.message);
      }
    }
  }

  async runBackup(config) {
    if (this.running) throw new Error('Backup already running');
    this.running = true;
    this._progress = null;
    this._initLog();

    // Check for existing checkpoint (resume support)
    const cpId = this._checkpoint.checkpointId(config.deviceId || 'default', config.backupType || 'full');
    const existingCp = this._checkpoint.load(cpId);
    if (existingCp) {
      this._log(`Resuming from checkpoint: phase=${existingCp.phase}, processedBytes=${existingCp.processedBytes}`);
    } else {
      this._checkpoint.create(cpId, {
        deviceId: config.deviceId,
        backupType: config.backupType,
        startedAt: Date.now(),
      });
    }

    try {
      let result;
      // Store cpId for use in sub-methods
      this._cpId = cpId;

      if (this.platform === 'win32') {
        result = await this._runWindowsBackup(config);
      } else if (this.platform === 'darwin') {
        result = await this._runMacBackup(config);
      } else if (this.platform === 'linux') {
        result = await this._runLinuxBackup(config);
      } else {
        throw new Error(`Plataforma no soportada: ${this.platform}`);
      }

      // Clear checkpoint on success
      this._checkpoint.clear(cpId);

      this._log(`=== Backup completed successfully ===`);
      result.log = this.logContent;
      this._flushLog();
      return result;
    } catch (err) {
      // Checkpoint is preserved for resume on next attempt
      this._log(`=== Backup FAILED: ${err.message} (checkpoint preserved for resume) ===`);
      this._flushLog();
      err.backupLog = this.logContent;
      throw err;
    } finally {
      this.running = false;
      this._progress = null;
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // WINDOWS
  // ════════════════════════════════════════════════════════════════════════════

  async _runWindowsBackup(config) {
    const { nasAddress, backupType, sambaShare, sambaUser, sambaPass } = config;
    const shareName = sambaShare || 'active-backup';
    const sharePath = `\\\\${nasAddress}\\${shareName}`;

    if (!sambaUser || !sambaPass) {
      throw new Error('Samba credentials are required for backup');
    }
    const creds = { user: sambaUser, pass: sambaPass };

    if (backupType === 'image') {
      return this._windowsImageBackup(sharePath, creds);
    } else {
      return this._windowsFileBackup(sharePath, config.backupPaths, creds);
    }
  }

  async _windowsImageBackup(sharePath, creds) {
    const server = sharePath.split('\\').filter(Boolean)[0];
    let shadowId = null;

    try {
      // Phase 1: Check admin privileges
      this._setProgress('admin', 5, 'Checking administrator privileges');
      await this._checkAdminPrivileges();

      // Phase 2: Connect SMB share (with retry + backoff)
      this._setProgress('connect', 10, 'Connecting to NAS share');
      await this._cleanSMBConnections(server, sharePath);
      await retry(
        async (attempt) => {
          if (attempt > 0) this._log(`SMB connect retry #${attempt}`);
          await execFileAsync('net', ['use', sharePath, `/user:${creds.user}`, creds.pass, '/persistent:no'], { shell: false });
        },
        {
          maxRetries: 5,
          retryableErrors: NETWORK_ERRORS,
          onRetry: (err, attempt, delay) => {
            this._setProgress('connect', 10, `Connection failed, retry ${attempt} in ${Math.round(delay / 1000)}s...`);
          },
        }
      );
      this._log(`Connected to ${sharePath}`);
      if (this._cpId) this._checkpoint.update(this._cpId, 'connected', { sharePath });

      // Phase 3: Capture disk metadata
      this._setProgress('metadata', 15, 'Capturing disk metadata');
      const metadata = await this._captureWindowsDiskMetadata();

      // Phase 4: Create VSS snapshot
      this._setProgress('vss', 20, 'Creating VSS shadow copy');
      const vss = await this._createVSS();
      shadowId = vss.shadowId;
      this._log(`VSS shadow created: ID=${shadowId}, path=${vss.devicePath}`);

      // Phase 5: Ensure wimlib is available
      this._setProgress('wimlib', 25, 'Checking wimlib');
      const wimlibExe = await this._ensureWimlib();

      // Phase 6: Determine backup strategy (full vs incremental)
      const wiHelper = new WindowsIncrementalHelper(this, this._checkpoint);
      const strategy = await wiHelper.determineBackupStrategy({
        deviceId: config.deviceId || 'default',
        backupType: 'image',
        cpId: this._cpId,
      });
      wiHelper.logStrategy(strategy);

      const hostname = os.hostname();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const destDir = path.join(sharePath, 'ImageBackup', hostname, timestamp);

      // Create destination directory
      try { fs.mkdirSync(destDir, { recursive: true }); } catch (e) {
        throw new Error(`Could not create destination directory: ${e.message}`);
      }

      const wimPath = path.join(destDir, 'disk.wim');

      if (strategy.strategy === 'incremental') {
        // Incremental: only changed files
        this._setProgress('capture', 30, `Incremental: ${strategy.changedFiles.length} files, ~${strategy.estimateMinutes}min`);
        await this._wimCaptureIncremental(wimlibExe, strategy.changedFiles, wimPath, hostname);
        await wiHelper.updateCheckpointUSN(this._cpId);
      } else {
        // Full: capture entire volume
        this._setProgress('capture', 30, 'Capturing system image (this may take a while)');
        await this._wimCapture(wimlibExe, vss.devicePath, wimPath, `${hostname}-C`);
        // Save USN state for next incremental
        try { await wiHelper.updateCheckpointUSN(this._cpId); } catch (e) {
          this._log(`NOTE: Could not save USN state (next backup will be full): ${e.message}`);
        }
      }

      // Phase 7: Capture EFI partition if present (live, no VSS — FAT32 doesn't support it)
      if (metadata.efiPartition && metadata.efiPartition.DriveLetter) {
        this._setProgress('efi', 80, 'Capturing EFI partition (live, no VSS)');
        const efiLetter = metadata.efiPartition.DriveLetter;
        const efiWimPath = path.join(destDir, 'efi.wim');
        try {
          await this._wimCapture(wimlibExe, `${efiLetter}:\\`, efiWimPath, `${hostname}-EFI`);
        } catch (e) {
          this._log(`WARNING: EFI capture failed (non-fatal): ${e.message}`);
        }
      }

      // Phase 8: Write manifest via temp file
      this._setProgress('manifest', 85, 'Writing backup manifest');
      await this._writeManifest(destDir, metadata);

      // Phase 9: Generate integrity checksums
      this._setProgress('integrity', 90, 'Generating integrity checksums (SHA256)');
      try {
        const integrityManifest = await generateManifest(destDir, (file, i, total) => {
          const pct = 90 + Math.round((i / total) * 8);
          this._setProgress('integrity', pct, `Checksumming: ${file}`);
        });
        this._log(`Integrity manifest: ${integrityManifest.totalFiles} files, ${Math.round(integrityManifest.totalBytes / 1048576)}MB`);
      } catch (e) {
        this._log(`WARNING: Integrity manifest generation failed (non-fatal): ${e.message}`);
      }

      this._setProgress('done', 100, 'Backup complete');
      return { type: 'image', timestamp: new Date().toISOString() };

    } finally {
      // Cleanup: always delete VSS shadow and disconnect SMB
      if (shadowId) {
        this._setProgress('cleanup', 95, 'Cleaning up VSS shadow copy');
        await this._deleteVSS(shadowId);
      }
      try { await execFileAsync('net', ['use', sharePath, '/delete', '/y'], { shell: false }); } catch (e) {}
    }
  }

  async _checkAdminPrivileges() {
    try {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'
      ], { timeout: 10000, windowsHide: true, shell: false });

      if (stdout.trim().toLowerCase() !== 'true') {
        throw new Error('Se requieren privilegios de Administrador para crear snapshots VSS. Ejecute la aplicacion como Administrador.');
      }
      this._log('Admin privileges confirmed');
    } catch (e) {
      if (e.message.includes('Administrador')) throw e;
      this._log(`WARNING: Could not verify admin privileges: ${e.message}`);
    }
  }

  async _cleanSMBConnections(server, sharePath) {
    try { await execFileAsync('net', ['use', `\\\\${server}`, '/delete', '/y'], { shell: false }); } catch (e) {}
    try { await execFileAsync('net', ['use', sharePath, '/delete', '/y'], { shell: false }); } catch (e) {}

    // Clean mapped drives to this server
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

  async _createVSS() {
    this._log('Creating VSS shadow copy for C:\\');

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
      '-NoProfile', '-NonInteractive', '-Command', psScript
    ], { timeout: 120000, windowsHide: true, shell: false });

    const lines = stdout.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) {
      throw new Error(`VSS: could not parse shadow copy output: ${stdout.substring(0, 300)}`);
    }

    const shadowId = lines[0];
    // DeviceObject looks like: \\?\GLOBALROOT\Device\HarddiskVolumeShadowCopyN
    // Append trailing backslash for wimlib to treat as directory
    let devicePath = lines[1];
    if (!devicePath.endsWith('\\')) devicePath += '\\';

    return { shadowId, devicePath };
  }

  async _deleteVSS(shadowId) {
    try {
      // Validate shadowId looks like a GUID to prevent injection
      if (!/^\{?[0-9a-fA-F-]+\}?$/.test(shadowId)) {
        this._log(`WARNING: Invalid shadow ID format, skipping deletion: ${shadowId}`);
        return;
      }

      const psScript = `$sc = Get-WmiObject Win32_ShadowCopy | Where-Object { $_.ID -eq '${shadowId}' }; if ($sc) { $sc.Delete() }`;
      await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command', psScript
      ], { timeout: 30000, windowsHide: true, shell: false });
      this._log(`VSS shadow ${shadowId} deleted`);
    } catch (e) {
      this._log(`WARNING: VSS cleanup failed: ${e.message}`);
    }
  }

  _getWimlibPath() {
    const candidates = [
      path.join(process.env.LOCALAPPDATA || '', 'HomePiNAS', 'wimlib', 'wimlib-imagex.exe'),
    ];

    // Also search in subdirectories (zip may extract to a versioned subfolder)
    const wimlibDir = path.join(process.env.LOCALAPPDATA || '', 'HomePiNAS', 'wimlib');
    if (fs.existsSync(wimlibDir)) {
      try {
        const entries = fs.readdirSync(wimlibDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const nested = path.join(wimlibDir, entry.name, 'wimlib-imagex.exe');
            candidates.push(nested);
          }
        }
      } catch (e) {}
    }

    for (const c of candidates) {
      if (c && fs.existsSync(c)) return c;
    }
    return null;
  }

  async _ensureWimlib() {
    let wimlibPath = this._getWimlibPath();
    if (wimlibPath) {
      this._log(`wimlib found: ${wimlibPath}`);
      return wimlibPath;
    }

    this._log('wimlib not found, downloading...');
    const installDir = path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      'HomePiNAS', 'wimlib'
    );
    if (!fs.existsSync(installDir)) fs.mkdirSync(installDir, { recursive: true });

    const zipUrl = 'https://wimlib.net/downloads/wimlib-1.14.4-windows-x86_64-bin.zip';
    const zipPath = path.join(installDir, 'wimlib.zip');

    // Download
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '${zipUrl}' -OutFile '${zipPath}' -UseBasicParsing`
    ], { timeout: 120000, windowsHide: true, shell: false });

    // Extract
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -Path '${zipPath}' -DestinationPath '${installDir}' -Force`
    ], { timeout: 60000, windowsHide: true, shell: false });

    // Clean up zip
    try { fs.unlinkSync(zipPath); } catch (e) {}

    // Find the extracted exe
    wimlibPath = this._getWimlibPath();
    if (!wimlibPath) {
      throw new Error('Failed to find wimlib-imagex.exe after download. Check internet connection.');
    }

    this._log(`wimlib installed: ${wimlibPath}`);
    return wimlibPath;
  }

  async _wimCapture(wimlibExe, sourcePath, destWimPath, imageName) {
    const destDir = path.dirname(destWimPath);
    if (!fs.existsSync(destDir)) {
      try { fs.mkdirSync(destDir, { recursive: true }); } catch (e) {}
    }

    this._log(`wimcapture: ${sourcePath} -> ${destWimPath}`);

    const cpuCount = os.cpus().length;
    const args = [
      'capture',
      sourcePath,
      destWimPath,
      imageName || os.hostname(),
      '--compress=LZX',
      `--threads=${cpuCount}`,
      '--no-acls',
    ];

    return new Promise((resolve, reject) => {
      const proc = spawn(wimlibExe, args, {
        timeout: 14400000, // 4 hours max
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        const text = data.toString();
        stdout += text;
        // Log progress lines (wimlib prints progress percentage)
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
        if (code === 0) {
          this._log('wimcapture completed successfully');
          resolve();
        } else if (code === 47) {
          // WIMLIB_ERR_UNABLE_TO_READ — some files unreadable, but WIM is valid
          this._log(`wimcapture exited with code 47 (partial success — some files unreadable, WIM is valid)`);
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
  }

  async _wimCaptureIncremental(wimlibExe, changedFiles, destWimPath, hostname) {
    const destDir = path.dirname(destWimPath);
    if (!fs.existsSync(destDir)) {
      try { fs.mkdirSync(destDir, { recursive: true }); } catch (e) {}
    }

    this._log(`wimcapture incremental: ${changedFiles.length} files -> ${destWimPath}`);

    // Create temp directory with only changed files (symlinks for efficiency)
    const tempDir = path.join(
      process.env.LOCALAPPDATA || 'C:\\ProgramData',
      'HomePiNAS', 'incremental-temp', `${Date.now()}`
    );

    try {
      fs.mkdirSync(tempDir, { recursive: true });

      let linked = 0;
      for (const file of changedFiles) {
        const src = file.path || file;
        if (!fs.existsSync(src)) continue;

        // Preserve relative path structure from C:\
        const relPath = src.replace(/^[A-Z]:\\/i, '').replace(/\\/g, path.sep);
        const dest = path.join(tempDir, relPath);
        const destParent = path.dirname(dest);

        try {
          fs.mkdirSync(destParent, { recursive: true });
          try {
            fs.symlinkSync(src, dest, 'file');
          } catch (e) {
            fs.copyFileSync(src, dest);
          }
          linked++;
        } catch (e) {
          this._log(`WARNING: Could not stage ${src}: ${e.message}`);
        }
      }

      this._log(`Staged ${linked}/${changedFiles.length} files for incremental capture`);

      const cpuCount = os.cpus().length;
      const imageName = `${hostname}-C-incremental-${new Date().toISOString().split('T')[0]}`;
      const args = [
        'capture', tempDir, destWimPath, imageName,
        '--compress=LZX', `--threads=${cpuCount}`, '--no-acls',
      ];

      return new Promise((resolve, reject) => {
        const proc = spawn(wimlibExe, args, {
          timeout: 7200000,
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
                this._setProgress('capture', 30 + Math.round(parseInt(match[1]) * 0.5), `Incremental: ${line.trim()}`);
              }
            }
          }
        });

        proc.stderr.on('data', (data) => { stderr += data.toString(); });

        proc.on('close', (code) => {
          if (code === 0 || code === 47) {
            this._log(`wimcapture incremental completed (exit ${code})`);
            resolve();
          } else {
            reject(new Error(`wimcapture incremental failed (exit ${code}): ${(stderr || stdout).substring(0, 500)}`));
          }
        });

        proc.on('error', (err) => reject(new Error(`wimcapture spawn error: ${err.message}`)));
      });
    } finally {
      // Cleanup temp directory
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
    }
  }

  async _captureWindowsDiskMetadata() {
    const metadata = {
      hostname: os.hostname(),
      timestamp: new Date().toISOString(),
      platform: process.platform,
      arch: os.arch(),
      totalMemory: os.totalmem(),
      partitions: [],
      efiPartition: null,
    };

    // Get partition layout via PowerShell
    try {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        'Get-Partition | Select-Object DiskNumber,PartitionNumber,DriveLetter,Size,Type,GptType,IsSystem | ConvertTo-Json -Compress'
      ], { timeout: 15000, windowsHide: true, shell: false });

      const parsed = JSON.parse(stdout);
      metadata.partitions = Array.isArray(parsed) ? parsed : [parsed];

      // Detect EFI partition (FAT32/System type)
      metadata.efiPartition = metadata.partitions.find(p =>
        p.Type === 'System' ||
        (p.GptType && p.GptType.toLowerCase().includes('c12a7328'))
      ) || null;

      this._log(`Found ${metadata.partitions.length} partitions, EFI: ${metadata.efiPartition ? 'yes' : 'no'}`);
    } catch (e) {
      this._log(`WARNING: Could not capture partition info: ${e.message}`);
    }

    // Get boot config
    try {
      const { stdout } = await execFileAsync('bcdedit', ['/enum'], {
        timeout: 10000, windowsHide: true, shell: false
      });
      metadata.bootConfig = stdout.substring(0, 2000);
    } catch (e) {
      this._log(`WARNING: Could not capture bcdedit info: ${e.message}`);
    }

    return metadata;
  }

  async _writeManifest(destDir, metadata) {
    // Write to a temp file first, then copy to destination
    // This avoids issues with PowerShell escaping in JSON content
    const tempDir = path.join(
      process.env.LOCALAPPDATA || os.tmpdir(),
      'HomePiNAS', 'temp'
    );
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const tempPath = path.join(tempDir, `manifest-${Date.now()}.json`);
    const destPath = path.join(destDir, 'manifest.json');

    try {
      fs.writeFileSync(tempPath, JSON.stringify(metadata, null, 2), 'utf8');

      // If destDir is a UNC path (network share), use cmd copy for reliability
      if (destDir.startsWith('\\\\')) {
        await execFileAsync('cmd.exe', ['/c', 'copy', '/y', tempPath, destPath], {
          timeout: 15000, windowsHide: true, shell: false
        });
      } else {
        fs.copyFileSync(tempPath, destPath);
      }
      this._log('Manifest written successfully');
    } finally {
      try { fs.unlinkSync(tempPath); } catch (e) {}
    }
  }

  async _windowsFileBackup(sharePath, paths, creds) {
    if (!paths || paths.length === 0) throw new Error('No hay carpetas configuradas para respaldar');

    this._setProgress('connect', 10, 'Connecting to NAS share');
    try { await execFileAsync('net', ['use', 'Z:', '/delete', '/y'], { shell: false }); } catch (e) {}
    await retry(
      async (attempt) => {
        if (attempt > 0) this._log(`SMB connect retry #${attempt}`);
        await execFileAsync('net', ['use', 'Z:', sharePath, `/user:${creds.user}`, creds.pass, '/persistent:no'], { shell: false });
      },
      {
        maxRetries: 5,
        retryableErrors: NETWORK_ERRORS,
        onRetry: (err, attempt, delay) => {
          this._setProgress('connect', 10, `Connection failed, retry ${attempt} in ${Math.round(delay / 1000)}s...`);
        },
      }
    );

    const results = [];
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destBase = `Z:\\FileBackup\\${os.hostname()}\\${timestamp}`;

    for (let i = 0; i < paths.length; i++) {
      const srcPath = paths[i];
      const folderName = path.basename(srcPath) || 'root';
      const dest = `${destBase}\\${folderName}`;
      const pct = 20 + Math.round((i / paths.length) * 70);
      this._setProgress('copy', pct, `Copying ${folderName}`);
      this._log(`robocopy: ${srcPath} -> ${dest}`);

      try {
        await retry(
          async (attempt) => {
            if (attempt > 0) this._log(`robocopy retry #${attempt} for ${folderName}`);
            await execFileAsync('robocopy', [
              srcPath, dest,
              '/MIR', '/R:2', '/W:5', '/NP', '/NFL', '/NDL', '/MT:8'
            ], { timeout: 3600000, windowsHide: true, shell: false });
          },
          {
            maxRetries: 3,
            retryableErrors: NETWORK_ERRORS,
            onRetry: (err, attempt, delay) => {
              this._setProgress('copy', pct, `${folderName}: retry ${attempt} in ${Math.round(delay / 1000)}s...`);
            },
          }
        );
        results.push({ path: srcPath, success: true });
      } catch (err) {
        const exitCode = err.code || 0;
        if (exitCode < 8) {
          results.push({ path: srcPath, success: true });
        } else {
          this._log(`ERROR: robocopy failed for ${srcPath}: exit code ${exitCode}`);
          results.push({ path: srcPath, success: false, error: err.message });
        }
      }
    }

    try { await execFileAsync('net', ['use', 'Z:', '/delete', '/y'], { shell: false }); } catch (e) {}

    this._setProgress('done', 100, 'File backup complete');
    const failed = results.filter(r => !r.success);
    if (failed.length > 0) throw new Error(`${failed.length} carpetas fallaron: ${failed.map(f => f.path).join(', ')}`);

    return { type: 'files', results, timestamp: new Date().toISOString() };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // MAC
  // ════════════════════════════════════════════════════════════════════════════

  async _runMacBackup(config) {
    const { nasAddress, backupType, backupPaths, sambaShare, sambaUser, sambaPass } = config;
    const shareName = sambaShare || 'active-backup';

    if (!sambaUser || !sambaPass) {
      throw new Error('Samba credentials are required for backup');
    }
    const creds = { user: sambaUser, pass: sambaPass };

    if (backupType === 'image') {
      return this._macImageBackup(nasAddress, shareName, creds);
    } else {
      return this._macFileBackup(nasAddress, shareName, creds, backupPaths);
    }
  }

  async _macImageBackup(nasAddress, shareName, creds) {
    const mountPoint = '/Volumes/homepinas-backup';
    try { await execFileAsync('mkdir', ['-p', mountPoint]); } catch (e) {}

    const smbUrl = `smb://${encodeURIComponent(creds.user)}:${encodeURIComponent(creds.pass)}@${nasAddress}/${shareName}`;
    await retry(
      async (attempt) => {
        if (attempt > 0) this._log(`SMB mount retry #${attempt}`);
        await execFileAsync('mount_smbfs', ['-N', smbUrl, mountPoint]);
      },
      {
        maxRetries: 5,
        retryableErrors: NETWORK_ERRORS,
        onRetry: (err, attempt, delay) => {
          this._setProgress('connect', 10, `Mount failed, retry ${attempt} in ${Math.round(delay / 1000)}s...`);
        },
      }
    );

    const hostname = os.hostname();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destPath = `${mountPoint}/ImageBackup/${hostname}/${timestamp}`;

    try {
      await execFileAsync('mkdir', ['-p', destPath]);
      this._setProgress('capture', 30, 'Creating system image with asr');
      await execFileAsync('sudo', ['asr', 'create', '--source', '/', '--target', `${destPath}/system.dmg`, '--erase', '--noprompt'], { timeout: 7200000 });
      this._setProgress('done', 100, 'Image backup complete');
      return { type: 'image', timestamp: new Date().toISOString() };
    } finally {
      try { await execFileAsync('umount', [mountPoint]); } catch (e) {}
    }
  }

  async _macFileBackup(nasAddress, shareName, creds, paths) {
    if (!paths || paths.length === 0) throw new Error('No hay carpetas configuradas para respaldar');

    const mountPoint = '/Volumes/homepinas-backup';
    try { await execFileAsync('mkdir', ['-p', mountPoint]); } catch (e) {}

    const smbUrl = `smb://${encodeURIComponent(creds.user)}:${encodeURIComponent(creds.pass)}@${nasAddress}/${shareName}`;
    await retry(
      async (attempt) => {
        if (attempt > 0) this._log(`SMB mount retry #${attempt}`);
        await execFileAsync('mount_smbfs', ['-N', smbUrl, mountPoint]);
      },
      {
        maxRetries: 5,
        retryableErrors: NETWORK_ERRORS,
        onRetry: (err, attempt, delay) => {
          this._setProgress('connect', 10, `Mount failed, retry ${attempt} in ${Math.round(delay / 1000)}s...`);
        },
      }
    );

    const hostname = os.hostname();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const results = [];

    try {
      for (let i = 0; i < paths.length; i++) {
        const srcPath = paths[i];
        const folderName = path.basename(srcPath) || 'root';
        const dest = `${mountPoint}/FileBackup/${hostname}/${timestamp}/${folderName}`;
        const pct = 20 + Math.round((i / paths.length) * 70);
        this._setProgress('copy', pct, `Copying ${folderName}`);

        try {
          await execFileAsync('mkdir', ['-p', dest]);
          await retry(
            async (attempt) => {
              if (attempt > 0) this._log(`rsync retry #${attempt} for ${folderName}`);
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

    this._setProgress('done', 100, 'File backup complete');
    return { type: 'files', results, timestamp: new Date().toISOString() };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // LINUX
  // ════════════════════════════════════════════════════════════════════════════

  async _runLinuxBackup(config) {
    const { nasAddress, backupType, backupPaths, sambaShare, sambaUser, sambaPass } = config;
    const shareName = sambaShare || 'active-backup';

    if (!sambaUser || !sambaPass) {
      throw new Error('Samba credentials are required for backup');
    }
    const creds = { user: sambaUser, pass: sambaPass };

    if (backupType === 'image') {
      return this._linuxImageBackup(nasAddress, shareName, creds);
    } else {
      return this._linuxFileBackup(nasAddress, shareName, creds, backupPaths);
    }
  }

  async _linuxImageBackup(nasAddress, shareName, creds) {
    const mountPoint = `/tmp/homepinas-backup-${process.pid}`;
    try { await execFileAsync('mkdir', ['-p', mountPoint]); } catch (e) {}

    // Write credentials to temp file (mode 0600) for security
    const credFile = `/tmp/homepinas-creds-${process.pid}`;
    fs.writeFileSync(credFile, `username=${creds.user}\npassword=${creds.pass}\n`, { mode: 0o600 });

    try {
      this._setProgress('connect', 10, 'Mounting SMB share');
      await retry(
        async (attempt) => {
          if (attempt > 0) this._log(`CIFS mount retry #${attempt}`);
          await execFileAsync('mount', [
            '-t', 'cifs',
            `//${nasAddress}/${shareName}`,
            mountPoint,
            '-o', `credentials=${credFile},vers=3.0`
          ]);
        },
        {
          maxRetries: 5,
          retryableErrors: NETWORK_ERRORS,
          onRetry: (err, attempt, delay) => {
            this._setProgress('connect', 10, `Mount failed, retry ${attempt} in ${Math.round(delay / 1000)}s...`);
          },
        }
      );

      const hostname = os.hostname();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const destPath = `${mountPoint}/ImageBackup/${hostname}/${timestamp}`;
      await execFileAsync('mkdir', ['-p', destPath]);

      // Find root device and filesystem
      const { stdout: rootDev } = await execFileAsync('findmnt', ['-n', '-o', 'SOURCE', '/']);
      const { stdout: rootFs } = await execFileAsync('findmnt', ['-n', '-o', 'FSTYPE', '/']);
      const device = rootDev.trim();
      const fsType = rootFs.trim();

      this._log(`Root device: ${device} (${fsType})`);
      this._setProgress('capture', 30, `Capturing ${device} with partclone`);

      const imgFile = path.join(destPath, 'root.img.gz');

      // Use partclone for the detected filesystem, piped through gzip
      return new Promise((resolve, reject) => {
        const partclone = spawn('partclone.' + fsType, ['-c', '-s', device, '-o', '-'], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const gzip = spawn('gzip', ['-c'], {
          stdio: ['pipe', fs.openSync(imgFile, 'w'), 'pipe'],
        });

        partclone.stdout.pipe(gzip.stdin);

        let stderr = '';
        partclone.stderr.on('data', (d) => { stderr += d.toString(); });

        gzip.on('close', (code) => {
          if (code === 0) {
            this._setProgress('done', 100, 'Image backup complete');
            resolve({ type: 'image', timestamp: new Date().toISOString() });
          } else {
            reject(new Error(`gzip failed with code ${code}`));
          }
        });

        partclone.on('close', (code) => {
          if (code !== 0) {
            gzip.stdin.end();
            reject(new Error(`partclone failed with code ${code}: ${stderr.substring(0, 300)}`));
          }
        });

        partclone.on('error', (err) => reject(new Error(`partclone error: ${err.message}`)));
        gzip.on('error', (err) => reject(new Error(`gzip error: ${err.message}`)));
      });

    } finally {
      try { await execFileAsync('umount', [mountPoint]); } catch (e) {}
      try { await execFileAsync('rmdir', [mountPoint]); } catch (e) {}
      try { fs.unlinkSync(credFile); } catch (e) {}
    }
  }

  async _linuxFileBackup(nasAddress, shareName, creds, paths) {
    if (!paths || paths.length === 0) throw new Error('No hay carpetas configuradas para respaldar');

    const mountPoint = `/tmp/homepinas-backup-${process.pid}`;
    try { await execFileAsync('mkdir', ['-p', mountPoint]); } catch (e) {}

    const credFile = `/tmp/homepinas-creds-${process.pid}`;
    fs.writeFileSync(credFile, `username=${creds.user}\npassword=${creds.pass}\n`, { mode: 0o600 });

    try {
      this._setProgress('connect', 10, 'Mounting SMB share');
      await retry(
        async (attempt) => {
          if (attempt > 0) this._log(`CIFS mount retry #${attempt}`);
          await execFileAsync('mount', [
            '-t', 'cifs',
            `//${nasAddress}/${shareName}`,
            mountPoint,
            '-o', `credentials=${credFile},vers=3.0`
          ]);
        },
        {
          maxRetries: 5,
          retryableErrors: NETWORK_ERRORS,
          onRetry: (err, attempt, delay) => {
            this._setProgress('connect', 10, `Mount failed, retry ${attempt} in ${Math.round(delay / 1000)}s...`);
          },
        }
      );

      const hostname = os.hostname();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const results = [];

      for (let i = 0; i < paths.length; i++) {
        const srcPath = paths[i];
        const folderName = path.basename(srcPath) || 'root';
        const dest = `${mountPoint}/FileBackup/${hostname}/${timestamp}/${folderName}`;
        const pct = 20 + Math.round((i / paths.length) * 70);
        this._setProgress('copy', pct, `Copying ${folderName}`);

        try {
          await execFileAsync('mkdir', ['-p', dest]);
          await retry(
            async (attempt) => {
              if (attempt > 0) this._log(`rsync retry #${attempt} for ${folderName}`);
              await execFileAsync('rsync', ['-az', '--delete', `${srcPath}/`, `${dest}/`], { timeout: 3600000 });
            },
            { maxRetries: 3, retryableErrors: NETWORK_ERRORS, baseDelayMs: 2000 }
          );
          results.push({ path: srcPath, success: true });
        } catch (err) {
          results.push({ path: srcPath, success: false, error: err.message });
        }
      }

      this._setProgress('done', 100, 'File backup complete');
      return { type: 'files', results, timestamp: new Date().toISOString() };

    } finally {
      try { await execFileAsync('umount', [mountPoint]); } catch (e) {}
      try { await execFileAsync('rmdir', [mountPoint]); } catch (e) {}
      try { fs.unlinkSync(credFile); } catch (e) {}
    }
  }
}

module.exports = { BackupManager };
