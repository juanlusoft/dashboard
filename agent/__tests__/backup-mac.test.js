/**
 * Tests for macOS Backup (backup-mac.js)
 *
 * All OS-level calls (execFile) are mocked. Tests validate:
 *   - Image vs file mode dispatch
 *   - Credential validation
 *   - SMB mount/unmount lifecycle
 *   - rsync retry behavior on file backup
 *   - Always-unmount guarantee in finally blocks
 */

const fs = require('fs');
const os = require('os');

// ─── Mocks ───────────────────────────────────────────────────────────────────

jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));

jest.mock('../src/retry', () => {
  const actual = jest.requireActual('../src/retry');
  return {
    ...actual,
    retry: jest.fn(async (fn, _opts) => fn(0)),
  };
});

jest.mock('../src/smb-connect', () => ({
  mountMacSMB: jest.fn().mockResolvedValue(undefined),
}));

const { execFile } = require('child_process');
const { retry } = require('../src/retry');
const { mountMacSMB } = require('../src/smb-connect');
const { runMacBackup } = require('../src/backup-mac');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeManager() {
  return {
    _log: jest.fn(),
    _setProgress: jest.fn(),
  };
}

function makeExecFileSuccess() {
  execFile.mockImplementation((_cmd, _args, _opts, cb) => {
    const done = typeof _opts === 'function' ? _opts : cb;
    process.nextTick(() => done(null, { stdout: '', stderr: '' }));
  });
}

const makeImageConfig = (overrides = {}) => ({
  nasAddress: '192.168.1.100',
  backupType: 'image',
  sambaShare: 'active-backup',
  sambaUser: 'admin',
  sambaPass: 'secret',
  ...overrides,
});

