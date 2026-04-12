/**
 * HomePiNAS v2 - File Station Routes
 * Web file manager for browsing/managing files on NAS storage at /mnt/storage
 */

const log = require('../utils/logger');
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { logSecurityEvent } = require('../utils/security');
const { sanitizePathWithinBase } = require('../utils/sanitize');
const { getData } = require('../utils/data');

// Base storage directory - all operations are confined here
const STORAGE_BASE = '/mnt/storage';
const DISK_BASE = '/mnt/disks';

// Detect which physical disk a MergerFS file lives on
let _diskDirs = null;
function getDiskDirs() {
    if (_diskDirs) return _diskDirs;
    try {
        _diskDirs = fs.readdirSync(DISK_BASE)
            .filter(d => /^(disk|cache)\d+$/.test(d))
            .sort((a, b) => {
                // cache first, then disk, numerically
                const typeA = a.startsWith('cache') ? 0 : 1;
                const typeB = b.startsWith('cache') ? 0 : 1;
                if (typeA !== typeB) return typeA - typeB;
                return parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]);
            });
    } catch { _diskDirs = []; }
    return _diskDirs;
}

function getFileDisk(fullPath) {
    const relPath = path.relative(STORAGE_BASE, fullPath);
    if (!relPath || relPath.startsWith('..')) return null;
    for (const disk of getDiskDirs()) {
        try {
            if (fs.existsSync(path.join(DISK_BASE, disk, relPath))) return disk;
        } catch {}
    }
    return null;
}
const INDEPENDENT_BASE = '/mnt/independent';

// MIME type mapping based on file extension
const MIME_TYPES = {
  '.txt': 'text/plain', '.html': 'text/html', '.css': 'text/css',
  '.js': 'application/javascript', '.json': 'application/json',
  '.xml': 'application/xml', '.csv': 'text/csv',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.bmp': 'image/bmp', '.tiff': 'image/tiff',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.flac': 'audio/flac', '.aac': 'audio/aac', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime', '.webm': 'video/webm', '.wmv': 'video/x-ms-wmv',
  '.pdf': 'application/pdf', '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip', '.tar': 'application/x-tar',
  '.gz': 'application/gzip', '.7z': 'application/x-7z-compressed',
  '.rar': 'application/x-rar-compressed', '.bz2': 'application/x-bzip2',
  '.iso': 'application/x-iso9660-image',
  '.sh': 'application/x-sh', '.py': 'text/x-python',
  '.log': 'text/plain', '.md': 'text/markdown', '.yaml': 'text/yaml',
  '.yml': 'text/yaml', '.ini': 'text/plain', '.conf': 'text/plain',
};

/**
 * Guess MIME type from file extension
 */
function guessMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

/**
 * Resolve the base directory for file operations.
 * root='storage' => /mnt/storage
 * root='independent', disk='toshiba' => /mnt/independent/toshiba
 */
function resolveBaseDir(root, disk) {
  if (root === 'independent' && disk) {
    // Validate disk is a simple name (no slashes, no dots at start)
    const safeDisk = path.basename(disk);
    if (!safeDisk || safeDisk.startsWith('.')) return null;
    const diskPath = path.join(INDEPENDENT_BASE, safeDisk);
    if (!fs.existsSync(diskPath)) return null;
    return diskPath;
  }
  return STORAGE_BASE;
}


/**
 * Validate a path is within /mnt/storage. Returns sanitized path or sends 400 error.
 * Returns null if invalid (caller should return early).
 * If the user has allowedPaths configured, restricts access to those paths only.
 */
function validatePath(inputPath, res, req, baseDir) {
  const BASE = baseDir || STORAGE_BASE;
  // Treat '/' or empty as root of storage
  let relativePath = inputPath || '/';
  if (relativePath === '/') relativePath = '.';
  // Remove leading slash to make it relative to STORAGE_BASE
  if (relativePath.startsWith('/')) relativePath = relativePath.substring(1);
  
  const sanitized = sanitizePathWithinBase(relativePath, BASE);
  if (sanitized === null) {
    res.status(400).json({ error: 'Invalid path: must be within storage directory' });
    return null;
  }

  // Check per-user path restrictions (if configured)
  if (req && req.user) {
    const data = getData();
    const users = data.users || [];
    const user = users.find(u => u.username.toLowerCase() === req.user.username.toLowerCase())
                  || (data.user && data.user.username === req.user.username ? data.user : null);
    
    if (user && user.allowedPaths && user.allowedPaths.length > 0) {
      const isAllowed = user.allowedPaths.some(allowed => 
        sanitized === allowed || sanitized.startsWith(allowed + '/')
      );
      if (!isAllowed) {
        res.status(403).json({ error: 'Access denied: path not in your allowed directories' });
        return null;
      }
    }
  }

  return sanitized;
}

