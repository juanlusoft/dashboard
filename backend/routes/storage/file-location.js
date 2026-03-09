/**
 * HomePiNAS - Storage: File Location
 * Split from storage.js for maintainability (max 300 lines rule)
 */

const log = require('../../utils/logger');
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const { requireAuth } = require('../../middleware/auth');
const { logSecurityEvent } = require('../../utils/security');
const { getData, saveData } = require('../../utils/data');
const { sanitizeDiskId, validateDiskConfig, sanitizePathWithinBase } = require('../../utils/sanitize');
const { STORAGE_MOUNT_BASE, POOL_MOUNT, SNAPRAID_CONF, formatSize } = require('./shared');


// SnapRAID sync progress tracking
let snapraidSyncStatus = {
    running: false,
    progress: 0,
    status: '',
    startTime: null,
    error: null
};

// Format size: GB → TB when appropriate

// Get storage pool status (real-time)

/**
 * GET /file-location - Get physical disk location of a file in the MergerFS pool
 * Query: ?path=/mnt/storage/some/file.txt
 */
router.get('/file-location', requireAuth, async (req, res) => {
    try {
        const filePath = req.query.path;
        if (!filePath) {
            return res.status(400).json({ error: 'Path parameter required' });
        }

        // Validate path is within pool
        const safePath = sanitizePathWithinBase(filePath.replace(/^\/mnt\/storage\//, ''), POOL_MOUNT);
        if (!safePath) {
            return res.status(400).json({ error: 'Path must be within the storage pool' });
        }

        // Use getfattr to get the source mount from MergerFS
        let location = 'unknown';
        let diskType = 'unknown';
        try {
            const xattrOutput = execFileSync('getfattr', ['-n', 'user.mergerfs.srcpath', '--only-values', safePath], {
                encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'ignore']
            }).trim();

            if (xattrOutput) {
                location = xattrOutput;
                // Determine if cache or data
                if (xattrOutput.includes('/cache')) {
                    diskType = 'cache';
                } else if (xattrOutput.includes('/disk')) {
                    diskType = 'data';
                }
            }
        } catch (e) {
            // getfattr might not be installed or file doesn't support xattrs
            // Fallback: check which underlying mount contains this file
            try {
                const relativePath = safePath.replace(POOL_MOUNT, '');
                const data = getData();
                const config = data.storageConfig || [];
                
                for (const disk of config) {
                    const mountBase = disk.role === 'cache' ? 'cache' : 'disk';
                    const idx = config.filter(d => d.role === disk.role).indexOf(disk) + 1;
                    const checkPath = `${STORAGE_MOUNT_BASE}/${mountBase}${idx}${relativePath}`;
                    try {
                        fs.statSync(checkPath);
                        location = `${STORAGE_MOUNT_BASE}/${mountBase}${idx}`;
                        diskType = disk.role;
                        break;
                    } catch (e2) {}
                }
            } catch (e2) {}
        }

        res.json({
            path: filePath,
            physicalLocation: location,
            diskType
        });
    } catch (e) {
        log.error('File location error:', e);
        res.status(500).json({ error: 'Failed to get file location' });
    }
});

/**
 * POST /file-locations - Batch get physical locations for multiple files
 * Body: { paths: ["/mnt/storage/file1", "/mnt/storage/file2", ...] }
 * Returns: { locations: { "/mnt/storage/file1": { diskType: "cache"|"data", physicalLocation: "..." }, ... } }
 */
router.post('/file-locations', requireAuth, async (req, res) => {
    try {
        const { paths } = req.body;
        if (!Array.isArray(paths) || paths.length === 0) {
            return res.status(400).json({ error: 'paths array required' });
        }

        // Limit to 100 files per batch
        const limitedPaths = paths.slice(0, 100);
        const locations = {};

        for (const filePath of limitedPaths) {
            const safePath = sanitizePathWithinBase(
                filePath.replace(/^\/mnt\/storage\//, ''),
                POOL_MOUNT
            );
            if (!safePath) continue;

            try {
                const xattr = execFileSync('getfattr', ['-n', 'user.mergerfs.srcpath', '--only-values', safePath], {
                    encoding: 'utf8', timeout: 2000, stdio: ['pipe', 'pipe', 'ignore']
                }).trim();

                if (xattr) {
                    locations[filePath] = {
                        diskType: xattr.includes('/cache') ? 'cache' : xattr.includes('/disk') ? 'data' : 'unknown',
                        physicalLocation: xattr
                    };
                }
            } catch (e) {
                // File may not exist on mergerfs or getfattr not available
            }
        }

        res.json({ locations });
    } catch (e) {
        log.error('Batch file locations error:', e);
        res.status(500).json({ error: 'Failed to get file locations' });
    }
});

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Add a disk to the MergerFS pool
 * POST /disks/add-to-pool
 * Body: { diskId: 'sdb', format: true/false, role: 'data'|'cache', force: false }
 * 
 * Validations performed:
 * 1. Disk ID is valid and sanitized
 * 2. Device exists in /dev
 * 3. Device is a block device (not a file or directory)
 * 4. If has existing data and format=false, warns but allows with force=true
 * 5. Partition is valid and mountable
 */

module.exports = router;