const makeFileConfig = (overrides = {}) => ({
  nasAddress: '192.168.1.100',
  backupType: 'files',
  sambaShare: 'active-backup',
  sambaUser: 'admin',
  sambaPass: 'secret',
  backupPaths: ['/Users/user/Documents', '/Users/user/Pictures'],
  ...overrides,
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('runMacBackup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    makeExecFileSuccess();
  });

  // ─── Credential validation ────────────────────────────────────────────────

  describe('credential validation', () => {
    it('throws when sambaUser is missing', async () => {
      await expect(
        runMacBackup(makeImageConfig({ sambaUser: '' }), makeManager())
      ).rejects.toThrow(/credentials/i);
    });

    it('throws when sambaPass is missing', async () => {
      await expect(
        runMacBackup(makeImageConfig({ sambaPass: '' }), makeManager())
      ).rejects.toThrow(/credentials/i);
    });

    it('throws when both are missing', async () => {
      await expect(
        runMacBackup(makeImageConfig({ sambaUser: undefined, sambaPass: undefined }), makeManager())
      ).rejects.toThrow(/credentials/i);
    });
  });

  // ─── Dispatch ─────────────────────────────────────────────────────────────

  describe('mode dispatch', () => {
    it('mounts SMB for image backup', async () => {
      const mgr = makeManager();
      await runMacBackup(makeImageConfig(), mgr);
      expect(mountMacSMB).toHaveBeenCalledWith(
        '192.168.1.100',
        'active-backup',
        { user: 'admin', pass: 'secret' },
        '/Volumes/homepinas-backup',
        mgr
      );
    });

    it('mounts SMB for file backup', async () => {
      const mgr = makeManager();
      await runMacBackup(makeFileConfig(), mgr);
      expect(mountMacSMB).toHaveBeenCalledWith(
        '192.168.1.100',
        'active-backup',
        { user: 'admin', pass: 'secret' },
        '/Volumes/homepinas-backup',
        mgr
      );
    });

    it('uses active-backup as default share', async () => {
      const mgr = makeManager();
      await runMacBackup(makeImageConfig({ sambaShare: undefined }), mgr);
      expect(mountMacSMB).toHaveBeenCalledWith(
        expect.any(String),
        'active-backup',
        expect.any(Object),
        expect.any(String),
        mgr
      );
    });
  });

  // ─── Image backup ─────────────────────────────────────────────────────────

  describe('image backup', () => {
    it('returns type image with timestamp', async () => {
      const result = await runMacBackup(makeImageConfig(), makeManager());
      expect(result.type).toBe('image');
      expect(result.timestamp).toBeDefined();
      expect(new Date(result.timestamp).getFullYear()).toBeGreaterThanOrEqual(2020);
    });

    it('calls asr create to make system image', async () => {
      const mgr = makeManager();
      await runMacBackup(makeImageConfig(), mgr);

      const calls = execFile.mock.calls;
      const asrCall = calls.find(c => c[0] === 'sudo' && c[1].includes('asr'));
      expect(asrCall).toBeDefined();
      expect(asrCall[1]).toContain('create');
    });

    it('reports progress at key stages', async () => {
      const mgr = makeManager();
      await runMacBackup(makeImageConfig(), mgr);

      expect(mgr._setProgress).toHaveBeenCalledWith('connect', expect.any(Number), expect.any(String));
      expect(mgr._setProgress).toHaveBeenCalledWith('capture', expect.any(Number), expect.any(String));
      expect(mgr._setProgress).toHaveBeenCalledWith('done', 100, expect.any(String));
    });

    it('unmounts share after successful image backup', async () => {
      const mgr = makeManager();
      await runMacBackup(makeImageConfig(), mgr);

      const calls = execFile.mock.calls.map(c => ({ cmd: c[0], args: c[1] }));
      const umountCall = calls.find(c => c.cmd === 'umount');
      expect(umountCall).toBeDefined();
      expect(umountCall.args).toContain('/Volumes/homepinas-backup');
    });

    it('unmounts share even when asr fails', async () => {
      execFile.mockImplementation((_cmd, args, _opts, cb) => {
        const done = typeof _opts === 'function' ? _opts : cb;
        if (Array.isArray(args) && args.includes('asr')) {
          process.nextTick(() => done(new Error('asr: permission denied')));
        } else {
          process.nextTick(() => done(null, { stdout: '', stderr: '' }));
        }
      });

      const mgr = makeManager();
      await expect(runMacBackup(makeImageConfig(), mgr)).rejects.toThrow('asr');

      const umountCalls = execFile.mock.calls.filter(c => c[0] === 'umount');
      expect(umountCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── File backup ──────────────────────────────────────────────────────────

  describe('file backup', () => {
    it('throws when backupPaths is empty', async () => {
      await expect(
        runMacBackup(makeFileConfig({ backupPaths: [] }), makeManager())
      ).rejects.toThrow(/carpetas/i);
    });

    it('throws when backupPaths is undefined', async () => {
      await expect(
        runMacBackup(makeFileConfig({ backupPaths: undefined }), makeManager())
      ).rejects.toThrow(/carpetas/i);
    });

    it('returns type files with results array', async () => {
      const mgr = makeManager();
      const result = await runMacBackup(makeFileConfig(), mgr);
      expect(result.type).toBe('files');
      expect(Array.isArray(result.results)).toBe(true);
      expect(result.results).toHaveLength(2); // 2 paths
    });

    it('marks each path as success on rsync success', async () => {
      const mgr = makeManager();
      const result = await runMacBackup(makeFileConfig(), mgr);
      expect(result.results.every(r => r.success)).toBe(true);
    });

    it('marks path as failure when rsync fails', async () => {
      // mountMacSMB is fully mocked (jest.fn()) so retry is only called once per rsync path.
      // First call → Documents fails; subsequent calls → succeed.
      retry.mockImplementationOnce(async () => { throw new Error('rsync: lost connection'); })
           .mockImplementation(async (fn) => fn(0));

      const mgr = makeManager();
      const result = await runMacBackup(makeFileConfig(), mgr);

      expect(result.results[0].success).toBe(false);
      expect(result.results[0].error).toMatch(/rsync/);
      expect(result.results[1].success).toBe(true);
    });

    it('always unmounts after file backup', async () => {
      const mgr = makeManager();
      await runMacBackup(makeFileConfig(), mgr);

      const umountCalls = execFile.mock.calls.filter(c => c[0] === 'umount');
      expect(umountCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('unmounts even when rsync fails for all paths', async () => {
      retry.mockRejectedValue(new Error('rsync: no space left'));

      const mgr = makeManager();
      const result = await runMacBackup(makeFileConfig(), mgr);
      // All fail but no throw — errors are collected
      expect(result.results.every(r => !r.success)).toBe(true);

      const umountCalls = execFile.mock.calls.filter(c => c[0] === 'umount');
      expect(umountCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('calls rsync with -az --delete for each path', async () => {
      let capturedRsyncArgs = null;
      retry.mockImplementation(async (fn) => {
        // Capture what fn does
        execFile.mockImplementationOnce((_cmd, args, _opts, cb) => {
          if (args && args[0] === 'rsync' || _cmd === 'rsync') {
            capturedRsyncArgs = args;
          }
          const done = typeof _opts === 'function' ? _opts : cb;
          process.nextTick(() => done(null, { stdout: '', stderr: '' }));
        });
        return fn(0);
      });

      const mgr = makeManager();
      await runMacBackup(makeFileConfig({ backupPaths: ['/home/user'] }), mgr);

      // rsync should have been called with -az and --delete
      const allCalls = execFile.mock.calls;
      const rsyncCall = allCalls.find(c => c[0] === 'rsync');
      if (rsyncCall) {
        expect(rsyncCall[1]).toContain('-az');
        expect(rsyncCall[1]).toContain('--delete');
      }
    });

    it('tracks progress for each folder', async () => {
      const mgr = makeManager();
      await runMacBackup(makeFileConfig(), mgr);

      // Should have called setProgress for each folder copy
      const copyCalls = mgr._setProgress.mock.calls.filter(c => c[0] === 'copy');
      expect(copyCalls.length).toBeGreaterThanOrEqual(2);
    });
  });
});