/**
 * Recursive file search by name within a directory
 */
function searchFiles(dir, query, results, maxResults) {
  if (results.length >= maxResults) return;

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= maxResults) return;

      const fullPath = path.join(dir, entry.name);
      // Check if the filename matches the query (case-insensitive)
      if (entry.name.toLowerCase().includes(query.toLowerCase())) {
        const relativePath = path.relative(STORAGE_BASE, fullPath);
        try {
          const stat = fs.statSync(fullPath);
          results.push({
            name: entry.name,
            path: '/' + relativePath,
            type: entry.isDirectory() ? 'directory' : 'file',
            size: stat.size,
            modified: stat.mtime,
          });
        } catch {
          // Skip files we can't stat
        }
      }

      // Recurse into subdirectories
      if (entry.isDirectory()) {
        searchFiles(fullPath, query, results, maxResults);
      }
    }
  } catch {
    // Skip directories we can't read
  }
}

// Configure multer to use storage temp directory for large files
// Falls back to system tmp if storage not mounted or not writable
const os = require('os');
const storageTmpDir = '/mnt/storage/.uploads-tmp';
const systemTmpDir = path.join(os.tmpdir(), 'homepinas-uploads');
// Prefer storage temp dir (large capacity) over system tmp (limited eMMC)
let tmpUploadDir = systemTmpDir;

// Try to use storage if available and writable
if (fs.existsSync('/mnt/storage')) {
  try {
    if (!fs.existsSync(storageTmpDir)) {
      fs.mkdirSync(storageTmpDir, { recursive: true });
    }
    // Test if writable
    const testFile = path.join(storageTmpDir, '.write-test');
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
    tmpUploadDir = storageTmpDir;
  } catch (e) {
    log.warn('[Upload] Storage not writable, using system tmp:', e.message);
    tmpUploadDir = systemTmpDir;
  }
}

// Ensure tmp dir exists
if (!fs.existsSync(tmpUploadDir)) {
  try {
    fs.mkdirSync(tmpUploadDir, { recursive: true });
  } catch (e) {
    log.error('[Upload] Cannot create temp dir:', e.message);
  }
}

// Cleanup abandoned uploads (older than 1 hour)
function cleanupOldUploads() {
  try {
    if (!fs.existsSync(tmpUploadDir)) return;
    const files = fs.readdirSync(tmpUploadDir);
    const now = Date.now();
    const maxAge = 60 * 60 * 1000; // 1 hour
    
    for (const file of files) {
      try {
        const filePath = path.join(tmpUploadDir, file);
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > maxAge) {
          fs.unlinkSync(filePath);
          log.info(`[Cleanup] Removed abandoned upload: ${file}`);
        }
      } catch (e) {}
    }
  } catch (e) {
    log.error('[Cleanup] Error:', e.message);
  }
}

// Run cleanup on startup and every hour
cleanupOldUploads();
setInterval(cleanupOldUploads, 60 * 60 * 1000);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, tmpUploadDir);
  },
  filename: (req, file, cb) => {
    // Sanitize filename to prevent path traversal and special characters
    const ext = path.extname(file.originalname).replace(/[^a-zA-Z0-9.]/g, '').substring(0, 10);
    const base = path.basename(file.originalname, path.extname(file.originalname))
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .substring(0, 100);
    const hash = require('crypto').randomBytes(8).toString('hex');
    cb(null, `${Date.now()}-${hash}-${base}${ext ? '.' + ext : ''}`);
  },
});

const upload = multer({
  storage,
  // No file size limit - NAS can handle large files
});

// All routes require authentication
router.use(requireAuth);

/**
 * GET /list?path=/
 * List directory contents with file metadata
 * Permission: read
 */

/**
 * GET /user-home
 * Get the current user's configured home path and allowed paths
 */
