/**
 * HomePiNAS v2 - NFS Share Management Routes
 * Manage NFS shared folders through the dashboard
 */

const log = require('../utils/logger');
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const { requireAuth } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/rbac');
const { logSecurityEvent, sudoExec } = require('../utils/security');
const { sanitizePathWithinBase } = require('../utils/sanitize');
const { getData } = require('../utils/data');

const EXPORTS_PATH = '/etc/exports';
const STORAGE_BASE = '/mnt/storage';

// ─── /etc/exports Parsing & Writing Helpers ────────────────────────────────

/**
 * Parse /etc/exports and extract NFS share definitions.
 * Returns an array: [ { path, network, options } ]
 * 
 * Example line: /mnt/storage/media 192.168.1.0/24(rw,sync,no_subtree_check)
 */
function parseExports() {
  if (!fs.existsSync(EXPORTS_PATH)) {
    return [];
  }

  const content = fs.readFileSync(EXPORTS_PATH, 'utf8');
  const lines = content.split('\n');
  const shares = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Skip comments and empty lines
    if (line === '' || line.startsWith('#')) {
      continue;
    }

    // Parse: /path client(options)
    // Example: /mnt/storage/media 192.168.1.0/24(rw,sync,no_subtree_check)
    const match = line.match(/^(\S+)\s+(\S+)\(([^)]+)\)/);
    if (match) {
      const [, sharePath, network, options] = match;
      shares.push({
        path: sharePath,
        network: network,
        options: options,
      });
    }
  }

  return shares;
}

/**
 * Build an /etc/exports line for a share
 */
function buildExportLine(share) {
  const network = share.network || '192.168.1.0/24';
  const options = share.options || 'rw,sync,no_subtree_check';
  return `${share.path} ${network}(${options})`;
}

/**
 * Read the full /etc/exports content
 */
function readExports() {
  if (!fs.existsSync(EXPORTS_PATH)) {
    return '';
  }
  return fs.readFileSync(EXPORTS_PATH, 'utf8');
}

/**
 * Write new content to /etc/exports using a temp file + sudo mv approach
 */
async function writeExports(content) {
  const tmpFile = `/tmp/homepinas-exports-${Date.now()}.tmp`;
  
  fs.writeFileSync(tmpFile, content, 'utf8');

  try {
    // Backup current config
    if (fs.existsSync(EXPORTS_PATH)) {
      await sudoExec('cp', [EXPORTS_PATH, `${EXPORTS_PATH}.bak`]);
    }
    // Move temp file to exports location
    await sudoExec('mv', [tmpFile, EXPORTS_PATH]);
    // Ensure correct ownership and permissions
    await sudoExec('chown', ['root:root', EXPORTS_PATH]);
    await sudoExec('chmod', ['644', EXPORTS_PATH]);
  } catch (err) {
    // Clean up temp file on failure
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Remove a share from exports content by path
 */
function removeShareFromExports(content, sharePath) {
  const lines = content.split('\n');
  const result = lines.filter(line => {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return true;
    // Check if this line starts with the share path
    return !trimmed.startsWith(sharePath + ' ');
  });
  return result.join('\n');
}

/**
 * Replace or add a share in exports content
 */
function upsertShareInExports(content, sharePath, newLine) {
  // First remove the old entry if it exists
  let modified = removeShareFromExports(content, sharePath);

  // Ensure there's a newline at the end before appending
  if (!modified.endsWith('\n') && modified !== '') {
    modified += '\n';
  }

  // Append the new line
  modified += newLine + '\n';

  return modified;
}

/**
 * Reload NFS exports
 */
async function reloadNFS() {
  await sudoExec('exportfs', ['-ra']);
}

// All routes require authentication
router.use(requireAuth);

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * GET /shares
 * List all configured NFS shares (parsed from /etc/exports)
 */
router.get('/shares', requireAdmin, (req, res) => {
  try {
    const shares = parseExports();

    const result = shares.map(share => ({
      path: share.path,
      network: share.network,
      options: share.options,
      readOnly: share.options.includes('ro'),
    }));

    res.json({ shares: result, count: result.length });
  } catch (err) {
    log.error('List NFS shares error:', err.message);
    res.status(500).json({ error: 'Failed to read NFS configuration' });
  }
});

/**
 * POST /shares
 * Create a new NFS share
 * Body: { path, network, readOnly }
 */
router.post('/shares', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { path: sharePath, network, readOnly } = req.body;

    // Validate path is within storage
    if (!sharePath) {
      return res.status(400).json({ error: 'Share path is required' });
    }
    const sanitizedPath = sanitizePathWithinBase(sharePath, STORAGE_BASE);
    if (sanitizedPath === null) {
      return res.status(400).json({ error: 'Share path must be within /mnt/storage' });
    }

    // Check if share already exists
    const existingShares = parseExports();
    if (existingShares.some(s => s.path === sanitizedPath)) {
      return res.status(409).json({ error: 'A share with this path already exists' });
    }

    // Ensure the share directory exists
    if (!fs.existsSync(sanitizedPath)) {
      fs.mkdirSync(sanitizedPath, { recursive: true });
    }

    // Build the share config
    const shareNetwork = network || '192.168.1.0/24';
    const baseOptions = readOnly ? 'ro' : 'rw';

    // Generate a stable numeric fsid from the path (required for FUSE/MergerFS exports)
    const fsid = Math.abs(sanitizedPath.split('').reduce((h, c) => (Math.imul(31, h) + c.charCodeAt(0)) | 0, 0)) % 65535 || 1;
    const shareOptions = `${baseOptions},sync,no_subtree_check,fsid=${fsid}`;

    const shareConfig = {
      path: sanitizedPath,
      network: shareNetwork,
      options: shareOptions,
    };

    const exportLine = buildExportLine(shareConfig);

    // Add to /etc/exports
    const currentExports = readExports();
    const newExports = upsertShareInExports(currentExports, sanitizedPath, exportLine);
    await writeExports(newExports);

    // Reload NFS
    await reloadNFS();

    logSecurityEvent('nfs_share_created', req.user.username, {
      path: sanitizedPath,
      network: shareNetwork,
    });

    res.status(201).json({
      message: `NFS share created successfully`,
      share: shareConfig,
    });
  } catch (err) {
    log.error('Create NFS share error:', err.message);
    res.status(500).json({ error: 'Failed to create NFS share' });
  }
});

