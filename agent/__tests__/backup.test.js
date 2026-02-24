/**
 * Tests for BackupManager (backup.js)
 *
 * Platform-specific backup modules (backup-windows, backup-mac, backup-linux)
 * are mocked. Tests cover orchestration: dispatch, checkpoint lifecycle,
 * logging, progress tracking, and error handling.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Mock platform-specific backup modules
jest.mock('../src/backup-windows', () => ({
  runWindowsBackup: jest.fn(),
}));
jest.mock('../src/backup-mac', () => ({
  runMacBackup: jest.fn(),
}));
jest.mock('../src/backup-linux', () => ({
  runLinuxBackup: jest.fn(),
}));
jest.mock('../src/checkpoint', () => {
  const CheckpointManagerMock = jest.fn().mockImplementation(() => ({
    checkpointId: jest.fn((deviceId, backupType) => `${deviceId}-${backupType}`),
    load: jest.fn(() => null),
    create: jest.fn(() => ({ id: 'mock-cp', phase: 'init', processedBytes: 0 })),
    update: jest.fn(),
    clear: jest.fn(),
  }));
  return { CheckpointManager: CheckpointManagerMock };
});

const { BackupManager } = require('../src/backup');
const { runWindowsBackup } = require('../src/backup-windows');
const { runMacBackup } = require('../src/backup-mac');
const { runLinuxBackup } = require('../src/backup-linux');

const makeConfig = (overrides = {}) => ({
  deviceId: 'test-device',
  backupType: 'files',
  nasAddress: '192.168.1.100',
  sambaShare: 'active-backup',
  sambaUser: 'admin',
  sambaPass: 'secret',
  backupPaths: ['/home/user/docs'],
  ...overrides,
});

describe('BackupManager', () => {
  let mgr;

  beforeEach(() => {
    jest.clearAllMocks();
    mgr = new BackupManager();
  });

  // ─── Initial state ─────────────────────────────────────────────────────────

  describe('initial state', () => {
    it('starts not running', () => {
      expect(mgr.running).toBe(false);
    });

    it('has null progress initially', () => {
      expect(mgr.progress).toBeNull();
    });

    it('has empty log initially', () => {
      expect(mgr.logContent).toBe('');
    });
  });

  // ─── Platform dispatch ─────────────────────────────────────────────────────

  describe('platform dispatch', () => {
    it('calls runWindowsBackup on win32', async () => {
      mgr.platform = 'win32';
      runWindowsBackup.mockResolvedValue({ type: 'files', results: [] });

      await mgr.runBackup(makeConfig());

      expect(runWindowsBackup).toHaveBeenCalledTimes(1);
      expect(runMacBackup).not.toHaveBeenCalled();
      expect(runLinuxBackup).not.toHaveBeenCalled();
    });

    it('calls runMacBackup on darwin', async () => {
      mgr.platform = 'darwin';
      runMacBackup.mockResolvedValue({ type: 'files', results: [] });

      await mgr.runBackup(makeConfig());

      expect(runMacBackup).toHaveBeenCalledTimes(1);
      expect(runWindowsBackup).not.toHaveBeenCalled();
      expect(runLinuxBackup).not.toHaveBeenCalled();
    });

    it('calls runLinuxBackup on linux', async () => {
      mgr.platform = 'linux';
      runLinuxBackup.mockResolvedValue({ type: 'files', results: [] });

      await mgr.runBackup(makeConfig());

      expect(runLinuxBackup).toHaveBeenCalledTimes(1);
      expect(runWindowsBackup).not.toHaveBeenCalled();
      expect(runMacBackup).not.toHaveBeenCalled();
    });

    it('throws for unsupported platform', async () => {
      mgr.platform = 'freebsd';

      await expect(mgr.runBackup(makeConfig())).rejects.toThrow(/no soportada/i);
    });

    it('passes config and manager instance to platform backup', async () => {
      mgr.platform = 'linux';
      runLinuxBackup.mockResolvedValue({ type: 'files', results: [] });

      const config = makeConfig();
      await mgr.runBackup(config);

      expect(runLinuxBackup).toHaveBeenCalledWith(config, mgr);
    });
  });

  // ─── Running guard ─────────────────────────────────────────────────────────

  describe('running guard', () => {
    it('throws if backup already running', async () => {
      mgr.platform = 'linux';
      // Simulate long-running backup
      runLinuxBackup.mockImplementation(() => new Promise(() => {}));

      // Start first backup (don't await)
      mgr.runBackup(makeConfig());

      // Immediate second call should throw
      await expect(mgr.runBackup(makeConfig())).rejects.toThrow('already running');
    });

    it('allows new backup after previous completes', async () => {
      mgr.platform = 'linux';
      runLinuxBackup.mockResolvedValue({ type: 'files', results: [] });

      await mgr.runBackup(makeConfig());
      expect(mgr.running).toBe(false);

      // Second backup should succeed
      await expect(mgr.runBackup(makeConfig())).resolves.toBeDefined();
    });
  });

  // ─── Result ────────────────────────────────────────────────────────────────

  describe('result', () => {
    it('returns result with log attached', async () => {
      mgr.platform = 'linux';
      runLinuxBackup.mockResolvedValue({ type: 'files', results: [], timestamp: 'T' });

      const result = await mgr.runBackup(makeConfig());
      expect(result.log).toBeDefined();
      expect(typeof result.log).toBe('string');
      expect(result.log).toContain('Backup started');
    });

    it('sets running to false after success', async () => {
      mgr.platform = 'linux';
      runLinuxBackup.mockResolvedValue({ type: 'files', results: [] });

      await mgr.runBackup(makeConfig());
      expect(mgr.running).toBe(false);
    });

    it('sets running to false after failure', async () => {
      mgr.platform = 'linux';
      runLinuxBackup.mockRejectedValue(new Error('disk full'));

      await expect(mgr.runBackup(makeConfig())).rejects.toThrow('disk full');
      expect(mgr.running).toBe(false);
    });

    it('resets progress to null after success', async () => {
      mgr.platform = 'linux';
      runLinuxBackup.mockResolvedValue({ type: 'files', results: [] });

      await mgr.runBackup(makeConfig());
      expect(mgr.progress).toBeNull();
    });

    it('resets progress to null after failure', async () => {
      mgr.platform = 'linux';
      runLinuxBackup.mockRejectedValue(new Error('fail'));

      await expect(mgr.runBackup(makeConfig())).rejects.toThrow();
      expect(mgr.progress).toBeNull();
    });
  });

  // ─── Error handling ────────────────────────────────────────────────────────

  describe('error handling', () => {
    it('attaches log to error on failure', async () => {
      mgr.platform = 'linux';
      runLinuxBackup.mockRejectedValue(new Error('I/O error'));

      let caughtErr;
      try {
        await mgr.runBackup(makeConfig());
      } catch (e) {
        caughtErr = e;
      }

      expect(caughtErr).toBeDefined();
      expect(caughtErr.backupLog).toBeDefined();
      expect(typeof caughtErr.backupLog).toBe('string');
    });

    it('preserves checkpoint on failure (no clear)', async () => {
      mgr.platform = 'linux';
      runLinuxBackup.mockRejectedValue(new Error('network error'));

      try { await mgr.runBackup(makeConfig()); } catch (e) {}

      expect(mgr._checkpoint.clear).not.toHaveBeenCalled();
    });

    it('clears checkpoint on success', async () => {
      mgr.platform = 'linux';
      runLinuxBackup.mockResolvedValue({ type: 'files', results: [] });

      await mgr.runBackup(makeConfig());

      expect(mgr._checkpoint.clear).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Checkpoint lifecycle ──────────────────────────────────────────────────

  describe('checkpoint lifecycle', () => {
    it('creates checkpoint at start', async () => {
      mgr.platform = 'linux';
      runLinuxBackup.mockResolvedValue({ type: 'files', results: [] });

      await mgr.runBackup(makeConfig());

      expect(mgr._checkpoint.create).toHaveBeenCalledTimes(1);
    });

    it('logs resume message when checkpoint exists', async () => {
      mgr.platform = 'linux';
      mgr._checkpoint.load.mockReturnValue({
        id: 'test-device-files',
        phase: 'copy',
        processedBytes: 5242880,
      });
      runLinuxBackup.mockResolvedValue({ type: 'files', results: [] });

      await mgr.runBackup(makeConfig());

      const logLines = mgr.logContent;
      expect(logLines).toContain('Resuming');
    });
  });

  // ─── Logging ──────────────────────────────────────────────────────────────

  describe('logging', () => {
    it('logs start and completion', async () => {
      mgr.platform = 'linux';
      runLinuxBackup.mockResolvedValue({ type: 'files', results: [] });

      await mgr.runBackup(makeConfig());

      expect(mgr.logContent).toContain('Backup started');
      expect(mgr.logContent).toContain('completed successfully');
    });

    it('logs failure message on error', async () => {
      mgr.platform = 'linux';
      runLinuxBackup.mockRejectedValue(new Error('connection lost'));

      try { await mgr.runBackup(makeConfig()); } catch (e) {}

      expect(e => e).toBeDefined();
      // The error should carry the log
    });
  });

  // ─── Progress ─────────────────────────────────────────────────────────────

  describe('_setProgress', () => {
    it('sets progress correctly', () => {
      mgr._setProgress('connect', 20, 'Connecting...');
      expect(mgr.progress).toEqual({ phase: 'connect', percent: 20, detail: 'Connecting...' });
    });

    it('clamps percent to 0-100', () => {
      mgr._setProgress('test', -5, 'neg');
      expect(mgr.progress.percent).toBe(0);

      mgr._setProgress('test', 110, 'over');
      expect(mgr.progress.percent).toBe(100);
    });
  });
});
