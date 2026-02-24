/**
 * Tests for SMB Connection Helper
 *
 * All external process calls (execFile) are mocked — tests validate
 * connection logic, retry behavior, credential handling, and error paths
 * without touching the OS or network.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Mock child_process before requiring the module under test
jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));

// Mock retry to remove delays in tests
jest.mock('../src/retry', () => {
  const actual = jest.requireActual('../src/retry');
  return {
    ...actual,
    retry: jest.fn(async (fn, _opts) => fn(0)),
  };
});

const { execFile } = require('child_process');
const { promisify } = require('util');
const { retry } = require('../src/retry');
const {
  connectWindowsSMB,
  connectWindowsDrive,
  cleanWindowsSMB,
  disconnectWindowsSMB,
  mountLinuxCIFS,
  mountMacSMB,
  writeCredFile,
} = require('../src/smb-connect');

// Helper: make execFile resolve with given stdout
function mockExecFileResolve(stdout = '') {
  execFile.mockImplementation((_cmd, _args, _opts, cb) => {
    // promisify wraps: if last arg is callback use it; otherwise use util.promisify pattern
    if (typeof _opts === 'function') _opts(null, { stdout, stderr: '' });
    else if (typeof cb === 'function') cb(null, { stdout, stderr: '' });
  });
}

function mockExecFileReject(error) {
  execFile.mockImplementation((_cmd, _args, _opts, cb) => {
    if (typeof _opts === 'function') _opts(error);
    else if (typeof cb === 'function') cb(error);
  });
}

const makeLogger = () => ({
  _log: jest.fn(),
  _setProgress: jest.fn(),
});

describe('smb-connect', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: all execFile calls succeed
    execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      const done = typeof _opts === 'function' ? _opts : cb;
      done(null, { stdout: '', stderr: '' });
    });
    // Default retry: call fn once (attempt 0), no delays
    retry.mockImplementation(async (fn, _opts) => fn(0));
  });

  // ─── writeCredFile ─────────────────────────────────────────────────────────

  describe('writeCredFile', () => {
    let credPath;

    afterEach(() => {
      if (credPath && fs.existsSync(credPath)) fs.unlinkSync(credPath);
    });

    it('writes credentials to tmpdir with 0600 permissions', () => {
      credPath = writeCredFile({ user: 'admin', pass: 'secret' }, 99999);
      expect(credPath).toBe(require('path').join(require('os').tmpdir(), 'homepinas-creds-99999'));
      expect(fs.existsSync(credPath)).toBe(true);

      const content = fs.readFileSync(credPath, 'utf8');
      expect(content).toContain('username=admin');
      expect(content).toContain('password=secret');

      const stat = fs.statSync(credPath);
      // Mode 0600 = owner read/write only
      expect(stat.mode & 0o777).toBe(0o600);
    });

    it('uses provided pid in filename', () => {
      const pid = 12345;
      credPath = writeCredFile({ user: 'u', pass: 'p' }, pid);
      expect(credPath).toMatch(/12345/);
    });
  });

  // ─── cleanWindowsSMB ───────────────────────────────────────────────────────

  describe('cleanWindowsSMB', () => {
    it('attempts to delete server and share connections', async () => {
      await cleanWindowsSMB('192.168.1.100', '\\\\192.168.1.100\\share');
      // Should have called `net use ... /delete /y` at least twice
      const calls = execFile.mock.calls;
      const deleteCalls = calls.filter(c => c[1].includes('/delete'));
      expect(deleteCalls.length).toBeGreaterThanOrEqual(2);
    });

    it('does not throw when net use fails', async () => {
      execFile.mockImplementation((_cmd, _args, _opts, cb) => {
        const done = typeof _opts === 'function' ? _opts : cb;
        done(new Error('System error 2'));
      });
      // Should not throw — all errors are swallowed intentionally
      await expect(cleanWindowsSMB('192.168.1.100', '\\\\share')).resolves.toBeUndefined();
    });

    it('parses net use output and removes mapped drives', async () => {
      let callCount = 0;
      execFile.mockImplementation((_cmd, args, _opts, cb) => {
        const done = typeof _opts === 'function' ? _opts : cb;
        callCount++;
        if (args[0] === 'use' && args.length === 1) {
          // Return a fake `net use` listing with a mapped drive
          done(null, { stdout: 'OK  Z:  \\\\192.168.1.100\\share  permanent\n', stderr: '' });
        } else {
          done(null, { stdout: '', stderr: '' });
        }
      });

      await cleanWindowsSMB('192.168.1.100', '\\\\192.168.1.100\\share');
      const calls = execFile.mock.calls.map(c => c[1]);
      const zDelete = calls.find(a => a[0] === 'use' && a[1] === 'Z:' && a.includes('/delete'));
      expect(zDelete).toBeDefined();
    });
  });

  // ─── disconnectWindowsSMB ──────────────────────────────────────────────────

  describe('disconnectWindowsSMB', () => {
    it('calls net use /delete without throwing', async () => {
      await disconnectWindowsSMB('\\\\192.168.1.100\\share');
      const [cmd, args] = execFile.mock.calls[0];
      expect(cmd).toBe('net');
      expect(args).toContain('/delete');
    });

    it('does not throw when disconnect fails', async () => {
      execFile.mockImplementation((_cmd, _args, _opts, cb) => {
        const done = typeof _opts === 'function' ? _opts : cb;
        done(new Error('already disconnected'));
      });
      await expect(disconnectWindowsSMB('\\\\share')).resolves.toBeUndefined();
    });
  });

  // ─── connectWindowsSMB ─────────────────────────────────────────────────────

  describe('connectWindowsSMB', () => {
    it('calls net use with correct args and logs success', async () => {
      const logger = makeLogger();
      await connectWindowsSMB('\\\\192.168.1.100\\share', { user: 'admin', pass: 'pass' }, logger);

      // retry was called once
      expect(retry).toHaveBeenCalledTimes(1);
      expect(logger._log).toHaveBeenCalledWith(expect.stringContaining('Connected to'));
    });

    it('passes /user and /persistent:no to net use via retry fn', async () => {
      const logger = makeLogger();
      let capturedFn;
      retry.mockImplementation(async (fn, _opts) => {
        capturedFn = fn;
        return fn(0);
      });

      await connectWindowsSMB('\\\\nas\\share', { user: 'u', pass: 'p' }, logger);

      // Verify execFile was called with expected net use args
      const calls = execFile.mock.calls.filter(c => c[0] === 'net');
      const netUseCall = calls.find(c => c[1].includes('\\\\nas\\share') && c[1].includes('/user:u'));
      expect(netUseCall).toBeDefined();
      expect(netUseCall[1]).toContain('/persistent:no');
    });

    it('propagates errors after retries exhausted', async () => {
      const logger = makeLogger();
      retry.mockRejectedValue(new Error('SMB failed'));

      await expect(
        connectWindowsSMB('\\\\nas\\share', { user: 'u', pass: 'p' }, logger)
      ).rejects.toThrow('SMB failed');
    });
  });

  // ─── connectWindowsDrive ──────────────────────────────────────────────────

  describe('connectWindowsDrive', () => {
    it('maps drive letter with correct net use args', async () => {
      const logger = makeLogger();
      await connectWindowsDrive('Z', '\\\\nas\\share', { user: 'admin', pass: 'pw' }, logger);

      expect(retry).toHaveBeenCalledTimes(1);
      expect(logger._log).toHaveBeenCalledWith(expect.stringContaining('Mapped Z:'));
    });

    it('attempts to delete existing drive mapping before mounting', async () => {
      const logger = makeLogger();
      await connectWindowsDrive('Z', '\\\\nas\\share', { user: 'u', pass: 'p' }, logger);

      const calls = execFile.mock.calls;
      const deleteCall = calls.find(c => c[1].includes('Z:') && c[1].includes('/delete'));
      expect(deleteCall).toBeDefined();
    });

    it('does not throw if pre-delete fails', async () => {
      const logger = makeLogger();
      let callCount = 0;
      execFile.mockImplementation((_cmd, args, _opts, cb) => {
        const done = typeof _opts === 'function' ? _opts : cb;
        callCount++;
        // First call (delete) fails; subsequent calls succeed
        if (callCount === 1) done(new Error('drive not found'));
        else done(null, { stdout: '', stderr: '' });
      });

      await expect(
        connectWindowsDrive('Z', '\\\\nas\\share', { user: 'u', pass: 'p' }, logger)
      ).resolves.toBeUndefined();
    });
  });

  // ─── mountLinuxCIFS ────────────────────────────────────────────────────────

  describe('mountLinuxCIFS', () => {
    it('calls mount with cifs options and logs success', async () => {
      const logger = makeLogger();
      await mountLinuxCIFS('192.168.1.100', 'backups', '/mnt/nas', '/tmp/creds', logger);

      expect(retry).toHaveBeenCalledTimes(1);
      expect(logger._log).toHaveBeenCalledWith(expect.stringContaining('Mounted'));
      expect(logger._log).toHaveBeenCalledWith(expect.stringContaining('192.168.1.100'));
    });

    it('passes credFile path via -o credentials=... option', async () => {
      const logger = makeLogger();
      let capturedArgs;
      execFile.mockImplementation((_cmd, args, _opts, cb) => {
        capturedArgs = args;
        const done = typeof _opts === 'function' ? _opts : cb;
        done(null, { stdout: '', stderr: '' });
      });

      await mountLinuxCIFS('192.168.1.100', 'share', '/mnt/point', '/tmp/creds-123', logger);

      expect(capturedArgs).toContain('-t');
      expect(capturedArgs).toContain('cifs');
      const credOption = capturedArgs.find(a => a.includes('credentials='));
      expect(credOption).toContain('/tmp/creds-123');
    });

    it('propagates mount error after retries', async () => {
      const logger = makeLogger();
      retry.mockRejectedValue(new Error('mount failed: no route to host'));

      await expect(
        mountLinuxCIFS('192.168.1.100', 'share', '/mnt/point', '/tmp/creds', logger)
      ).rejects.toThrow('mount failed');
    });
  });

  // ─── mountMacSMB ──────────────────────────────────────────────────────────

  describe('mountMacSMB', () => {
    it('calls mount_smbfs with encoded credentials', async () => {
      const logger = makeLogger();
      let capturedCmd, capturedArgs;
      execFile.mockImplementation((cmd, args, _opts, cb) => {
        capturedCmd = cmd;
        capturedArgs = args;
        const done = typeof _opts === 'function' ? _opts : cb;
        done(null, { stdout: '', stderr: '' });
      });

      await mountMacSMB('192.168.1.100', 'share', { user: 'admin', pass: 'p@ss!' }, '/Volumes/nas', logger);

      expect(capturedCmd).toBe('mount_smbfs');
      // URL should encode special chars
      expect(capturedArgs[0]).toBe('-N');
      expect(capturedArgs[1]).toContain('smb://');
      // encodeURIComponent encodes @ → %40; ! is a safe char and stays as-is
      expect(capturedArgs[1]).toContain('p%40ss!');
      expect(capturedArgs[2]).toBe('/Volumes/nas');
    });

    it('logs success with nas address and share', async () => {
      const logger = makeLogger();
      await mountMacSMB('192.168.1.100', 'myshare', { user: 'u', pass: 'p' }, '/Volumes/nas', logger);

      expect(logger._log).toHaveBeenCalledWith(expect.stringContaining('192.168.1.100'));
      expect(logger._log).toHaveBeenCalledWith(expect.stringContaining('myshare'));
    });

    it('propagates error on mount failure', async () => {
      const logger = makeLogger();
      retry.mockRejectedValue(new Error('mount_smbfs: server refused connection'));

      await expect(
        mountMacSMB('192.168.1.100', 'share', { user: 'u', pass: 'p' }, '/Volumes/nas', logger)
      ).rejects.toThrow('server refused');
    });
  });
});
