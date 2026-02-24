const fs = require('fs');
const path = require('path');
const os = require('os');
const { CheckpointManager } = require('../src/checkpoint');

describe('CheckpointManager', () => {
  let cp;
  let testDir;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-test-'));
    cp = new CheckpointManager();
    cp.dir = testDir;
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('checkpointId', () => {
    it('generates deterministic ID from device+type', () => {
      expect(cp.checkpointId('dev1', 'image')).toBe('dev1-image');
      expect(cp.checkpointId('dev1', 'files')).toBe('dev1-files');
    });
  });

  describe('create + load', () => {
    it('creates and loads a checkpoint', () => {
      const created = cp.create('test-1', { deviceId: 'abc' });
      expect(created.id).toBe('test-1');
      expect(created.phase).toBe('init');
      expect(created.metadata.deviceId).toBe('abc');

      const loaded = cp.load('test-1');
      expect(loaded).not.toBeNull();
      expect(loaded.id).toBe('test-1');
    });

    it('returns null for non-existent checkpoint', () => {
      expect(cp.load('nonexistent')).toBeNull();
    });
  });

  describe('update', () => {
    it('updates phase and tracks completed phases', () => {
      cp.create('test-2');
      cp.update('test-2', 'connect', { server: '192.168.1.100' });
      cp.update('test-2', 'capture', { progress: 50 });

      const loaded = cp.load('test-2');
      expect(loaded.phase).toBe('capture');
      expect(loaded.completedPhases).toContain('connect');
      expect(loaded.phaseData).toEqual({ progress: 50 });
    });

    it('merges extra fields', () => {
      cp.create('test-3');
      cp.update('test-3', 'capture', {}, { processedBytes: 1024 });

      const loaded = cp.load('test-3');
      expect(loaded.processedBytes).toBe(1024);
    });
  });

  describe('markFileCompleted', () => {
    it('tracks completed files', () => {
      cp.create('test-4');
      cp.markFileCompleted('test-4', '/docs/a.txt', 100, 'abc123');
      cp.markFileCompleted('test-4', '/docs/b.txt', 200, 'def456');

      const loaded = cp.load('test-4');
      expect(loaded.completedFiles).toHaveLength(2);
      expect(loaded.processedBytes).toBe(300);
    });
  });

  describe('isPhaseCompleted', () => {
    it('returns true for completed phases', () => {
      cp.create('test-5');
      cp.update('test-5', 'connect');
      cp.update('test-5', 'capture');

      expect(cp.isPhaseCompleted('test-5', 'connect')).toBe(true);
      expect(cp.isPhaseCompleted('test-5', 'capture')).toBe(false); // current, not completed
      expect(cp.isPhaseCompleted('test-5', 'done')).toBe(false);
    });
  });

  describe('clear', () => {
    it('removes checkpoint file', () => {
      cp.create('test-6');
      expect(cp.load('test-6')).not.toBeNull();

      cp.clear('test-6');
      expect(cp.load('test-6')).toBeNull();
    });

    it('does not throw on non-existent checkpoint', () => {
      expect(() => cp.clear('nonexistent')).not.toThrow();
    });
  });

  describe('expiry', () => {
    it('expires checkpoints older than 72 hours', () => {
      cp.create('test-7');
      // Manually age the checkpoint
      const filePath = path.join(testDir, 'test-7.json');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      data.updatedAt = Date.now() - (73 * 3600 * 1000);
      fs.writeFileSync(filePath, JSON.stringify(data));

      expect(cp.load('test-7')).toBeNull();
    });

    it('keeps checkpoints under 72 hours', () => {
      cp.create('test-8');
      expect(cp.load('test-8')).not.toBeNull();
    });
  });

  describe('listActive', () => {
    it('lists all active checkpoints', () => {
      cp.create('a');
      cp.create('b');
      cp.create('c');

      const active = cp.listActive();
      expect(active).toHaveLength(3);
      expect(active.map(c => c.id).sort()).toEqual(['a', 'b', 'c']);
    });
  });

  describe('path sanitization', () => {
    it('sanitizes dangerous characters in checkpoint ID', () => {
      cp.create('../../../etc/passwd');
      // Should create a safe filename, not traverse directories
      const files = fs.readdirSync(testDir);
      expect(files.every(f => !f.includes('..'))).toBe(true);
    });
  });
});
