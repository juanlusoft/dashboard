const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { hashFile, hashBuffer, generateManifest, verifyManifest } = require('../src/integrity');

describe('Integrity Checker', () => {
  let testDir;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'integrity-test-'));
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  function writeFile(name, content) {
    const filePath = path.join(testDir, name);
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  describe('hashFile', () => {
    it('returns correct SHA256 for a known string', async () => {
      const filePath = writeFile('test.txt', 'hello world');
      const hash = await hashFile(filePath);
      const expected = crypto.createHash('sha256').update('hello world').digest('hex');
      expect(hash).toBe(expected);
    });

    it('returns consistent hash for same content', async () => {
      writeFile('a.txt', 'same content');
      writeFile('b.txt', 'same content');
      const hashA = await hashFile(path.join(testDir, 'a.txt'));
      const hashB = await hashFile(path.join(testDir, 'b.txt'));
      expect(hashA).toBe(hashB);
    });

    it('returns different hash for different content', async () => {
      writeFile('a.txt', 'content A');
      writeFile('b.txt', 'content B');
      const hashA = await hashFile(path.join(testDir, 'a.txt'));
      const hashB = await hashFile(path.join(testDir, 'b.txt'));
      expect(hashA).not.toBe(hashB);
    });

    it('handles empty files', async () => {
      writeFile('empty.txt', '');
      const hash = await hashFile(path.join(testDir, 'empty.txt'));
      const expected = crypto.createHash('sha256').update('').digest('hex');
      expect(hash).toBe(expected);
    });
  });

  describe('hashBuffer', () => {
    it('hashes a buffer correctly', () => {
      const buf = Buffer.from('test data');
      const hash = hashBuffer(buf);
      const expected = crypto.createHash('sha256').update('test data').digest('hex');
      expect(hash).toBe(expected);
    });
  });

  describe('generateManifest', () => {
    it('creates manifest with all files', async () => {
      writeFile('file1.txt', 'content 1');
      writeFile('subdir/file2.txt', 'content 2');
      writeFile('subdir/deep/file3.txt', 'content 3');

      const manifest = await generateManifest(testDir);

      expect(manifest.version).toBe(1);
      expect(manifest.algorithm).toBe('sha256');
      expect(manifest.totalFiles).toBe(3);
      expect(manifest.files['file1.txt']).toBeDefined();
      expect(manifest.files['subdir/file2.txt']).toBeDefined();
      expect(manifest.files['subdir/deep/file3.txt']).toBeDefined();

      // Check manifest file was written
      expect(fs.existsSync(path.join(testDir, '.integrity.json'))).toBe(true);
    });

    it('excludes .integrity.json from manifest', async () => {
      writeFile('data.txt', 'data');
      const manifest = await generateManifest(testDir);
      expect(manifest.files['.integrity.json']).toBeUndefined();
    });

    it('tracks file sizes', async () => {
      writeFile('sized.txt', 'x'.repeat(1000));
      const manifest = await generateManifest(testDir);
      expect(manifest.files['sized.txt'].size).toBe(1000);
      expect(manifest.totalBytes).toBe(1000);
    });

    it('calls progress callback', async () => {
      writeFile('a.txt', 'a');
      writeFile('b.txt', 'b');

      const calls = [];
      await generateManifest(testDir, (file, i, total) => {
        calls.push({ file, i, total });
      });

      expect(calls.length).toBe(2);
      expect(calls[0].total).toBe(2);
    });
  });

  describe('verifyManifest', () => {
    it('returns valid for intact backup', async () => {
      writeFile('file1.txt', 'content 1');
      writeFile('file2.txt', 'content 2');
      await generateManifest(testDir);

      const result = await verifyManifest(testDir);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.checkedFiles).toBe(2);
    });

    it('detects missing files', async () => {
      writeFile('file1.txt', 'content 1');
      writeFile('file2.txt', 'content 2');
      await generateManifest(testDir);

      // Delete a file
      fs.unlinkSync(path.join(testDir, 'file2.txt'));

      const result = await verifyManifest(testDir);
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toBe('missing');
    });

    it('detects corrupted files', async () => {
      writeFile('data.txt', 'original content');
      await generateManifest(testDir);

      // Corrupt the file
      fs.writeFileSync(path.join(testDir, 'data.txt'), 'corrupted content');

      const result = await verifyManifest(testDir);
      expect(result.valid).toBe(false);
      expect(result.errors[0].error).toBe('size_mismatch');
    });

    it('detects same-size corruption via hash', async () => {
      writeFile('data.txt', 'AAAA');
      await generateManifest(testDir);

      // Corrupt with same-length content
      fs.writeFileSync(path.join(testDir, 'data.txt'), 'BBBB');

      const result = await verifyManifest(testDir);
      expect(result.valid).toBe(false);
      expect(result.errors[0].error).toBe('hash_mismatch');
    });

    it('returns invalid when no manifest exists', async () => {
      writeFile('data.txt', 'data');

      const result = await verifyManifest(testDir);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toBe('No integrity manifest found');
    });
  });
});
