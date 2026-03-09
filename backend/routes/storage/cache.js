/**
 * HomePiNAS - Storage: Cache
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
 * Get all block devices and their status
 * Returns: { configured: [...], unconfigured: [...] }
 */
router.get('/disks/detect', requireAuth, async (req, res) => {
    try {
        // Get all block devices with details
        const lsblkJson = execFileSync('lsblk', ['-Jbo', 'NAME,SIZE,TYPE,MOUNTPOINT,FSTYPE,MODEL,SERIAL,TRAN'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
        
        let devices = [];
        try {
            const parsed = JSON.parse(lsblkJson);
            devices = parsed.blockdevices || [];
        } catch (e) {
            log.error('Failed to parse lsblk:', e);
        }

        const data = getData();
        const configuredDisks = (data.storageConfig || []).map(d => d.id);
        
        // Get currently mounted disks in our pool
        const poolMounts = [];
        try {
            const dirEntries = fs.readdirSync(STORAGE_MOUNT_BASE);
            dirEntries.forEach(m => poolMounts.push(m));
        } catch (e) {}

        const configured = [];
        const unconfigured = [];

        for (const dev of devices) {
            // Skip non-disk devices (loop, rom, etc)
            if (dev.type !== 'disk') continue;
            // Skip virtual/RAM disks
            if (dev.name.startsWith('zram') || dev.name.startsWith('ram') || dev.name.startsWith('loop')) continue;
            // Skip small devices (<1GB, likely USB sticks or boot media)
            if (dev.size < 1000000000) continue;
            // Skip mmcblk (SD card, usually boot)
            if (dev.name.startsWith('mmcblk')) continue;
            // Skip phantom disks (SATA ports without drives)
            try { fs.statSync(`/dev/${dev.name}`); } catch { continue; }
            // Skip ghost SATA devices: phantom ports have numeric model AND size 0 or no partitions
            // Real disks behind USB/SATA bridges (JMB585) can also report "456" but have real size + partitions
            const devModel = (dev.model || '').trim();
            const isPhantom = (!devModel || /^\d+$/.test(devModel)) && dev.size < 1000000000;
            if (isPhantom) continue;

            const diskInfo = {
                id: dev.name,
                path: `/dev/${dev.name}`,
                size: dev.size,
                sizeFormatted: formatSize(Math.round(dev.size / 1073741824)), // bytes to GB
                model: dev.model || 'Unknown',
                serial: dev.serial || '',
                transport: dev.tran || 'unknown',
                partitions: []
            };

            // Check partitions
            if (dev.children && dev.children.length > 0) {
                for (const part of dev.children) {
                    diskInfo.partitions.push({
                        name: part.name,
                        path: `/dev/${part.name}`,
                        size: part.size,
                        sizeFormatted: formatSize(Math.round(part.size / 1073741824)),
                        fstype: part.fstype || null,
                        mountpoint: part.mountpoint || null
                    });
                }
            }

            // Determine if configured or unconfigured
            const isConfigured = configuredDisks.includes(dev.name) || 
                                 diskInfo.partitions.some(p => p.mountpoint && p.mountpoint.startsWith(STORAGE_MOUNT_BASE));
            
            if (isConfigured) {
                // Find role from config
                const configEntry = (data.storageConfig || []).find(d => d.id === dev.name);
                diskInfo.role = configEntry ? configEntry.role : 'data';
                diskInfo.inPool = true;
                configured.push(diskInfo);
            } else {
                diskInfo.inPool = false;
                // Check if it has a filesystem
                diskInfo.hasData = diskInfo.partitions.some(p => p.fstype);
                diskInfo.formatted = diskInfo.partitions.some(p => ['ext4', 'xfs', 'btrfs', 'ntfs'].includes(p.fstype));
                unconfigured.push(diskInfo);
            }
        }

        res.json({ configured, unconfigured });
    } catch (e) {
        log.error('Disk detection error:', e);
        res.status(500).json({ error: 'Failed to detect disks' });
    }
});

/**
 * GET /cache/status - Cache disk status and MergerFS policy info
 */
router.get('/cache/status', requireAuth, async (req, res) => {
    try {
        const data = getData();
        const storageConfig = data.storageConfig || [];
        const cacheDisks = storageConfig.filter(d => d.role === 'cache');
        const dataDisks = storageConfig.filter(d => d.role === 'data');

        if (cacheDisks.length === 0) {
            return res.json({
                hasCache: false,
                message: 'No cache disks configured'
            });
        }

        // Get cache disk usage
        const cacheInfo = [];
        for (let i = 0; i < cacheDisks.length; i++) {
            const mountPoint = `${STORAGE_MOUNT_BASE}/cache${i + 1}`;
            try {
                const dfOutput = execFileSync('df', ['-B1', mountPoint], {
                    encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'ignore']
                });
                const lines = dfOutput.trim().split('\n');
                if (lines.length >= 2) {
                    const parts = lines[1].split(/\s+/);
                    const total = parseInt(parts[1]) || 0;
                    const used = parseInt(parts[2]) || 0;
                    const available = parseInt(parts[3]) || 0;
                    const usagePercent = parseInt(parts[4]) || 0;

                    cacheInfo.push({
                        disk: cacheDisks[i].id,
                        mountPoint,
                        total,
                        used,
                        available,
                        usagePercent,
                        totalFormatted: formatBytes(total),
                        usedFormatted: formatBytes(used),
                        availableFormatted: formatBytes(available)
                    });
                }
            } catch (e) {
                cacheInfo.push({ disk: cacheDisks[i].id, mountPoint, error: 'Not mounted' });
            }
        }

        // Get MergerFS policy info
        let mergerfsPolicy = {};
        try {
            const mountOutput = execFileSync('mount', [], { encoding: 'utf8', timeout: 5000 });
            const mergerfsLine = mountOutput.split('\n').find(l => l.includes('mergerfs') && l.includes(POOL_MOUNT));
            if (mergerfsLine) {
                const optsMatch = mergerfsLine.match(/\(([^)]+)\)/);
                if (optsMatch) {
                    const opts = optsMatch[1];
                    const createMatch = opts.match(/category\.create=(\w+)/);
                    const moveMatch = opts.match(/moveonenospc=(\w+)/);
                    const minFreeMatch = opts.match(/minfreespace=(\S+?)(?:,|$)/);
                    mergerfsPolicy = {
                        createPolicy: createMatch ? createMatch[1] : 'unknown',
                        moveOnNoSpace: moveMatch ? moveMatch[1] === 'true' : false,
                        minFreeSpace: minFreeMatch ? minFreeMatch[1] : null
                    };
                }
            }
        } catch (e) {}

        // Count files on cache vs data (quick sample using find, limited)
        let cacheFileCount = 0;
        let dataFileCount = 0;
        try {
            for (const c of cacheInfo) {
                if (!c.error) {
                    const count = execFileSync('find', [c.mountPoint, '-type', 'f', '-maxdepth', '3'], {
                        encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'ignore']
                    }).trim().split('\n').filter(l => l).length;
                    cacheFileCount += count;
                }
            }
            // Count data disk files (sample)
            for (let i = 0; i < Math.min(dataDisks.length, 2); i++) {
                const mountPoint = `${STORAGE_MOUNT_BASE}/disk${i + 1}`;
                try {
                    const count = execFileSync('find', [mountPoint, '-type', 'f', '-maxdepth', '3'], {
                        encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'ignore']
                    }).trim().split('\n').filter(l => l).length;
                    dataFileCount += count;
                } catch (e) {}
            }
        } catch (e) {}

        // Cache mover status
        let moverStatus = { enabled: false };
        try {
            const timerState = execFileSync('systemctl', ['is-active', 'homepinas-cache-mover.timer'], {
                encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
            }).trim();
            moverStatus.enabled = timerState === 'active';
            // Read last log entries
            try {
                const log = execFileSync('tail', ['-5', '/var/log/homepinas-cache-mover.log'], {
                    encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe']
                }).trim();
                moverStatus.lastLog = log.split('\n').filter(l => l);
            } catch (e) {}
            // Read config
            try {
                const conf = fs.readFileSync('/usr/local/bin/homepinas-cache-mover.conf', 'utf8');
                const ageMatch = conf.match(/CACHE_AGE_MINUTES=(\d+)/);
                const threshMatch = conf.match(/CACHE_USAGE_THRESHOLD=(\d+)/);
                moverStatus.ageMinutes = ageMatch ? parseInt(ageMatch[1]) : 120;
                moverStatus.usageThreshold = threshMatch ? parseInt(threshMatch[1]) : 80;
            } catch (e) {}
        } catch (e) {
            moverStatus.enabled = false;
        }

        res.json({
            hasCache: true,
            cacheDisks: cacheInfo,
            dataDisksCount: dataDisks.length,
            policy: mergerfsPolicy,
            mover: moverStatus,
            fileCounts: {
                cache: cacheFileCount,
                data: dataFileCount,
                note: 'Approximate (sampled to depth 3)'
            }
        });
    } catch (e) {
        log.error('Cache status error:', e);
        res.status(500).json({ error: 'Failed to get cache status' });
    }
});


module.exports = router;