router.get('/user-home', requirePermission('read'), (req, res) => {
  try {
    const data = getData();
    const users = data.users || [];
    const user = users.find(u => u.username.toLowerCase() === req.user.username.toLowerCase())
                  || (data.user && data.user.username === req.user.username ? data.user : null);
    
    const homePath = (user && user.homePath) || '';
    const allowedPaths = (user && user.allowedPaths) || [];
    
    // Return path relative to STORAGE_BASE for the frontend
    let relativHome = '';
    if (homePath && homePath.startsWith(STORAGE_BASE)) {
      relativHome = homePath.substring(STORAGE_BASE.length) || '/';
    }

    res.json({
      homePath: relativHome,
      allowedPaths: allowedPaths.map(p => p.startsWith(STORAGE_BASE) ? p.substring(STORAGE_BASE.length) || '/' : p),
      hasRestrictions: allowedPaths.length > 0,
    });
  } catch (err) {
    log.error('Get user home error:', err.message);
    res.json({ homePath: '', allowedPaths: [], hasRestrictions: false });
  }
});

router.get('/list', requirePermission('read'), (req, res) => {
  const { root, disk } = req.query;
  if (root === 'independent') {
    const baseDir = resolveBaseDir('independent', disk);
    if (!baseDir) return res.status(400).json({ error: 'Invalid or unmounted disk' });
    const inputPath = req.query.path || '/';
    const relativePath = inputPath.replace(/^\/+/, ''); // strip ALL leading slashes
    const fullPath = relativePath ? path.join(baseDir, relativePath) : baseDir;
    const resolvedFull = path.resolve(fullPath);
    if (!resolvedFull.startsWith(baseDir + '/') && resolvedFull !== baseDir) return res.status(400).json({ error: 'Invalid path' });
    try {
      const entries = fs.readdirSync(fullPath, { withFileTypes: true });
      const files = entries.map(e => {
        const stats = fs.statSync(path.join(fullPath, e.name));
        return {
          name: e.name,
          type: e.isDirectory() ? 'directory' : 'file',
          size: stats.size,
          modified: stats.mtime,
          path: '/' + path.relative(baseDir, path.join(fullPath, e.name)),
        };
      });
      return res.json({ files, path: '/' + path.relative(baseDir, fullPath) || '/' });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to list directory' });
    }
  }
  try {
    const inputPath = req.query.path || '/';
    const dirPath = validatePath(inputPath, res, req);
    if (dirPath === null) return;

    // Verify the path is a directory
    if (!fs.existsSync(dirPath)) {
      return res.status(404).json({ error: 'Directory not found' });
    }
    const dirStat = fs.statSync(dirPath);
    if (!dirStat.isDirectory()) {
      return res.status(400).json({ error: 'Path is not a directory' });
    }

    const showHidden = req.query.showHidden === 'true';
    const entries = fs.readdirSync(dirPath);
    const items = [];

    for (const entry of entries) {
      // Hide dotfiles/dotfolders and system folders unless explicitly requested
      if (!showHidden && (entry.startsWith('.') || entry === 'lost+found')) continue;
      try {
        const fullPath = path.join(dirPath, entry);
        const stat = fs.statSync(fullPath);
        items.push({
          name: entry,
          size: stat.size,
          type: stat.isDirectory() ? 'directory' : 'file',
          modified: stat.mtime,
          permissions: '0' + (stat.mode & parseInt('777', 8)).toString(8),
          disk: stat.isDirectory() ? null : getFileDisk(fullPath),
        });
      } catch {
        // Skip entries we can't stat (broken symlinks, permission issues)
        items.push({
          name: entry,
          size: 0,
          type: 'unknown',
          modified: null,
          permissions: null,
        });
      }
    }

    // Sort: directories first, then alphabetically
    items.sort((a, b) => {
      if (a.type === 'directory' && b.type !== 'directory') return -1;
      if (a.type !== 'directory' && b.type === 'directory') return 1;
      return a.name.localeCompare(b.name);
    });

    const relativePath = '/' + path.relative(STORAGE_BASE, dirPath);
    res.json({
      path: relativePath === '/.' ? '/' : relativePath,
      items,
      count: items.length,
    });
  } catch (err) {
    log.error('File list error:', err.message);
    res.status(500).json({ error: 'Failed to list directory' });
  }
});

