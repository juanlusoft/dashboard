/**
 * Tests for Linux Backup (backup-linux.js)
 *
 * All OS-level calls (execFile, spawn, fs) are mocked. Tests validate:
 *   - Image vs file mode dispatch
 *   - Credential validation
 *   - CIFS mount/unmount lifecycle
 *   - Credentials file creation and cleanup
 *   - partclone + gzip pipeline (spawn)
 *   - rsync retry on file backup
 *   - Always-cleanup guarantee in finally blocks
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

// ─── Mocks ───────────────────────────────────────────────────────────────────

jest.mock('child_process', () => ({
  execFile: jest.fn(),
  spawn: jest.fn(),
}));

jest.mock('../src/retry', () => {
  const actual = jest.requireActual('../src/retry');
  return {
    ...actual,
    retry: jest.fn(async (fn, _opts) => fn(0)),
  };
});

jest.mock('../src/smb-connect', () => ({
  mountLinuxCIFS: jest.fn().mockResolvedValue(undefined),
  writeCredFile: jest.fn((creds, pid) =>
    require('path').join(require('os').tmpdir(), `homepinas-creds-${pid}`)
  ),
}));

const { execFile, spawn } = require('child_process');
const { retry } = require('../src/retry');
const { mountLinuxCIFS, writeCredFile } = require('../src/smb-connect');
const { runLinuxBackup } = require('../src/backup-linux');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeManager() {
  return {
    _log: jest.fn(),
    _setProgress: jest.fn(),
  };
}

function makeExecFileSuccess(stdoutMap = {}) {
  execFile.mockImplementation((cmd, args, _opts, cb) => {
    const done = typeof _opts === 'function' ? _opts : cb;
    const key = [cmd, ...(args || [])].join(' ');
    const match = Object.keys(stdoutMap).find(k => key.includes(k));
    const stdout = match ? stdoutMap[match] : '';
    process.nextTick(() => done(null, { stdout, stderr: '' }));
  });
}

/**
 * Build two cooperating mock spawns for the partclone | gzip pipeline.
 * partcloneExitCode: 0=success, anything else = error
 * gzipExitCode: 0=success, anything else = error
 */
function makeMockPartclonePipeline(partcloneExitCode = 0, gzipExitCode = 0) {
  spawn.mockImplementation((cmd, args) => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const stdin = new EventEmitter();
    stdin.end = jest.fn();
    const proc = new EventEmitter();
    proc.stdout = stdout;
    proc.stderr = stderr;
    proc.stdin = stdin;

    if (cmd.startsWith('partclone')) {
      setImmediate(() => {
        stderr.emit('data', Buffer.from('Partclone v0.3.13 - http://partclone.org\n'));
        proc.emit('close', partcloneExitCode);
      });
    } else if (cmd === 'gzip') {
      setImmediate(() => {
        proc.emit('close', gzipExitCode);
      });
    } else {
      setImmediate(() => proc.emit('close', 0));
    }

    // pipe method for partclone.stdout.pipe(gzip.stdin)
    stdout.pipe = jest.fn();

    return proc;
  });
}

const makeImageConfig = (overrides = {}) => ({
  nasAddress: '192.168.1.100',
  backupType: 'image',
  sambaShare: 'active-backup',
  sambaUser: 'admin',
  sambaPass: 'secret',
  deviceId: 'test-linux',
  ...overrides,
});

