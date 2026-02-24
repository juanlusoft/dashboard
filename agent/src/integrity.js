/**
 * Integrity Checker - SHA256 checksums for backup verification
 * 
 * Generates and verifies checksums for backup files to detect
 * corruption from network errors, disk failures, or incomplete transfers.
 * 
 * Usage:
 *   - After backup: generateManifest(backupDir) → writes .integrity.json
 *   - To verify:    verifyManifest(backupDir) → { valid, errors, checkedFiles }
 *   - Per-file:     hashFile(filePath) → sha256 hex string
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MANIFEST_FILE = '.integrity.json';
const ALGORITHM = 'sha256';
// 1MB read buffer for hashing large files efficiently
const HASH_BUFFER_SIZE = 1024 * 1024;

/**
 * Calculate SHA256 hash of a file using streaming (memory-efficient).
 * @param {string} filePath - Absolute path to file
 * @returns {Promise<string>} Hex-encoded SHA256 hash
 */
function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(ALGORITHM);
    const stream = fs.createReadStream(filePath, { highWaterMark: HASH_BUFFER_SIZE });

    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Hash a buffer directly (for small data or in-memory content).
 */
function hashBuffer(buffer) {
  return crypto.createHash(ALGORITHM).update(buffer).digest('hex');
}

/**
 * Recursively list all files in a directory, excluding integrity manifests.
 */
async function listFiles(dir) {
  const files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === MANIFEST_FILE || entry.name.endsWith('.tmp')) continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Generate an integrity manifest for a backup directory.
 * Hashes every file and writes .integrity.json to the directory.
 * 
 * @param {string} backupDir - Path to backup directory
 * @param {function} onProgress - Optional callback(filename, index, total)
 * @returns {Promise<Object>} The manifest object
 */
async function generateManifest(backupDir, onProgress) {
  const files = await listFiles(backupDir);
  const manifest = {
    version: 1,
    algorithm: ALGORITHM,
    createdAt: new Date().toISOString(),
    totalFiles: files.length,
    totalBytes: 0,
    files: {},
  };

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i];
    const relativePath = path.relative(backupDir, filePath).replace(/\\/g, '/');
    const stat = fs.statSync(filePath);

    if (onProgress) onProgress(relativePath, i, files.length);

    const hash = await hashFile(filePath);
    manifest.files[relativePath] = {
      hash,
      size: stat.size,
    };
    manifest.totalBytes += stat.size;
  }

  const manifestPath = path.join(backupDir, MANIFEST_FILE);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  return manifest;
}

/**
 * Verify a backup directory against its integrity manifest.
 * 
 * @param {string} backupDir - Path to backup directory
 * @param {function} onProgress - Optional callback(filename, index, total)
 * @returns {Promise<Object>} { valid, errors[], checkedFiles, totalBytes }
 */
async function verifyManifest(backupDir, onProgress) {
  const manifestPath = path.join(backupDir, MANIFEST_FILE);

  if (!fs.existsSync(manifestPath)) {
    return { valid: false, errors: ['No integrity manifest found'], checkedFiles: 0, totalBytes: 0 };
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    return { valid: false, errors: [`Corrupt manifest: ${e.message}`], checkedFiles: 0, totalBytes: 0 };
  }

  const errors = [];
  const entries = Object.entries(manifest.files);
  let checkedBytes = 0;

  for (let i = 0; i < entries.length; i++) {
    const [relativePath, expected] = entries[i];
    const filePath = path.join(backupDir, relativePath);

    if (onProgress) onProgress(relativePath, i, entries.length);

    if (!fs.existsSync(filePath)) {
      errors.push({ file: relativePath, error: 'missing' });
      continue;
    }

    const stat = fs.statSync(filePath);
    if (stat.size !== expected.size) {
      errors.push({ file: relativePath, error: 'size_mismatch', expected: expected.size, actual: stat.size });
      continue;
    }

    const hash = await hashFile(filePath);
    if (hash !== expected.hash) {
      errors.push({ file: relativePath, error: 'hash_mismatch' });
    } else {
      checkedBytes += stat.size;
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    checkedFiles: entries.length - errors.length,
    totalFiles: entries.length,
    totalBytes: manifest.totalBytes,
    checkedBytes,
  };
}

module.exports = { hashFile, hashBuffer, generateManifest, verifyManifest };