/**
 * GET /download?path=/some/file.txt
 * Download a file from storage
 * Permission: read
 */
router.get('/download', requirePermission('read'), (req, res) => {
  try {
    const inputPath = req.query.path;
    if (!inputPath) {
      return res.status(400).json({ error: 'Path parameter required' });
    }

    const filePath = validatePath(inputPath, res, req);
    if (filePath === null) return;

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      return res.status(400).json({ error: 'Cannot download a directory' });
    }

    logSecurityEvent('file_download', req.user.username, { path: inputPath });
    res.download(filePath);
  } catch (err) {
    log.error('File download error:', err.message);
    res.status(500).json({ error: 'Failed to download file' });
  }
});

/**
 * POST /upload
 * Upload files to a directory within /mnt/storage
 * Body: path (target directory), files (multipart)
 * Permission: write
 */
router.post('/upload', requirePermission('write'), (req, res) => {
  // Use multer middleware inline - handle up to 10 files at once
  upload.array('files', 10)(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'File too large (max 2GB)' });
      }
      log.error('Upload error:', err.message);
      return res.status(400).json({ error: err.message || 'Upload failed' });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    // Now req.body.path is available — move files from temp to target
    const uploadPath = req.body.path || '/';
    let targetDir;

    // Handle root path
    if (uploadPath === '/' || uploadPath === '') {
      targetDir = STORAGE_BASE;
    } else {
      targetDir = sanitizePathWithinBase(uploadPath, STORAGE_BASE);
    }

    if (!targetDir) {
      // Clean up temp files
      req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch(e) {} });
      return res.status(400).json({ error: 'Invalid upload directory' });
    }

    if (!fs.existsSync(targetDir)) {
      req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch(e) {} });
      return res.status(400).json({ error: 'Upload directory does not exist' });
    }

    // Move each file from temp to target
    const movedFiles = [];
    for (const f of req.files) {
      const safeName = path.basename(f.originalname);
      const destPath = path.join(targetDir, safeName);
      try {
        fs.renameSync(f.path, destPath);
        movedFiles.push({ name: safeName, size: f.size, path: path.relative(STORAGE_BASE, destPath) });
      } catch (moveErr) {
        // Try copy+delete if rename fails (cross-device)
        try {
          fs.copyFileSync(f.path, destPath);
          fs.unlinkSync(f.path);
          movedFiles.push({ name: safeName, size: f.size, path: path.relative(STORAGE_BASE, destPath) });
        } catch (copyErr) {
          log.error('Move file error:', copyErr.message);
        }
      }
    }

    logSecurityEvent('file_upload', req.user.username, {
      path: uploadPath,
      files: movedFiles.map(f => f.name),
    });

    res.json({
      message: `${movedFiles.length} file(s) uploaded successfully`,
      files: movedFiles,
    });
  });
});

/**
 * POST /mkdir
 * Create a new directory
 * Body: { path: "/new/directory" }
 * Permission: write
 */
router.post('/mkdir', requirePermission('write'), (req, res) => {
  try {
    const inputPath = req.body.path;
    if (!inputPath) {
      return res.status(400).json({ error: 'Path parameter required' });
    }

    const dirPath = validatePath(inputPath, res, req);
    if (dirPath === null) return;

    if (fs.existsSync(dirPath)) {
      return res.status(409).json({ error: 'Directory already exists' });
    }

    fs.mkdirSync(dirPath, { recursive: true });
    logSecurityEvent('dir_create', req.user.username, { path: inputPath });

    res.json({ message: 'Directory created', path: inputPath });
  } catch (err) {
    log.error('Mkdir error:', err.message);
    res.status(500).json({ error: 'Failed to create directory' });
  }
});

/**
 * POST /rename
 * Rename a file or folder
 * Body: { oldPath: "/old/name", newPath: "/new/name" }
 * Permission: write
 */