/**
 * DELETE /shares
 * Remove an NFS share from configuration by path
 * Body: { path }
 */
router.delete('/shares', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { path: sharePath } = req.body;

    if (!sharePath) {
      return res.status(400).json({ error: 'Share path is required' });
    }

    // Verify share exists
    const existingShares = parseExports();
    const existing = existingShares.find(s => s.path === sharePath);
    if (!existing) {
      return res.status(404).json({ error: 'NFS share not found' });
    }

    // Remove from /etc/exports
    const currentExports = readExports();
    const newExports = removeShareFromExports(currentExports, sharePath);
    await writeExports(newExports);

    // Reload NFS
    await reloadNFS();

    logSecurityEvent('nfs_share_deleted', req.user.username, {
      path: sharePath,
    });

    res.json({ message: `NFS share deleted successfully` });
  } catch (err) {
    log.error('Delete NFS share error:', err.message);
    res.status(500).json({ error: 'Failed to delete NFS share' });
  }
});

/**
 * GET /status
 * Get NFS service status
 */
router.get('/status', requireAdmin, async (req, res) => {
  try {
    // Check if nfs-server is running
    let serviceStatus = 'unknown';
    try {
      const { stdout } = await execFileAsync('systemctl', ['is-active', 'nfs-server']);
      serviceStatus = stdout.trim();
    } catch (err) {
      serviceStatus = err.stdout ? err.stdout.trim() : 'inactive';
    }

    // Get current exports
    let currentExports = [];
    try {
      const { stdout } = await execFileAsync('sudo', ['exportfs', '-v']);
      // Parse exportfs output (simplified)
      const lines = stdout.split('\n').filter(l => l.trim() && !l.startsWith('#'));
      for (const line of lines) {
        if (line.startsWith('/')) {
          currentExports.push(line.trim());
        }
      }
    } catch (err) {
      log.warn('Could not get exportfs status:', err.message);
    }

    let connectedCount = 0;
    try {
      const { stdout: ssOut } = await execFileAsync('sudo', ['ss', '-tun']);
      for (const line of ssOut.split('\n')) {
        if (line.includes(':2049') && line.includes('ESTAB')) {
          connectedCount++;
        }
      }
    } catch (err) {
      console.warn('Could not get NFS connections:', err.message);
    }

    res.json({
      service: serviceStatus,
      running: serviceStatus === 'active',
      currentExports,
      exportsCount: currentExports.length,
      connectedCount,
    });
  } catch (err) {
    log.error('NFS status error:', err.message);
    res.status(500).json({ error: 'Failed to get NFS status' });
  }
});

/**
 * POST /reload
 * Reload NFS exports (exportfs -ra)
 */
router.post('/reload', requireAuth, requireAdmin, async (req, res) => {
  try {
    await reloadNFS();

    logSecurityEvent('nfs_reload', req.user.username);

    res.json({
      message: 'NFS exports reloaded',
    });
  } catch (err) {
    log.error('NFS reload error:', err.message);
    res.status(500).json({ error: 'Failed to reload NFS exports' });
  }
});

module.exports = router;
