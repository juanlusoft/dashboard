/**
 * HomePiNAS - Storage: Pool
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

router.get('/pool/status', requireAuth, async (req, res) => {
    try {
        const status = {
            // MergerFS status
            mergerfs: {
                running: false,
                mountPoint: POOL_MOUNT,
                sources: [],
                systemdUnit: 'unknown'
            },
            // SnapRAID status
            snapraid: {
                configured: false,
                dataDisks: 0,
                parityDisks: 0,
                lastSync: null,
                syncStatus: 'unknown'
            },
            // Pool capacity
            capacity: {
                total: '0 GB',
                used: '0 GB',
                free: '0 GB',
                usedPercent: 0
            },
            // Individual disks in pool
            disks: [],
            // Overall health
            health: 'unknown',
            warnings: []
        };

        // ══════════════════════════════════════════════════════════════════
        // 1. Check MergerFS status
        // ══════════════════════════════════════════════════════════════════
        try {
            const mountsRaw = execFileSync('mount', [], { encoding: 'utf8' });
            const mounts = mountsRaw.split('\n').filter(l => l.includes('mergerfs')).join('\n');
            if (mounts.includes('mergerfs')) {
                status.mergerfs.running = true;
                
                // Extract source paths from mount output
                const match = mounts.match(/^(.+?) on \/mnt\/storage type fuse\.mergerfs/);
                if (match) {
                    status.mergerfs.sources = match[1].split(':').filter(s => s);
                }
                
                // Get pool capacity via statfs (statvfs) for accurate calculation
                // df's "Available" column deducts reserved space per-disk, which
                // compounds across a MergerFS pool and causes BUG-04.
                const statfs = fs.statfsSync(POOL_MOUNT);
                const blockSize = statfs.bsize;
                const totalBytes = statfs.blocks * blockSize;
                const freeBytes = statfs.bfree * blockSize;  // total free (incl. reserved)
                const usedBytes = totalBytes - freeBytes;

                const totalGB = totalBytes / (1024 ** 3);
                const usedGB = usedBytes / (1024 ** 3);
                const freeGB = freeBytes / (1024 ** 3);
                const usedPercent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;

                status.capacity.total = formatSize(totalGB);
                status.capacity.used = formatSize(usedGB);
                status.capacity.free = formatSize(freeGB);
                status.capacity.usedPercent = usedPercent;
                
                // Warn if pool is getting full
                if (usedPercent > 90) {
                    status.warnings.push('Pool is over 90% full');
                } else if (usedPercent > 80) {
                    status.warnings.push('Pool is over 80% full');
                }
            }
        } catch (e) {
            log.info('MergerFS status check failed:', e.message);
        }

        // Check systemd mount unit status
        try {
            const unitStatus = execFileSync('systemctl', ['is-active', 'mnt-storage.mount'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
            status.mergerfs.systemdUnit = unitStatus || 'inactive';
        } catch (e) {
            // systemctl exits non-zero for inactive/not-found; extract stdout if available
            const stdout = e.stdout ? e.stdout.toString().trim() : '';
            status.mergerfs.systemdUnit = stdout || 'not-found';
        }

        // ══════════════════════════════════════════════════════════════════
        // 2. Check SnapRAID status
        // ══════════════════════════════════════════════════════════════════
        try {
            const snapraidConf = fs.readFileSync(SNAPRAID_CONF, 'utf8');
            if (snapraidConf.includes('content') && snapraidConf.includes('disk')) {
                status.snapraid.configured = true;
                
                // Count data and parity disks from config
                const dataMatches = snapraidConf.match(/^disk\s+/gm);
                const parityMatches = snapraidConf.match(/^(\d+-)?parity\s+/gm);
                status.snapraid.dataDisks = dataMatches ? dataMatches.length : 0;
                status.snapraid.parityDisks = parityMatches ? parityMatches.length : 0;
            }
        } catch (e) {}

        // Get last sync time
        try {
            const logRaw = fs.readFileSync('/var/log/snapraid-sync.log', 'utf8');
            const logContent = logRaw.split('\n').slice(-50).join('\n');
            const syncMatch = logContent.match(/=== SnapRAID Sync Finished: (.+?) ===/);
            if (syncMatch) {
                status.snapraid.lastSync = syncMatch[1].trim();
            }
            
            // Check sync status
            if (logContent.includes('Sync completed successfully')) {
                status.snapraid.syncStatus = 'ok';
            } else if (logContent.includes('ERROR')) {
                status.snapraid.syncStatus = 'error';
                status.warnings.push('Last SnapRAID sync had errors');
            }
        } catch (e) {}

        // ══════════════════════════════════════════════════════════════════
        // 3. Get individual disk status
        // ══════════════════════════════════════════════════════════════════
        
        // Get disk serials and models from lsblk
        let diskDetails = {};
        try {
            const lsblkJson = execFileSync('lsblk', ['-Jbo', 'NAME,MODEL,SERIAL'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
            const parsed = JSON.parse(lsblkJson);
            for (const dev of (parsed.blockdevices || [])) {
                diskDetails[dev.name] = { model: dev.model || '', serial: dev.serial || '' };
            }
        } catch (e) {}
        
        const data = getData();
        const configuredDisks = data.storageConfig || [];
        
        for (const diskConf of configuredDisks) {
            const details = diskDetails[diskConf.id] || {};
            const diskInfo = {
                id: diskConf.id,
                role: diskConf.role,
                mountPoint: diskConf.mountPoint || 'unknown',
                mounted: false,
                size: '0 GB',
                used: '0 GB',
                free: '0 GB',
                health: 'unknown',
                model: details.model || 'Unknown',
                serial: details.serial || ''
            };
            
            // Check if mounted
            if (diskConf.mountPoint) {
                try {
                    try {
                        execFileSync('mountpoint', ['-q', diskConf.mountPoint], { stdio: ['pipe', 'pipe', 'ignore'] });
                        diskInfo.mounted = true;
                    } catch { diskInfo.mounted = false; }

                    if (diskInfo.mounted) {
                        // Get disk capacity
                        const dfRaw2 = execFileSync('df', ['-BG', diskConf.mountPoint], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
                        const dfLines2 = dfRaw2.trim().split('\n');
                        const df = dfLines2[dfLines2.length - 1];
                        const parts = df.trim().split(/\s+/);
                        if (parts.length >= 4) {
                            diskInfo.size = formatSize(parseInt(parts[1]) || 0);
                            diskInfo.used = formatSize(parseInt(parts[2]) || 0);
                            diskInfo.free = formatSize(parseInt(parts[3]) || 0);
                        }
                    } else {
                        status.warnings.push(`Disk ${diskConf.id} is not mounted`);
                    }
                } catch (e) {}
            }
            
            // Get SMART health (quick check)
            try {
                const smartRaw = execFileSync('sudo', ['smartctl', '-H', `/dev/${diskConf.id}`], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
                const smartResult = smartRaw.split('\n').filter(l => /SMART overall-health/i.test(l)).join('\n');
                if (smartResult.toLowerCase().includes('passed')) {
                    diskInfo.health = 'healthy';
                } else if (smartResult.toLowerCase().includes('failed')) {
                    diskInfo.health = 'failing';
                    status.warnings.push(`Disk ${diskConf.id} SMART status: FAILING`);
                }
            } catch (e) {}
            
            status.disks.push(diskInfo);
        }

        // ══════════════════════════════════════════════════════════════════
        // 4. Determine overall health
        // ══════════════════════════════════════════════════════════════════
        if (status.warnings.length === 0 && status.mergerfs.running) {
            status.health = 'healthy';
        } else if (status.warnings.some(w => w.includes('FAILING') || w.includes('not mounted'))) {
            status.health = 'degraded';
        } else if (!status.mergerfs.running && configuredDisks.length > 0) {
            status.health = 'offline';
        } else if (status.warnings.length > 0) {
            status.health = 'warning';
        } else {
            status.health = 'unconfigured';
        }

        // Legacy fields for backward compatibility
        res.json({
            ...status,
            // Legacy fields
            configured: status.snapraid.configured || configuredDisks.length > 0,
            running: status.mergerfs.running,
            poolMount: POOL_MOUNT,
            poolSize: status.capacity.total,
            poolUsed: status.capacity.used,
            poolFree: status.capacity.free,
            lastSync: status.snapraid.lastSync
        });
    } catch (e) {
        log.error('Pool status error:', e);
        res.status(500).json({ error: 'Failed to get pool status' });
    }
});


module.exports = router;