const makeFileConfig = (overrides = {}) => ({
  nasAddress: '192.168.1.100',
  backupType: 'files',
  sambaShare: 'active-backup',
  sambaUser: 'admin',
  sambaPass: 'secret',
  backupPaths: ['/home/user/Documents', '/home/user/Pictures'],
  ...overrides,
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('runLinuxBackup', () => {
  beforeEach(() => {
    // resetAllMocks clears implementations too, preventing state leaks between tests
    jest.resetAllMocks();

    // Re-establish default mock behaviors after reset
    mountLinuxCIFS.mockResolvedValue(undefined);
    writeCredFile.mockImplementation((creds, pid) =>
      require('path').join(require('os').tmpdir(), `homepinas-creds-${pid}`)
    );
    retry.mockImplementation(async (fn, _opts) => fn(0));

    execFile.mockImplementation((cmd, args, _opts, cb) => {
      const done = typeof _opts === 'function' ? _opts : cb;
      const allArgs = [cmd, ...(args || [])].join(' ');
      if (allArgs.includes('SOURCE')) {
        process.nextTick(() => done(null, { stdout: '/dev/sda1\n', stderr: '' }));
      } else if (allArgs.includes('FSTYPE')) {
        process.nextTick(() => done(null, { stdout: 'ext4\n', stderr: '' }));
      } else {
        process.nextTick(() => done(null, { stdout: '', stderr: '' }));
      }
    });

    makeMockPartclonePipeline(0, 0);

    jest.spyOn(fs, 'openSync').mockReturnValue(42);
    jest.spyOn(fs, 'unlinkSync').mockImplementation(() => {});
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ─── Credential validation ────────────────────────────────────────────────

  describe('credential validation', () => {
    it('throws when sambaUser is missing', async () => {
      await expect(
        runLinuxBackup(makeImageConfig({ sambaUser: '' }), makeManager())
      ).rejects.toThrow(/credentials/i);
    });

    it('throws when sambaPass is missing', async () => {
      await expect(
        runLinuxBackup(makeImageConfig({ sambaPass: '' }), makeManager())
      ).rejects.toThrow(/credentials/i);
    });
  });

  // ─── Credentials file ─────────────────────────────────────────────────────

  describe('credentials file', () => {
    it('creates cred file before mount and deletes after', async () => {
      const mgr = makeManager();
      await runLinuxBackup(makeImageConfig(), mgr);

      expect(writeCredFile).toHaveBeenCalledWith(
        { user: 'admin', pass: 'secret' },
        process.pid
      );
    });

    it('always deletes cred file even on failure', async () => {
      mountLinuxCIFS.mockRejectedValue(new Error('mount failed'));
      const mgr = makeManager();

      await expect(runLinuxBackup(makeImageConfig(), mgr)).rejects.toThrow('mount failed');

      // fs.unlinkSync should have been called on the cred file
      const credPath = require('path').join(require('os').tmpdir(), `homepinas-creds-${process.pid}`);
      const unlinkCalls = fs.unlinkSync.mock.calls;
      const credUnlink = unlinkCalls.find(c => c[0] === credPath);
      expect(credUnlink).toBeDefined();
    });
  });

  // ─── Image backup ─────────────────────────────────────────────────────────

  describe('image backup', () => {
    it('mounts CIFS before backup', async () => {
      const mgr = makeManager();
      await runLinuxBackup(makeImageConfig(), mgr);

      expect(mountLinuxCIFS).toHaveBeenCalledWith(
        '192.168.1.100',
        'active-backup',
        expect.stringContaining(`homepinas-backup-${process.pid}`),
        expect.stringContaining(`homepinas-creds-${process.pid}`), // from os.tmpdir()
        mgr
      );
    });

    it('uses findmnt to detect root device and filesystem type', async () => {
      const mgr = makeManager();
      await runLinuxBackup(makeImageConfig(), mgr);

      const calls = execFile.mock.calls.map(c => c[0]);
      expect(calls).toContain('findmnt');
    });

    it('spawns partclone for root partition capture', async () => {
      const mgr = makeManager();
      await runLinuxBackup(makeImageConfig(), mgr);

      const spawnCalls = spawn.mock.calls;
      const partcloneCall = spawnCalls.find(c => c[0].startsWith('partclone'));
      expect(partcloneCall).toBeDefined();
      expect(partcloneCall[1]).toContain('/dev/sda1');
    });

    it('pipes partclone through gzip', async () => {
      const mgr = makeManager();
      await runLinuxBackup(makeImageConfig(), mgr);

      const spawnCalls = spawn.mock.calls;
      const gzipCall = spawnCalls.find(c => c[0] === 'gzip');
      expect(gzipCall).toBeDefined();
    });

    it('returns type image with timestamp', async () => {
      const result = await runLinuxBackup(makeImageConfig(), makeManager());
      expect(result.type).toBe('image');
      expect(result.timestamp).toBeDefined();
    });

    it('unmounts after successful image backup', async () => {
      const mgr = makeManager();
      await runLinuxBackup(makeImageConfig(), mgr);

      const calls = execFile.mock.calls.filter(c => c[0] === 'umount');
      expect(calls.length).toBeGreaterThanOrEqual(1);
    });

    it('unmounts even when partclone fails', async () => {
      makeMockPartclonePipeline(1, 0); // partclone exits with code 1
      jest.spyOn(fs, 'openSync').mockReturnValue(42);

      const mgr = makeManager();
      await expect(runLinuxBackup(makeImageConfig(), mgr)).rejects.toThrow(/partclone/i);

      const umountCalls = execFile.mock.calls.filter(c => c[0] === 'umount');
      expect(umountCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('throws when gzip exits with error', async () => {
      makeMockPartclonePipeline(0, 1); // gzip exits with code 1
      jest.spyOn(fs, 'openSync').mockReturnValue(42);

      const mgr = makeManager();
      await expect(runLinuxBackup(makeImageConfig(), mgr)).rejects.toThrow(/gzip/i);
    });

    it('uses default share name active-backup', async () => {
      const mgr = makeManager();
      await runLinuxBackup(makeImageConfig({ sambaShare: undefined }), mgr);

      expect(mountLinuxCIFS).toHaveBeenCalledWith(
        expect.any(String),
        'active-backup',
        expect.any(String),
        expect.any(String),
        mgr
      );
    });
  });

  // ─── File backup ──────────────────────────────────────────────────────────

  describe('file backup', () => {
    it('throws when backupPaths is empty', async () => {
      await expect(
        runLinuxBackup(makeFileConfig({ backupPaths: [] }), makeManager())
      ).rejects.toThrow(/carpetas/i);
    });

    it('throws when backupPaths is undefined', async () => {
      await expect(
        runLinuxBackup(makeFileConfig({ backupPaths: undefined }), makeManager())
      ).rejects.toThrow(/carpetas/i);
    });

    it('returns type files with results array', async () => {
      const mgr = makeManager();
      const result = await runLinuxBackup(makeFileConfig(), mgr);
      expect(result.type).toBe('files');
      expect(Array.isArray(result.results)).toBe(true);
      expect(result.results).toHaveLength(2);
    });

    it('marks each path as success when rsync succeeds', async () => {
      const mgr = makeManager();
      const result = await runLinuxBackup(makeFileConfig(), mgr);
      expect(result.results.every(r => r.success)).toBe(true);
    });

    it('marks path as failure when rsync throws', async () => {
      let rsyncCallCount = 0;
      retry.mockImplementation(async (fn) => {
        rsyncCallCount++;
        if (rsyncCallCount === 1) throw new Error('rsync: connection timed out');
        return fn(0);
      });

      const mgr = makeManager();
      const result = await runLinuxBackup(makeFileConfig(), mgr);

      expect(result.results[0].success).toBe(false);
      expect(result.results[1].success).toBe(true);
    });

    it('always unmounts after file backup', async () => {
      const mgr = makeManager();
      await runLinuxBackup(makeFileConfig(), mgr);

      const umountCalls = execFile.mock.calls.filter(c => c[0] === 'umount');
      expect(umountCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('unmounts even when all rsync calls fail', async () => {
      retry.mockRejectedValue(new Error('rsync: no space left on device'));

      const mgr = makeManager();
      const result = await runLinuxBackup(makeFileConfig(), mgr);
      expect(result.results.every(r => !r.success)).toBe(true);

      const umountCalls = execFile.mock.calls.filter(c => c[0] === 'umount');
      expect(umountCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('deletes cred file after file backup', async () => {
      const mgr = makeManager();
      await runLinuxBackup(makeFileConfig(), mgr);

      const credPath = require('path').join(require('os').tmpdir(), `homepinas-creds-${process.pid}`);
      const unlinkCalls = fs.unlinkSync.mock.calls;
      const credUnlink = unlinkCalls.find(c => c[0] === credPath);
      expect(credUnlink).toBeDefined();
    });

    it('tracks progress for each folder', async () => {
      const mgr = makeManager();
      await runLinuxBackup(makeFileConfig(), mgr);

      const copyCalls = mgr._setProgress.mock.calls.filter(c => c[0] === 'copy');
      expect(copyCalls.length).toBe(2);
    });
  });
});
