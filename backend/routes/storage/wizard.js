/**
 * HomePiNAS - Storage: Wizard
 * Split from storage.js for maintainability (max 300 lines rule)
 */

const log = require('../../utils/logger');
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { execFileSync, execFile, spawn } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

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
 * Middleware: allow during initial setup (no storage configured yet) OR with valid auth.
 * Like Synology DSM: the setup wizard doesn't require login since you just created the account.
 */
function requireAuthOrSetup(req, res, next) {
    const data = getData();
    // If no storage is configured yet, allow without auth (initial setup wizard)
    if (!data.storageConfig || data.storageConfig.length === 0) {
        return next();
    }
    // Otherwise require normal auth
    return requireAuth(req, res, next);
}

// Apply storage configuration
router.post('/pool/configure', requireAuthOrSetup, async (req, res) => {
    const { disks } = req.body;

    if (!disks || !Array.isArray(disks) || disks.length === 0) {
        return res.status(400).json({ error: 'No disks provided' });
    }

    // SECURITY: Validate all disk configurations using sanitize module
    const validatedDisks = validateDiskConfig(disks);
    if (!validatedDisks) {
        return res.status(400).json({ error: 'Invalid disk configuration. Check disk IDs and roles.' });
    }

    const dataDisks = validatedDisks.filter(d => d.role === 'data');
    const parityDisks = validatedDisks.filter(d => d.role === 'parity');
    const cacheDisks = validatedDisks.filter(d => d.role === 'cache');

    if (dataDisks.length === 0) {
        return res.status(400).json({ error: 'At least one data disk is required' });
    }

    // Parity is now optional - SnapRAID will only be configured if parity disks are present
    try {
        const results = [];
        // 1. Format disks in parallel
        const disksToFormat = validatedDisks.filter(d => d.format);
        await Promise.all(disksToFormat.map(async (disk) => {
            const safeDiskId = disk.id;
            const filesystem = disk.filesystem || 'ext4';
            results.push(`Formatting /dev/${safeDiskId} as ${filesystem}...`);
            try {
                await execFileAsync('sudo', ['parted', '-s', `/dev/${safeDiskId}`, 'mklabel', 'gpt'], { encoding: 'utf8', timeout: 30000 });
                await execFileAsync('sudo', ['parted', '-s', `/dev/${safeDiskId}`, 'mkpart', 'primary', filesystem, '0%', '100%'], { encoding: 'utf8', timeout: 30000 });
                await execFileAsync('sudo', ['partprobe', `/dev/${safeDiskId}`], { encoding: 'utf8', timeout: 10000 });
                await new Promise(r => setTimeout(r, 2000)); // wait for kernel to register partition

                const partition = safeDiskId.includes('nvme') ? `${safeDiskId}p1` : `${safeDiskId}1`;
                const safePartition = sanitizeDiskId(partition);
                if (!safePartition) throw new Error('Invalid partition derived from disk ID');

                const label = `${disk.role}_${safeDiskId}`.substring(0, 16);
                if (filesystem === 'xfs') {
                    await execFileAsync('sudo', ['mkfs.xfs', '-f', '-L', label, `/dev/${safePartition}`], { encoding: 'utf8', timeout: 300000 });
                } else {
                    await execFileAsync('sudo', ['mkfs.ext4', '-F', '-L', label, `/dev/${safePartition}`], { encoding: 'utf8', timeout: 300000 });
                }
                results.push(`Formatted /dev/${safePartition} as ${filesystem}`);
            } catch (e) {
                results.push(`Warning: Format failed for ${safeDiskId}: ${e.message}`);
            }
        }));

        // 2. Create mount points and mount disks
        let diskNum = 1;
        const dataMounts = [];
        const parityMounts = [];
        const cacheMounts = [];

        for (const disk of dataDisks) {
            // SECURITY: disk.id already validated
            const safeDiskId = disk.id;
            const partition = safeDiskId.includes('nvme') ? `${safeDiskId}p1` : `${safeDiskId}1`;
            const safePartition = sanitizeDiskId(partition);
            if (!safePartition) continue;

            const mountPoint = `${STORAGE_MOUNT_BASE}/disk${diskNum}`;

            // SECURITY: Use execFileSync with explicit arguments
            execFileSync('sudo', ['mkdir', '-p', mountPoint], { encoding: 'utf8', timeout: 10000 });
            try {
                execFileSync('sudo', ['mount', `/dev/${safePartition}`, mountPoint], { encoding: 'utf8', timeout: 30000 });
            } catch (e) {
                // Mount may fail if already mounted, continue
            }
            execFileSync('sudo', ['mkdir', '-p', `${mountPoint}/.snapraid`], { encoding: 'utf8', timeout: 10000 });

            dataMounts.push({ disk: safeDiskId, partition: safePartition, mountPoint, num: diskNum });
            results.push(`Mounted /dev/${safePartition} at ${mountPoint}`);
            diskNum++;
        }

        let parityNum = 1;
        for (const disk of parityDisks) {
            const safeDiskId = disk.id;
            const partition = safeDiskId.includes('nvme') ? `${safeDiskId}p1` : `${safeDiskId}1`;
            const safePartition = sanitizeDiskId(partition);
            if (!safePartition) continue;

            const mountPoint = `/mnt/parity${parityNum}`;

            execFileSync('sudo', ['mkdir', '-p', mountPoint], { encoding: 'utf8', timeout: 10000 });
            try {
                execFileSync('sudo', ['mount', `/dev/${safePartition}`, mountPoint], { encoding: 'utf8', timeout: 30000 });
            } catch (e) {
                // Mount may fail if already mounted
            }

            parityMounts.push({ disk: safeDiskId, partition: safePartition, mountPoint, num: parityNum });
            results.push(`Mounted /dev/${safePartition} at ${mountPoint} (parity)`);
            parityNum++;
        }

        let cacheNum = 1;
        for (const disk of cacheDisks) {
            const safeDiskId = disk.id;
            const partition = safeDiskId.includes('nvme') ? `${safeDiskId}p1` : `${safeDiskId}1`;
            const safePartition = sanitizeDiskId(partition);
            if (!safePartition) continue;

            const mountPoint = `${STORAGE_MOUNT_BASE}/cache${cacheNum}`;

            execFileSync('sudo', ['mkdir', '-p', mountPoint], { encoding: 'utf8', timeout: 10000 });
            try {
                execFileSync('sudo', ['mount', `/dev/${safePartition}`, mountPoint], { encoding: 'utf8', timeout: 30000 });
            } catch (e) {
                // Mount may fail if already mounted
            }

            cacheMounts.push({ disk: safeDiskId, partition: safePartition, mountPoint, num: cacheNum });
            results.push(`Mounted /dev/${safePartition} at ${mountPoint} (cache)`);
            cacheNum++;
        }

        // 3. Generate SnapRAID config (only if parity disks are present)
        if (parityMounts.length > 0) {
            let snapraidConf = `# HomePiNAS SnapRAID Configuration
# Generated: ${new Date().toISOString()}

# Parity files
`;
            parityMounts.forEach((p, i) => {
                if (i === 0) {
                    snapraidConf += `parity ${p.mountPoint}/snapraid.parity\n`;
                } else {
                    snapraidConf += `${i + 1}-parity ${p.mountPoint}/snapraid.parity\n`;
                }
            });

            snapraidConf += `\n# Content files (stored on data disks)\n`;
            dataMounts.forEach(d => {
                snapraidConf += `content ${d.mountPoint}/.snapraid/snapraid.content\n`;
            });

            snapraidConf += `\n# Data disks\n`;
            dataMounts.forEach(d => {
                snapraidConf += `disk d${d.num} ${d.mountPoint}\n`;
            });

            snapraidConf += `\n# Exclude files
exclude *.unrecoverable
exclude /tmp/
exclude /lost+found/
exclude .Thumbs.db
exclude .DS_Store
exclude *.!sync
exclude .AppleDouble
exclude ._AppleDouble
exclude .Spotlight-V100
exclude .TemporaryItems
exclude .Trashes
exclude .fseventsd
`;

            // SECURITY: Write config to temp file first, then use sudo to copy
            const tempConfFile = '/tmp/homepinas-snapraid-temp.conf';
            fs.writeFileSync(tempConfFile, snapraidConf, 'utf8');
            execFileSync('sudo', ['cp', tempConfFile, SNAPRAID_CONF], { encoding: 'utf8', timeout: 10000 });
            fs.unlinkSync(tempConfFile);
            results.push('SnapRAID configuration created');
        } else {
            results.push('SnapRAID skipped (no parity disks configured)');
        }

        // 4. Configure MergerFS
        // Cache disks go FIRST so writes land on fast storage, then data disks
        const poolMounts = [...cacheMounts.map(c => c.mountPoint), ...dataMounts.map(d => d.mountPoint)];
        const mergerfsSource = poolMounts.join(':');
        execFileSync('sudo', ['mkdir', '-p', POOL_MOUNT], { encoding: 'utf8', timeout: 10000 });
        try {
            execFileSync('sudo', ['umount', POOL_MOUNT], { encoding: 'utf8', timeout: 30000 });
        } catch (e) {
            // May not be mounted
        }

        // If cache disks present: use ff (fill first) so writes go to cache SSD first,
        // moveonenospc to overflow to data disks when cache is full
        // ff fills the first listed disk (cache) before moving to next (data HDDs)
        const hasCache = cacheMounts.length > 0;
        const createPolicy = hasCache ? 'ff' : 'mfs';
        const cacheOpts = hasCache ? ',moveonenospc=true,minfreespace=10G' : '';
        const mergerfsOpts = `defaults,allow_other,nonempty,use_ino,cache.files=partial,dropcacheonclose=true,category.create=${createPolicy}${cacheOpts}`;
        execFileSync('sudo', ['mergerfs', '-o', mergerfsOpts, mergerfsSource, POOL_MOUNT], { encoding: 'utf8', timeout: 60000 });
        results.push(`MergerFS pool mounted at ${POOL_MOUNT}`);

        // Set permissions (top-level only, -R is dangerous if mount fails)
        try {
            execFileSync('sudo', ['chown', ':sambashare', POOL_MOUNT], { encoding: 'utf8', timeout: 60000 });
            execFileSync('sudo', ['chmod', '2775', POOL_MOUNT], { encoding: 'utf8', timeout: 60000 });
            results.push('Samba permissions configured');
        } catch (e) {
            results.push('Warning: Could not set Samba permissions');
        }

        // 5. Update /etc/fstab
        // SECURITY: Build fstab entries with proper UUIDs fetched separately
        let fstabEntries = '\n# HomePiNAS Storage Configuration\n';

        // Helper: resolve UUID or fall back to /dev/path
        // Detect actual filesystem type for each partition (respects ext4/xfs choice)
        const addFstabEntry = (partition, mountPoint) => {
            // Detect filesystem type from the formatted partition
            let fsType = 'ext4';
            try {
                const detected = execFileSync('sudo', ['blkid', '-s', 'TYPE', '-o', 'value', `/dev/${partition}`],
                    { encoding: 'utf8', timeout: 10000 }).trim();
                if (detected === 'xfs' || detected === 'ext4') fsType = detected;
            } catch (e) {}

            try {
                const uuid = execFileSync('sudo', ['blkid', '-s', 'UUID', '-o', 'value', `/dev/${partition}`], 
                    { encoding: 'utf8', timeout: 10000 }).trim();
                if (uuid && uuid.length > 8 && !uuid.includes('$') && !uuid.includes('(')) {
                    fstabEntries += `UUID=${uuid} ${mountPoint} ${fsType} defaults,nofail 0 2\n`;
                    return;
                }
            } catch (e) {}
            // Fallback: use device path directly
            fstabEntries += `/dev/${partition} ${mountPoint} ${fsType} defaults,nofail 0 2\n`;
            results.push(`Warning: UUID not found for /dev/${partition}, using device path`);
        };

        for (const d of dataMounts) {
            addFstabEntry(d.partition, d.mountPoint);
        }

        for (const p of parityMounts) {
            addFstabEntry(p.partition, p.mountPoint);
        }

        for (const c of cacheMounts) {
            addFstabEntry(c.partition, c.mountPoint);
        }

        // Add MergerFS entry to fstab for persistence
        // Using fstab with nofail ensures it mounts at boot even if there are timing issues
        fstabEntries += `# MergerFS Pool\n`;
        fstabEntries += `${mergerfsSource} ${POOL_MOUNT} fuse.mergerfs ${mergerfsOpts},nofail 0 0\n`;

        // Remove ALL old HomePiNAS entries from fstab, then append new ones
        // Read fstab, filter out old HomePiNAS lines in JS, write back via temp + sudo cp
        const fstabContent = execFileSync('sudo', ['cat', '/etc/fstab'], { encoding: 'utf8', timeout: 10000 });
        const filteredLines = fstabContent.split('\n').filter(line => {
            if (/# HomePiNAS Storage/.test(line)) return false;
            if (/# MergerFS Pool/.test(line)) return false;
            if (/\/mnt\/disks\//.test(line)) return false;
            if (/\/mnt\/parity/.test(line)) return false;
            if (/\/mnt\/storage.*mergerfs/.test(line)) return false;
            if (/\/mnt\/storage.*fuse\.mergerfs/.test(line)) return false;
            return true;
        });
        // Remove trailing blank lines
        while (filteredLines.length > 0 && filteredLines[filteredLines.length - 1].trim() === '') {
            filteredLines.pop();
        }
        const cleanedFstab = filteredLines.join('\n') + '\n';
        // Write cleaned fstab + new entries via temp file + sudo cp
        const tempFstabFile = '/tmp/homepinas-fstab-temp';
        fs.writeFileSync(tempFstabFile, cleanedFstab + fstabEntries, 'utf8');
        execFileSync('sudo', ['cp', tempFstabFile, '/etc/fstab'], { encoding: 'utf8', timeout: 10000 });
        fs.unlinkSync(tempFstabFile);
        results.push('Updated /etc/fstab for persistence (including MergerFS)');

        results.push('Starting initial SnapRAID sync (this may take a while)...');

        // Save storage config (use validated disks)
        const data = getData();
        data.storageConfig = validatedDisks.map(d => ({ id: d.id, role: d.role }));
        data.poolConfigured = true;
        saveData(data);

        logSecurityEvent('STORAGE_CONFIGURED', { disks: validatedDisks.map(d => d.id), dataCount: dataDisks.length, parityCount: parityDisks.length }, req.ip);

        res.json({
            success: true,
            message: 'Storage pool configured successfully',
            results,
            poolMount: POOL_MOUNT
        });

    } catch (e) {
        log.error('Storage configuration error:', e);
        // Provide clearer error message for common sudo issues
        let userMessage = 'Failed to configure storage';
        if (e.message && e.message.includes('unable to change to root gid')) {
            userMessage = 'Error de permisos: sudo no puede ejecutarse correctamente. Verifica que el servicio HomePiNAS se ejecuta con el usuario correcto y que /etc/sudoers está configurado. Ejecuta: sudo visudo';
        } else if (e.message && e.message.includes('not allowed')) {
            userMessage = 'Error de permisos: el usuario actual no tiene permisos sudo. Ejecuta: sudo usermod -aG sudo homepinas';
        }
        res.status(500).json({ error: userMessage });
    }
});

// Run SnapRAID sync

module.exports = router;
