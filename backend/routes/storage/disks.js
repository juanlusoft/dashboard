/**
 * HomePiNAS - Storage: Disks
 * Split from storage.js for maintainability (max 300 lines rule)
 */

const log = require('../../utils/logger');
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const { requireAuth } = require('../../middleware/auth');
const { requireAdmin } = require('../../middleware/rbac');
const { logSecurityEvent } = require('../../utils/security');
const { getData, saveData } = require('../../utils/data');
const { sanitizeDiskId, validateDiskConfig, sanitizePathWithinBase } = require('../../utils/sanitize');
const { STORAGE_MOUNT_BASE, POOL_MOUNT, SNAPRAID_CONF, formatSize } = require('./shared');



router.post('/disks/add-to-pool', requireAdmin, async (req, res) => {
    try {
        const { diskId, format, role = 'data', force = false, filesystem = 'ext4' } = req.body;
        
        // ══════════════════════════════════════════════════════════════════
        // VALIDATION PHASE
        // ══════════════════════════════════════════════════════════════════
        
        // 1. Validate disk ID format
        const safeDiskId = sanitizeDiskId(diskId);
        if (!safeDiskId) {
            return res.status(400).json({ 
                error: 'Invalid disk ID format',
                details: 'Disk ID must be alphanumeric (e.g., sda, nvme0n1)'
            });
        }
        
        // 2. Validate role
        if (!['data', 'cache', 'parity'].includes(role)) {
            return res.status(400).json({ 
                error: 'Invalid role',
                details: 'Role must be: data, cache, or parity'
            });
        }

        const devicePath = `/dev/${safeDiskId}`;
        
        // 3. Check if device exists
        if (!fs.existsSync(devicePath)) {
            return res.status(400).json({ 
                error: 'Device not found',
                details: `${devicePath} does not exist. Is the disk connected?`
            });
        }
        
        // 4. Verify it's a block device
        try {
            const statResult = execFileSync('stat', ['-c', '%F', devicePath], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
            if (!statResult.includes('block')) {
                return res.status(400).json({
                    error: 'Not a block device',
                    details: `${devicePath} is not a valid disk device`
                });
            }
        } catch (e) {
            return res.status(400).json({
                error: 'Cannot verify device',
                details: `Failed to stat ${devicePath}: ${e.message}`
            });
        }
        
        // 5. Check if disk is already in the pool
        const data = getData();
        const existingDisk = (data.storageConfig || []).find(d => d.id === safeDiskId);
        if (existingDisk) {
            return res.status(400).json({
                error: 'Disk already in pool',
                details: `${safeDiskId} is already configured as ${existingDisk.role}`
            });
        }
        
        // 6. Get disk info and check for existing partitions/data
        let hasPartition = false;
        let hasFilesystem = false;
        let hasData = false;
        let partitionPath = '';
        let diskSize = 0;
        
        try {
            // Check for existing partitions using lsblk
            const lsblkJson = execFileSync('lsblk', ['-Jbo', 'NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT', `/dev/${safeDiskId}`], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
            const lsblk = JSON.parse(lsblkJson);
            const device = (lsblk.blockdevices || [])[0];
            
            if (device) {
                diskSize = device.size || 0;
                
                if (device.children && device.children.length > 0) {
                    hasPartition = true;
                    const firstPart = device.children[0];
                    partitionPath = `/dev/${firstPart.name}`;
                    
                    if (firstPart.fstype) {
                        hasFilesystem = true;
                    }
                    
                    // Check if mounted somewhere (indicates data)
                    if (firstPart.mountpoint) {
                        hasData = true;
                    }
                }
            }
        } catch (e) {
            log.info('lsblk check failed, continuing:', e.message);
        }
        
        // Determine partition path (for NVMe vs SATA)
        if (!partitionPath) {
            partitionPath = safeDiskId.includes('nvme') ? `/dev/${safeDiskId}p1` : `/dev/${safeDiskId}1`;
        }
        
        // 7. If disk has existing filesystem and format=false, require confirmation
        if (hasFilesystem && !format && !force) {
            return res.status(409).json({
                error: 'Disk has existing data',
                details: `${safeDiskId} has an existing filesystem. Set format=true to erase, or force=true to use existing data`,
                hasData: true,
                requiresConfirmation: true
            });
        }
        
        // 8. Verify disk is not the boot disk
        try {
            const rootDeviceRaw = execFileSync('findmnt', ['-n', '-o', 'SOURCE', '/'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
            const rootDevice = rootDeviceRaw.replace(/[0-9]*$/, '').replace(/p[0-9]*$/, '');
            if (rootDevice.includes(safeDiskId)) {
                return res.status(400).json({
                    error: 'Cannot use boot disk',
                    details: 'This appears to be the system boot disk'
                });
            }
        } catch (e) {
            // Ignore - extra safety check
        }
        
        // ══════════════════════════════════════════════════════════════════
        // PREPARATION PHASE
        // ══════════════════════════════════════════════════════════════════
        
        // Step 1: Unmount ALL partitions of this disk (MUST be first!)
        try {
            // Find all mount points for this disk (any partition)
            const mountAllRaw = execFileSync('mount', [], { encoding: 'utf8' });
            const mountCheck = mountAllRaw.split('\n').filter(l => l.includes(`/dev/${safeDiskId}`)).join('\n');
            if (mountCheck.trim()) {
                log.info(`Unmounting all partitions of /dev/${safeDiskId}...`);
                const mountLines = mountCheck.trim().split('\n');
                for (const line of mountLines) {
                    const mountedDev = line.split(' ')[0];
                    if (mountedDev) {
                        log.info(`  Unmounting ${mountedDev}...`);
                        try {
                            execFileSync('sudo', ['umount', mountedDev], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
                        } catch (e) {
                            try {
                                execFileSync('sudo', ['umount', '-l', mountedDev], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
                            } catch (e2) {
                                log.info(`  Failed to unmount ${mountedDev}: ${e2.message}`);
                            }
                        }
                    }
                }
                // Wait for unmount to complete
                execFileSync('sleep', ['1'], { encoding: 'utf8' });
            }
        } catch (e) {
            log.info('Unmount check/attempt:', e.message);
        }
        
        // Step 2: Create partition if needed (for new disks or format requested)
        if (!hasPartition || format) {
            try {
                log.info(`Creating partition on ${devicePath}...`);
                execFileSync('sudo', ['parted', '-s', devicePath, 'mklabel', 'gpt'], { encoding: 'utf8', timeout: 30000 });
                execFileSync('sudo', ['parted', '-s', devicePath, 'mkpart', 'primary', 'ext4', '0%', '100%'], { encoding: 'utf8', timeout: 30000 });
                execFileSync('sync', [], { encoding: 'utf8' });
                execFileSync('sudo', ['partprobe', devicePath], { encoding: 'utf8', timeout: 10000 });
                // Wait for kernel to register new partition
                try { execFileSync('sudo', ['udevadm', 'settle', '--timeout=10'], { encoding: 'utf8', timeout: 12000 }); } catch(e) {}
                execFileSync('sleep', ['3'], { encoding: 'utf8' });
                hasPartition = true;
            } catch (e) {
                if (!hasPartition) {
                    return res.status(500).json({ 
                        error: 'Failed to create partition',
                        details: e.message
                    });
                }
                // Partition might already exist, continue
                log.info('Partition creation skipped (may already exist):', e.message);
            }
        }
        
        // Step 3: Format if requested
        log.info(`Step 3 check: format=${format}, partitionPath=${partitionPath}, filesystem=${filesystem}`);
        if (format) {
            const label = `${role}_${safeDiskId}`.substring(0, 16);
            try {
                log.info(`Formatting ${partitionPath} as ${filesystem || 'ext4'} with label ${label}...`);
                if (filesystem === 'xfs') {
                    execFileSync('/sbin/mkfs.xfs', ['-f', '-L', label, partitionPath], { encoding: 'utf8', timeout: 300000, stdio: ['pipe','pipe','pipe'] });
                } else {
                    execFileSync('/sbin/mkfs.ext4', ['-F', '-L', label, partitionPath], { encoding: 'utf8', timeout: 300000, stdio: ['pipe','pipe','pipe'] });
                }
                log.info(`Format complete: ${partitionPath}`);
            } catch (e) {
                log.info(`Format error: ${e.message} | stderr: ${e.stderr || ''}`);
                return res.status(500).json({
                    error: 'Format failed',
                    details: e.message
                });
            }
        }

        // Step 4: Verify partition is mountable (test mount)
        const testMountPoint = `/mnt/storage/.tmp/homepinas-test-mount-${Date.now()}`;
        try {
            execFileSync('sudo', ['mkdir', '-p', testMountPoint], { encoding: 'utf8' });
            execFileSync('sudo', ['mount', partitionPath, testMountPoint], { encoding: 'utf8', timeout: 30000 });
            execFileSync('sudo', ['umount', testMountPoint], { encoding: 'utf8' });
            execFileSync('sudo', ['rmdir', testMountPoint], { encoding: 'utf8' });
        } catch (e) {
            try { execFileSync('sudo', ['umount', testMountPoint], { stdio: 'ignore' }); } catch {}
            try { execFileSync('sudo', ['rmdir', testMountPoint], { stdio: 'ignore' }); } catch {}
            return res.status(500).json({
                error: 'Disk not mountable',
                details: `Failed to mount ${partitionPath}. Is it formatted? Error: ${e.message}`
            });
        }

        // ══════════════════════════════════════════════════════════════════
        // INTEGRATION PHASE
        // ══════════════════════════════════════════════════════════════════

        // Step 5: Get UUID
        let uuid = '';
        try {
            uuid = execFileSync('sudo', ['blkid', '-s', 'UUID', '-o', 'value', partitionPath], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
        } catch (e) {
            return res.status(500).json({ error: 'Failed to get disk UUID' });
        }

        if (!uuid) {
            return res.status(500).json({ error: 'Could not determine disk UUID. Is it formatted?' });
        }

        // Step 4: Create mount point
        const mountIndex = await getNextDiskIndex();
        const mountPoint = `${STORAGE_MOUNT_BASE}/disk${mountIndex}`;
        
        try {
            execFileSync('sudo', ['mkdir', '-p', mountPoint], { encoding: 'utf8' });
        } catch (e) {
            return res.status(500).json({ error: 'Failed to create mount point' });
        }

        // Step 5: Mount the disk
        try {
            execFileSync('sudo', ['mount', `UUID=${uuid}`, mountPoint], { encoding: 'utf8' });
        } catch (e) {
            return res.status(500).json({ error: `Mount failed: ${e.message}` });
        }

        // Step 6: Add to fstab
        const fsType = filesystem === 'xfs' ? 'xfs' : 'ext4';
        const fstabEntry = `UUID=${uuid} ${mountPoint} ${fsType} defaults,nofail 0 2`;
        try {
            // Check if entry already exists
            const fstab = fs.readFileSync('/etc/fstab', 'utf8');
            if (!fstab.includes(uuid)) {
                const fstabAppend = `\n# HomePiNAS: ${safeDiskId} (${role})\n${fstabEntry}\n`;
                execFileSync('sudo', ['tee', '-a', '/etc/fstab'], { input: fstabAppend, encoding: 'utf8', stdio: ['pipe', 'ignore', 'pipe'] });
            }
        } catch (e) {
            log.error('fstab update failed:', e);
            // Continue anyway, disk is mounted
        }

        // Step 7: Add to MergerFS pool
        try {
            await addDiskToMergerFS(mountPoint, role);
        } catch (e) {
            return res.status(500).json({ error: `Failed to add to pool: ${e.message}` });
        }

        // Step 8: Update storage config
        const storageData = getData();
        if (!storageData.storageConfig) storageData.storageConfig = [];
        storageData.storageConfig.push({
            id: safeDiskId,
            role: role,
            uuid: uuid,
            mountPoint: mountPoint,
            addedAt: new Date().toISOString()
        });
        saveData(storageData);

        logSecurityEvent('DISK_ADDED_TO_POOL', { diskId: safeDiskId, role, mountPoint }, req.ip);

        res.json({ 
            success: true, 
            message: `Disk ${safeDiskId} added to pool as ${role}`,
            mountPoint,
            uuid
        });
    } catch (e) {
        log.error('Add to pool error:', e);
        res.status(500).json({ error: `Failed to add disk: ${e.message}` });
    }
});

/**
 * Remove disk from pool
 * POST /disks/remove-from-pool
 * Body: { diskId: 'sdb' }
 */
router.post('/disks/remove-from-pool', requireAdmin, async (req, res) => {
    try {
        const { diskId } = req.body;
        
        const safeDiskId = sanitizeDiskId(diskId);
        if (!safeDiskId) {
            return res.status(400).json({ error: 'Invalid disk ID' });
        }

        // Find disk in storage config
        const data = getData();
        if (!data.storageConfig) data.storageConfig = [];
        
        const diskConfig = data.storageConfig.find(d => d.id === safeDiskId);
        if (!diskConfig) {
            return res.status(400).json({ error: 'Disk not found in pool configuration' });
        }

        const mountPoint = diskConfig.mountPoint;
        if (!mountPoint) {
            return res.status(400).json({ error: 'Disk mount point not found' });
        }

        // Get current MergerFS sources
        let currentSources = '';
        let isMounted = false;
        
        try {
            const mountsAll = execFileSync('mount', [], { encoding: 'utf8' });
            const mounts = mountsAll.split('\n').filter(l => l.includes('mergerfs')).join('\n').trim();
            if (mounts) {
                isMounted = true;
                const match = mounts.match(/^(.+?) on \/mnt\/storage type fuse\.mergerfs/);
                if (match) {
                    currentSources = match[1];
                }
            }
        } catch (e) {
            // MergerFS not mounted
        }

        // Remove this mount point from sources
        const sourcesList = currentSources.split(':').filter(s => s && s !== mountPoint);

        if (sourcesList.length === 0) {
            return res.status(400).json({ error: 'Cannot remove last disk from pool. At least one disk must remain.' });
        }

        const newSources = sourcesList.join(':');

        // Unmount MergerFS
        if (isMounted) {
            try {
                execFileSync('sudo', ['umount', POOL_MOUNT], { encoding: 'utf8' });
            } catch (e) {
                try {
                    execFileSync('sudo', ['umount', '-l', POOL_MOUNT], { encoding: 'utf8' });
                } catch (e2) {
                    return res.status(500).json({ error: 'Cannot unmount pool. Files may be in use.' });
                }
            }
        }

        // Remount with remaining disks
        try {
            execFileSync('sudo', ['mergerfs', '-o', 'defaults,allow_other,nonempty,use_ino,cache.files=partial,dropcacheonclose=true,category.create=mfs,moveonenospc=true', newSources, POOL_MOUNT], { encoding: 'utf8' });
        } catch (e) {
            return res.status(500).json({ error: `Failed to remount pool: ${e.message}` });
        }

        // Update fstab
        updateMergerFSFstab(newSources, 'mfs');

        // Remove from storage config
        data.storageConfig = data.storageConfig.filter(d => d.id !== safeDiskId);
        saveData(data);

        logSecurityEvent('DISK_REMOVED_FROM_POOL', { diskId: safeDiskId, mountPoint }, req.ip);

        res.json({ 
            success: true, 
            message: `Disk ${safeDiskId} removed from pool`,
            remainingDisks: sourcesList.length
        });
    } catch (e) {
        log.error('Remove from pool error:', e);
        res.status(500).json({ error: `Failed to remove disk: ${e.message}` });
    }
});

/**
 * Mount disk as standalone volume (not in pool)
 * POST /disks/mount-standalone
 * Body: { diskId: 'sdb', format: true/false, name: 'backups' }
 */
router.post('/disks/mount-standalone', requireAdmin, async (req, res) => {
    try {
        const { diskId, format, name, filesystem = 'ext4' } = req.body;
        
        const safeDiskId = sanitizeDiskId(diskId);
        if (!safeDiskId) {
            return res.status(400).json({ error: 'Invalid disk ID' });
        }

        // Sanitize volume name
        const safeName = (name || safeDiskId).replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 32);
        if (!safeName) {
            return res.status(400).json({ error: 'Invalid volume name' });
        }

        const devicePath = `/dev/${safeDiskId}`;
        const partitionPath = `/dev/${safeDiskId}1`;
        const mountPoint = `/mnt/${safeName}`;

        if (!fs.existsSync(devicePath)) {
            return res.status(400).json({ error: `Device ${devicePath} not found` });
        }

        // Create partition if needed
        try {
            execFileSync('sudo', ['parted', '-s', devicePath, 'mklabel', 'gpt'], { encoding: 'utf8' });
            execFileSync('sudo', ['parted', '-s', devicePath, 'mkpart', 'primary', 'ext4', '0%', '100%'], { encoding: 'utf8' });
            execFileSync('sleep', ['2'], { encoding: 'utf8' });
        } catch (e) {
            log.info('Partition exists or creation skipped');
        }

        // Format if requested
        if (format) {
            try {
                if (filesystem === 'xfs') {
                    execFileSync('sudo', ['mkfs.xfs', '-f', '-L', safeName, partitionPath], { encoding: 'utf8', timeout: 300000 });
                } else {
                    execFileSync('sudo', ['mkfs.ext4', '-F', '-L', safeName, partitionPath], { encoding: 'utf8', timeout: 300000 });
                }
            } catch (e) {
                return res.status(500).json({ error: `Format failed: ${e.message}` });
            }
        }

        // Get UUID
        let uuid = '';
        try {
            uuid = execFileSync('sudo', ['blkid', '-s', 'UUID', '-o', 'value', partitionPath], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
        } catch (e) {
            return res.status(500).json({ error: 'Failed to get UUID' });
        }

        // Create mount point and mount
        try {
            execFileSync('sudo', ['mkdir', '-p', mountPoint], { encoding: 'utf8' });
            execFileSync('sudo', ['mount', `UUID=${uuid}`, mountPoint], { encoding: 'utf8' });
        } catch (e) {
            return res.status(500).json({ error: `Mount failed: ${e.message}` });
        }

        // Add to fstab
        const fsType = filesystem === 'xfs' ? 'xfs' : 'ext4';
        const fstabEntry = `UUID=${uuid} ${mountPoint} ${fsType} defaults,nofail 0 2`;
        try {
            const fstab = fs.readFileSync('/etc/fstab', 'utf8');
            if (!fstab.includes(uuid)) {
                const fstabAppend = `\n# HomePiNAS: Standalone volume ${safeName}\n${fstabEntry}\n`;
                execFileSync('sudo', ['tee', '-a', '/etc/fstab'], { input: fstabAppend, encoding: 'utf8', stdio: ['pipe', 'ignore', 'pipe'] });
            }
        } catch (e) {
            log.error('fstab update failed:', e);
        }

        // Save to config as standalone volume
        const data = getData();
        if (!data.standaloneVolumes) data.standaloneVolumes = [];
        data.standaloneVolumes.push({
            id: safeDiskId,
            name: safeName,
            uuid: uuid,
            mountPoint: mountPoint,
            addedAt: new Date().toISOString()
        });
        saveData(data);

        logSecurityEvent('STANDALONE_VOLUME_CREATED', { diskId: safeDiskId, name: safeName, mountPoint }, req.ip);

        res.json({
            success: true,
            message: `Volume "${safeName}" created at ${mountPoint}`,
            mountPoint,
            uuid
        });
    } catch (e) {
        log.error('Standalone mount error:', e);
        res.status(500).json({ error: `Failed: ${e.message}` });
    }
});

/**
 * Dismiss/ignore a detected disk (won't show in notifications)
 * POST /disks/ignore
 */
router.post('/disks/ignore', requireAuth, async (req, res) => {
    try {
        const { diskId } = req.body;
        const safeDiskId = sanitizeDiskId(diskId);
        if (!safeDiskId) {
            return res.status(400).json({ error: 'Invalid disk ID' });
        }

        const data = getData();
        if (!data.ignoredDisks) data.ignoredDisks = [];
        if (!data.ignoredDisks.includes(safeDiskId)) {
            data.ignoredDisks.push(safeDiskId);
            saveData(data);
        }

        res.json({ success: true, message: `Disk ${safeDiskId} ignored` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * Get list of ignored disks
 */
router.get('/disks/ignored', requireAuth, (req, res) => {
    const data = getData();
    res.json({ ignored: data.ignoredDisks || [] });
});

/**
 * Un-ignore a disk
 */
router.post('/disks/unignore', requireAuth, async (req, res) => {
    try {
        const { diskId } = req.body;
        const safeDiskId = sanitizeDiskId(diskId);
        if (!safeDiskId) {
            return res.status(400).json({ error: 'Invalid disk ID' });
        }
        const data = getData();
        if (data.ignoredDisks) {
            data.ignoredDisks = data.ignoredDisks.filter(d => d !== safeDiskId);
            saveData(data);
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Helper: Get next disk index for mount point
async function getNextDiskIndex() {
    try {
        // Use first available index not already mounted
        const mountsRaw = execFileSync('mount', [], { encoding: 'utf8' });
        const mountedIndices = new Set();
        for (const line of mountsRaw.split('\n')) {
            const m = line.match(/\/mnt\/disks\/disk(\d+)\s/);
            if (m) mountedIndices.add(parseInt(m[1]));
        }
        let i = 1;
        while (mountedIndices.has(i)) i++;
        return i;
    } catch (e) {
        return 1;
    }
}

// Helper: Add disk to MergerFS pool (hot add)
async function addDiskToMergerFS(mountPoint, role) {
    try {
        // Check if MergerFS is currently mounted
        let currentSources = '';
        let isMounted = false;
        
        try {
            const mountsAllRaw = execFileSync('mount', [], { encoding: 'utf8' });
            const mounts = mountsAllRaw.split('\n').filter(l => l.includes('mergerfs')).join('\n').trim();
            if (mounts) {
                isMounted = true;
                const match = mounts.match(/^(.+?) on \/mnt\/storage type fuse\.mergerfs/);
                if (match) {
                    currentSources = match[1];
                }
            }
        } catch (e) {
            // MergerFS not mounted, that's OK
            isMounted = false;
        }

        // Build new sources list
        let newSources;
        if (currentSources) {
            // Add to existing sources
            if (role === 'cache') {
                newSources = `${mountPoint}:${currentSources}`;
            } else {
                newSources = `${currentSources}:${mountPoint}`;
            }
        } else {
            // First disk in pool or MergerFS not running
            // Scan for all mounted data disks in /mnt/disks
            const diskDirs = fs.readdirSync(STORAGE_MOUNT_BASE)
                .filter(d => d.startsWith('disk'))
                .map(d => `${STORAGE_MOUNT_BASE}/${d}`)
                .filter(p => {
                    try {
                        // Check if it's a mount point (has something mounted)
                        execFileSync('mountpoint', ['-q', p], { stdio: ['pipe', 'pipe', 'ignore'] });
                        return true;
                    } catch {
                        return false;
                    }
                });

            // Include the new mount point if not already in list
            if (!diskDirs.includes(mountPoint)) {
                diskDirs.push(mountPoint);
            }

            if (diskDirs.length === 0) {
                throw new Error('No disks available for pool');
            }

            newSources = diskDirs.join(':');
        }

        // Unmount if currently mounted
        if (isMounted) {
            try {
                execFileSync('sudo', ['umount', POOL_MOUNT], { encoding: 'utf8' });
            } catch (e) {
                log.error('Failed to unmount MergerFS:', e.message);
                // Try lazy unmount
                try {
                    execFileSync('sudo', ['umount', '-l', POOL_MOUNT], { encoding: 'utf8' });
                } catch (e2) {
                    throw new Error('Cannot unmount MergerFS pool. Files may be in use.');
                }
            }
        }

        // Create pool mount point if needed
        if (!fs.existsSync(POOL_MOUNT)) {
            execFileSync('sudo', ['mkdir', '-p', POOL_MOUNT], { encoding: 'utf8' });
        }

        // Determine policy
        const hasCache = newSources.includes('cache') || role === 'cache';
        const policy = hasCache ? 'lfs' : 'mfs';

        // Mount MergerFS (nofail is only for fstab, not mount command)
        execFileSync('sudo', ['mergerfs', '-o', `defaults,allow_other,nonempty,use_ino,cache.files=partial,dropcacheonclose=true,category.create=${policy},moveonenospc=true`, newSources, POOL_MOUNT], { encoding: 'utf8' });

        // Update fstab for MergerFS
        updateMergerFSFstab(newSources, policy);

        return true;
    } catch (e) {
        log.error('MergerFS add disk failed:', e);
        throw e;
    }
}

// Update MergerFS persistence (uses systemd mount unit instead of fstab)
function updateMergerFSFstab(sources, policy = 'mfs') {
    try {
        // Now using systemd mount unit for better boot ordering
        updateMergerFSSystemdUnit(sources, policy);
        log.info('Updated MergerFS systemd mount unit');
    } catch (e) {
        log.error('Failed to update MergerFS systemd unit:', e);
        // Don't throw - the mount worked, persistence is just for reboot
    }
}

function updateMergerFSSystemdUnit(sources, policy = 'mfs') {
    try {
        // Update the fstab mergerfs line to persist across reboots
        const fstabPath = '/etc/fstab';
        const fstab = fs.readFileSync(fstabPath, 'utf8');
        const mergerfsLine = `${sources} ${POOL_MOUNT} fuse.mergerfs defaults,allow_other,nonempty,use_ino,cache.files=partial,dropcacheonclose=true,category.create=${policy},moveonenospc=true,nofail 0 0`;

        // Replace existing mergerfs line or append
        const lines = fstab.split('\n');
        const mergerfsIdx = lines.findIndex(l => l.includes('fuse.mergerfs') && l.includes(POOL_MOUNT));

        let newFstab;
        if (mergerfsIdx >= 0) {
            lines[mergerfsIdx] = mergerfsLine;
            newFstab = lines.join('\n');
        } else {
            newFstab = fstab.trimEnd() + '\n# MergerFS Pool\n' + mergerfsLine + '\n';
        }

        const tmpPath = '/tmp/homepinas-fstab-tmp';
        fs.writeFileSync(tmpPath, newFstab, 'utf8');
        execFileSync('sudo', ['cp', tmpPath, fstabPath], { encoding: 'utf8' });
        fs.unlinkSync(tmpPath);
        log.info('Updated fstab mergerfs entry');
    } catch (e) {
        log.error('Failed to update fstab:', e.message);
        throw e;
    }
}

// ════════════════════════════════════════════════════════════════════════════

// Storage config
// NOTE: This endpoint allows initial config without auth (first-time setup),
// but requires auth if storage is already configured

module.exports = router;