router.post('/rename', requirePermission('write'), (req, res) => {
  try {
    const { oldPath: oldInput, newPath: newInput } = req.body;
    if (!oldInput || !newInput) {
      return res.status(400).json({ error: 'Both oldPath and newPath are required' });
    }

    const oldPath = validatePath(oldInput, res, req);
    if (oldPath === null) return;
    const newPath = sanitizePathWithinBase(newInput, STORAGE_BASE);
    if (newPath === null) {
      return res.status(400).json({ error: 'Invalid new path: must be within storage directory' });
    }

    if (!fs.existsSync(oldPath)) {
      return res.status(404).json({ error: 'Source path not found' });
    }
    if (fs.existsSync(newPath)) {
      return res.status(409).json({ error: 'Destination already exists' });
    }

    fs.renameSync(oldPath, newPath);
    logSecurityEvent('file_rename', req.user.username, { from: oldInput, to: newInput });

    res.json({ message: 'Renamed successfully', from: oldInput, to: newInput });
  } catch (err) {
    log.error('Rename error:', err.message);
    res.status(500).json({ error: 'Failed to rename' });
  }
});

/**
 * POST /delete
 * Delete a file or folder
 * Body: { path: "/file/to/delete" }
 * Permission: delete
 */
router.post('/delete', requirePermission('delete'), (req, res) => {
  try {
    const inputPath = req.body.path;
    if (!inputPath) {
      return res.status(400).json({ error: 'Path parameter required' });
    }

    const targetPath = validatePath(inputPath, res, req);
    if (targetPath === null) return;

    if (!fs.existsSync(targetPath)) {
      return res.status(404).json({ error: 'Path not found' });
    }

    // Prevent deleting the storage root
    if (targetPath === STORAGE_BASE) {
      return res.status(403).json({ error: 'Cannot delete storage root' });
    }

    const stat = fs.statSync(targetPath);
    fs.rmSync(targetPath, { recursive: true, force: true });
    logSecurityEvent('file_delete', req.user.username, {
      path: inputPath,
      type: stat.isDirectory() ? 'directory' : 'file',
    });

    res.json({ message: 'Deleted successfully', path: inputPath });
  } catch (err) {
    log.error('Delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete' });
  }
});

/**
 * POST /move
 * Move a file or folder to a new location
 * Body: { source: "/path/to/source", destination: "/path/to/dest" }
 * Permission: write
 */
router.post('/move', requirePermission('write'), (req, res) => {
  try {
    const { source: srcInput, destination: destInput } = req.body;
    if (!srcInput || !destInput) {
      return res.status(400).json({ error: 'Both source and destination are required' });
    }

    const sourcePath = validatePath(srcInput, res, req);
    if (sourcePath === null) return;
    const destPath = sanitizePathWithinBase(destInput, STORAGE_BASE);
    if (destPath === null) {
      return res.status(400).json({ error: 'Invalid destination: must be within storage directory' });
    }

    if (sourcePath === destPath) {
      return res.status(400).json({ error: 'Source and destination must be different' });
    }

    if (!fs.existsSync(sourcePath)) {
      return res.status(404).json({ error: 'Source not found' });
    }

    if (fs.existsSync(destPath)) {
      return res.status(409).json({ error: 'Destination already exists' });
    }

    fs.renameSync(sourcePath, destPath);
    logSecurityEvent('file_move', req.user.username, { from: srcInput, to: destInput });

    res.json({ message: 'Moved successfully', from: srcInput, to: destInput });
  } catch (err) {
    log.error('Move error:', err.message);
    res.status(500).json({ error: 'Failed to move' });
  }
});

/**
 * POST /copy
 * Copy a file or folder
 * Body: { source: "/path/to/source", destination: "/path/to/dest" }
 * Permission: write
 */
router.post('/copy', requirePermission('write'), (req, res) => {
  try {
    const { source: srcInput, destination: destInput } = req.body;
    if (!srcInput || !destInput) {
      return res.status(400).json({ error: 'Both source and destination are required' });
    }

    const sourcePath = validatePath(srcInput, res, req);
    if (sourcePath === null) return;
    const destPath = sanitizePathWithinBase(destInput, STORAGE_BASE);
    if (destPath === null) {
      return res.status(400).json({ error: 'Invalid destination: must be within storage directory' });
    }

    if (!fs.existsSync(sourcePath)) {
      return res.status(404).json({ error: 'Source not found' });
    }

    if (sourcePath === destPath) {
      return res.status(400).json({ error: 'Source and destination must be different' });
    }

    if (fs.existsSync(destPath)) {
      return res.status(409).json({ error: 'Destination already exists' });
    }

    fs.cpSync(sourcePath, destPath, { recursive: true });
    logSecurityEvent('file_copy', req.user.username, { from: srcInput, to: destInput });

    res.json({ message: 'Copied successfully', from: srcInput, to: destInput });
  } catch (err) {
    log.error('Copy error:', err.message);
    res.status(500).json({ error: 'Failed to copy' });
  }
});

