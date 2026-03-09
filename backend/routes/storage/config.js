/**
 * HomePiNAS - Storage: Config
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

router.post('/config', (req, res) => {
    try {
        const { config } = req.body;
        const data = getData();

        // SECURITY: Require auth if storage already configured
        if (data.storageConfig && data.storageConfig.length > 0) {
            const sessionId = req.headers['x-session-id'];
            const session = validateSession(sessionId);
            if (!session) {
                logSecurityEvent('UNAUTHORIZED_STORAGE_CHANGE', {}, req.ip);
                return res.status(401).json({ error: 'Authentication required' });
            }
        }

        if (!Array.isArray(config)) {
            return res.status(400).json({ error: 'Invalid configuration format' });
        }

        // SECURITY: Use validateDiskConfig from sanitize module
        const validatedConfig = validateDiskConfig(config);
        if (!validatedConfig) {
            return res.status(400).json({ error: 'Invalid disk configuration. Check disk IDs and roles.' });
        }

        data.storageConfig = validatedConfig;
        saveData(data);

        logSecurityEvent('STORAGE_CONFIG', { disks: validatedConfig.length }, req.ip);
        res.json({ success: true, message: 'Storage configuration saved' });
    } catch (e) {
        log.error('Storage config error:', e);
        res.status(500).json({ error: 'Failed to save storage configuration' });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// SYSTEMD MOUNT UNIT FOR MERGERFS
// Ensures MergerFS mounts AFTER all underlying disks are ready at boot
// ════════════════════════════════════════════════════════════════════════════

/**
 * Create systemd mount unit for MergerFS pool
 * This ensures proper boot order: disks mount first, then MergerFS
 * 
 * @param {string} sources - Colon-separated list of mount points (e.g., "/mnt/disks/disk1:/mnt/disks/disk2")
 * @param {string} options - MergerFS mount options
 * @param {string[]} diskMountPoints - Array of disk mount points to wait for
 */
function createMergerFSSystemdUnit(sources, options, diskMountPoints) {

    // Generate systemd mount unit name from path: /mnt/storage -> mnt-storage.mount
    const mountUnitName = 'mnt-storage.mount';
    const mountUnitPath = `/etc/systemd/system/${mountUnitName}`;
    
    // Generate RequiresMountsFor directive for all disk mount points
    const requiresMountsFor = diskMountPoints.join(' ');
    
    // Generate After directive from disk mount points
    // Convert /mnt/disks/disk1 -> mnt-disks-disk1.mount
    const afterMounts = diskMountPoints
        .map(mp => mp.replace(/^\//, '').replace(/\//g, '-') + '.mount')
        .join(' ');
    
    const mountUnit = `# HomePiNAS MergerFS Pool Mount Unit
# Auto-generated - do not edit manually
# Ensures MergerFS mounts after all underlying disks are ready

[Unit]
Description=HomePiNAS MergerFS Storage Pool
Documentation=https://github.com/trapexit/mergerfs
After=local-fs.target ${afterMounts}
Requires=local-fs.target
RequiresMountsFor=${requiresMountsFor}
# Don't fail boot if mount fails
DefaultDependencies=no

[Mount]
What=${sources}
Where=${POOL_MOUNT}
Type=fuse.mergerfs
Options=${options}
TimeoutSec=30

[Install]
WantedBy=multi-user.target
`;

    // Write unit file via temp file + sudo
    const tempFile = `/mnt/storage/.tmp/homepinas-mergerfs-mount-${Date.now()}`;
    fs.writeFileSync(tempFile, mountUnit, 'utf8');
    
    try {
        // Copy unit file to systemd directory
        execFileSync('sudo', ['cp', tempFile, mountUnitPath], { encoding: 'utf8', timeout: 10000 });
        execFileSync('sudo', ['chmod', '644', mountUnitPath], { encoding: 'utf8', timeout: 5000 });
        
        // Reload systemd and enable the mount
        execFileSync('sudo', ['systemctl', 'daemon-reload'], { encoding: 'utf8', timeout: 10000 });
        execFileSync('sudo', ['systemctl', 'enable', mountUnitName], { encoding: 'utf8', timeout: 10000 });
        
        log.info('Created systemd mount unit:', mountUnitPath);
        
        // Also remove any MergerFS entry from fstab to avoid conflicts
        try {
            const fstabRaw = execFileSync('sudo', ['cat', '/etc/fstab'], { encoding: 'utf8', timeout: 10000 });
            const fstabFiltered = fstabRaw.split('\n').filter(line => !/\/mnt\/storage.*mergerfs/.test(line)).join('\n');
            const tempFstabClean = `/tmp/homepinas-fstab-clean-${Date.now()}`;
            fs.writeFileSync(tempFstabClean, fstabFiltered, 'utf8');
            execFileSync('sudo', ['cp', tempFstabClean, '/etc/fstab'], { encoding: 'utf8', timeout: 10000 });
            try { fs.unlinkSync(tempFstabClean); } catch (e2) {}
            log.info('Removed MergerFS fstab entry (now using systemd)');
        } catch (e) {
            // Ignore - fstab entry might not exist
        }
    } finally {
        // Clean up temp file
        try { fs.unlinkSync(tempFile); } catch (e) {}
    }
}

/**
 * Update systemd mount unit when disks change
 * Called when adding/removing disks from pool
 */
function updateMergerFSSystemdUnit(sources, policy = 'mfs') {
    const hasCache = sources.includes('cache');
    const policyToUse = hasCache ? 'ff' : policy;
    const options = `defaults,allow_other,nonempty,use_ino,cache.files=partial,dropcacheonclose=true,category.create=${policyToUse},moveonenospc=true`;
    
    // Extract mount points from sources
    const mountPoints = sources.split(':').filter(s => s);
    
    createMergerFSSystemdUnit(sources, options, mountPoints);
}


module.exports = router;