/**
 * GET /info?path=/some/file.txt
 * Get detailed file info including stat data and MIME type
 * Permission: read
 */
router.get('/info', requirePermission('read'), (req, res) => {
  try {
    const inputPath = req.query.path;
    if (!inputPath) {
      return res.status(400).json({ error: 'Path parameter required' });
    }

    const filePath = validatePath(inputPath, res, req);
    if (filePath === null) return;

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Path not found' });
    }

    const stat = fs.statSync(filePath);
    const relativePath = '/' + path.relative(STORAGE_BASE, filePath);

    res.json({
      name: path.basename(filePath),
      path: relativePath,
      type: stat.isDirectory() ? 'directory' : 'file',
      mimeType: stat.isDirectory() ? null : guessMimeType(filePath),
      size: stat.size,
      created: stat.birthtime,
      modified: stat.mtime,
      accessed: stat.atime,
      permissions: '0' + (stat.mode & parseInt('777', 8)).toString(8),
      owner: stat.uid,
      group: stat.gid,
      isSymlink: fs.lstatSync(filePath).isSymbolicLink(),
    });
  } catch (err) {
    log.error('File info error:', err.message);
    res.status(500).json({ error: 'Failed to get file info' });
  }
});

/**
 * GET /search?path=/&query=filename
 * Recursive search by filename within a directory. Max 100 results.
 * Permission: read
 */
router.get('/search', requirePermission('read'), (req, res) => {
  try {
    const inputPath = req.query.path || '/';
    const query = req.query.query;

    if (!query || query.trim().length === 0) {
      return res.status(400).json({ error: 'Search query is required' });
    }

    const searchDir = validatePath(inputPath, res, req);
    if (searchDir === null) return;

    if (!fs.existsSync(searchDir) || !fs.statSync(searchDir).isDirectory()) {
      return res.status(404).json({ error: 'Search directory not found' });
    }

    const MAX_RESULTS = 100;
    const results = [];
    searchFiles(searchDir, query.trim(), results, MAX_RESULTS);

    res.json({
      query: query.trim(),
      searchPath: inputPath,
      results,
      count: results.length,
      truncated: results.length >= MAX_RESULTS,
    });
  } catch (err) {
    log.error('Search error:', err.message);
    res.status(500).json({ error: 'Search failed' });
  }
});


// ── Independent disks (NTFS/FAT32/exFAT mounted at /mnt/independent) ──

/**
 * GET /api/files/independent
 * Returns list of mounted independent disks (subdirs of /mnt/independent/)
 */
router.get('/independent', requirePermission('read'), (req, res) => {
  try {
    if (!fs.existsSync(INDEPENDENT_BASE)) {
      return res.json({ disks: [] });
    }
    const entries = fs.readdirSync(INDEPENDENT_BASE, { withFileTypes: true });
    const disks = entries
      .filter(e => {
        if (!e.isDirectory()) return false;
        // Filter out internal Pi partitions (mmcblk) and plain 'toshiba' manual mounts
        // Keep only entries that look like external disk partitions (sdX)
        const n = e.name;
        if (n.includes('mmcblk')) return false;  // Pi SD card
        return true;
      })
      // Remove duplicates: if both 'toshiba' and 'TOSHIBA_...' exist, keep the named one
      .filter((e, idx, arr) => {
        const named = arr.find(x => x.name.toUpperCase().startsWith(e.name.toUpperCase() + '_') || x.name.toUpperCase().startsWith(e.name.toUpperCase().replace(/_SDC\d+$/, '')));
        if (named && named.name !== e.name && e.name.length < named.name.length) return false;
        return true;
      })
      .map(e => ({
        name: e.name,
        path: path.join(INDEPENDENT_BASE, e.name),
        mountpoint: '/mnt/independent/' + e.name,
      }));
    res.json({ disks });
  } catch (err) {
    log.error('Error listing independent disks:', err);
    res.json({ disks: [] });
  }
});

module.exports = router;
