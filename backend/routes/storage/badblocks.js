/**
 * HomePiNAS - Storage: Badblocks
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

const { notifyBadblocksComplete } = require('../../utils/health-monitor');

const { validateSession } = require('../../utils/session');


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

// =============================================================================
// BADBLOCKS - Full surface scan
// =============================================================================

// Track running badblocks processes per device
const badblocksSessions = {};

/**
 * POST /storage/badblocks/:device - Start badblocks surface scan (read-only)
 * This is a LONG operation (hours for large disks). Runs in background.
 */
router.post('/badblocks/:device', requireAuth, async (req, res) => {
    try {
        const device = req.params.device;
        
        if (!/^[a-zA-Z0-9]+$/.test(device)) {
            return res.status(400).json({ error: 'Invalid device name' });
        }
        
        const devicePath = `/dev/${device}`;
        
        // Check if badblocks is already running on this device
        if (badblocksSessions[device] && badblocksSessions[device].running) {
            return res.status(409).json({ 
                error: 'Badblocks already running on this device',
                progress: badblocksSessions[device].progress
            });
        }
        
        // Get disk size for time estimation
        let diskSizeBytes = 0;
        let diskSizeGB = 0;
        try {
            const sizeBytesStr = execFileSync('sudo', ['blockdev', '--getsize64', devicePath], {
                encoding: 'utf8', timeout: 5000
            }).trim();
            diskSizeBytes = parseInt(sizeBytesStr) || 0;
            diskSizeGB = Math.round(diskSizeBytes / 1073741824);
        } catch (e) {}
        
        // Estimated time: ~50 MB/s read speed for HDD = ~5.5h per TB
        const estimatedHours = Math.round((diskSizeGB / 1024) * 5.5);
        
        const session = {
            running: true,
            device: device,
            startTime: Date.now(),
            progress: 0,
            currentBlock: 0,
            totalBlocks: 0,
            badBlocks: [],
            error: null,
            estimatedHours: estimatedHours,
            diskSizeGB: diskSizeGB,
            output: ''
        };
        
        badblocksSessions[device] = session;
        
        // Run badblocks in read-only mode (-v verbose, -s show progress)
        // Block size must keep total block count under 2^32 (badblocks limitation)
        // 4K for disks ≤16TB, 64K for larger disks
        const maxBlocks32bit = 4294967295; // 2^32 - 1
        let blockSize = 4096;
        if (diskSizeBytes / blockSize > maxBlocks32bit) {
            blockSize = 65536; // 64K blocks for large disks
        }
        
        const bbProcess = spawn('sudo', ['/usr/sbin/badblocks', '-v', '-s', '-b', String(blockSize), devicePath], {
            stdio: ['pipe', 'pipe', 'pipe']
        });
        
        session.pid = bbProcess.pid;
        
        // badblocks outputs progress to stderr, bad block numbers to stdout
        bbProcess.stdout.on('data', (data) => {
            // Bad block numbers appear on stdout
            const blocks = data.toString().trim().split('\n').filter(l => l.trim());
            blocks.forEach(b => {
                const blockNum = parseInt(b.trim());
                if (!isNaN(blockNum)) {
                    session.badBlocks.push(blockNum);
                }
            });
        });
        
        bbProcess.stderr.on('data', (data) => {
            const text = data.toString();
            session.output = text; // Keep last chunk
            
            // Parse progress: "Checking for bad blocks (read-only test): 23.45% done, 2:15:30 elapsed. (0/0/0 errors)"
            const progressMatch = text.match(/([\d.]+)%\s*done/);
            if (progressMatch) {
                session.progress = parseFloat(progressMatch[1]);
            }
            
            // Parse errors count
            const errorMatch = text.match(/\((\d+)\/(\d+)\/(\d+)\s*errors?\)/);
            if (errorMatch) {
                session.readErrors = parseInt(errorMatch[1]);
                session.writeErrors = parseInt(errorMatch[2]);
                session.corruptErrors = parseInt(errorMatch[3]);
            }
        });
        
        bbProcess.on('close', (code) => {
            session.running = false;
            session.endTime = Date.now();
            session.exitCode = code;
            session.progress = 100;
            
            if (code === 0) {
                session.result = session.badBlocks.length === 0 ? 'passed' : 'bad_blocks_found';
            } else {
                session.result = 'error';
                session.error = `badblocks exited with code ${code}`;
            }
            
            logSecurityEvent('BADBLOCKS_COMPLETE', { 
                device, 
                duration: session.endTime - session.startTime,
                badBlocks: session.badBlocks.length,
                result: session.result
            }, '');
            
            // Send Telegram notification
            notifyBadblocksComplete(device, session.result, session.badBlocks.length, session.endTime - session.startTime)
                .catch(e => log.error('Badblocks notification error:', e.message));
        });
        
        bbProcess.on('error', (err) => {
            session.running = false;
            session.error = err.message;
            session.result = 'error';
        });
        
        logSecurityEvent('BADBLOCKS_STARTED', { device, estimatedHours }, req.ip);
        
        res.json({
            success: true,
            message: `Badblocks started on ${device}`,
            estimatedHours: estimatedHours,
            diskSizeGB: diskSizeGB
        });
        
    } catch (error) {
        log.error('Badblocks start error:', error);
        res.status(500).json({ error: 'Failed to start badblocks: ' + error.message });
    }
});

/**
 * GET /storage/badblocks/:device/status - Get badblocks progress
 */
router.get('/badblocks/:device/status', requireAuth, async (req, res) => {
    const device = req.params.device;
    
    if (!/^[a-zA-Z0-9]+$/.test(device)) {
        return res.status(400).json({ error: 'Invalid device name' });
    }
    
    const session = badblocksSessions[device];
    if (!session) {
        return res.json({ running: false, hasResult: false });
    }
    
    const elapsed = Date.now() - session.startTime;
    const elapsedHours = (elapsed / 3600000).toFixed(1);
    
    res.json({
        running: session.running,
        progress: Math.round(session.progress * 100) / 100,
        badBlocksFound: session.badBlocks.length,
        readErrors: session.readErrors || 0,
        writeErrors: session.writeErrors || 0,
        corruptErrors: session.corruptErrors || 0,
        elapsedHours: parseFloat(elapsedHours),
        estimatedHours: session.estimatedHours,
        diskSizeGB: session.diskSizeGB,
        result: session.result || null,
        hasResult: !session.running && session.result !== undefined
    });
});

/**
 * DELETE /storage/badblocks/:device - Cancel running badblocks
 */
router.delete('/badblocks/:device', requireAuth, async (req, res) => {
    const device = req.params.device;
    
    if (!/^[a-zA-Z0-9]+$/.test(device)) {
        return res.status(400).json({ error: 'Invalid device name' });
    }
    
    const session = badblocksSessions[device];
    if (!session || !session.running) {
        return res.status(404).json({ error: 'No badblocks running on this device' });
    }
    
    try {
        execFileSync('sudo', ['kill', String(session.pid)], { encoding: 'utf8', timeout: 5000 });
        session.running = false;
        session.result = 'cancelled';
        session.endTime = Date.now();
        res.json({ success: true, message: 'Badblocks cancelled' });
    } catch (e) {
        res.status(500).json({ error: 'Failed to cancel: ' + e.message });
    }
});

// GET /storage/smart/:device/status - Get current test status
router.get('/smart/:device/status', requireAuth, async (req, res) => {
    try {
        const device = req.params.device;
        
        // Validate device name (security)
        if (!/^[a-zA-Z0-9]+$/.test(device)) {
            return res.status(400).json({ error: 'Invalid device name' });
        }
        
        const devicePath = `/dev/${device}`;
        
        const smartOutput = execFileSync('sudo', ['smartctl', '-a', devicePath], { 
            encoding: 'utf8',
            timeout: 10000
        });
        
        // Check if test is in progress
        const progressMatch = smartOutput.match(/Self-test routine in progress\.\.\.\s+(\d+)% of test remaining/);
        const inProgress = !!progressMatch;
        const remainingPercent = progressMatch ? parseInt(progressMatch[1]) : 0;
        
        // Get last test result
        const lastTestMatch = smartOutput.match(/# 1\s+(\S+)\s+(\S+)/);
        const lastTest = lastTestMatch ? {
            type: lastTestMatch[1],
            status: lastTestMatch[2]
        } : null;
        
        res.json({
            success: true,
            device: device,
            testInProgress: inProgress,
            remainingPercent: remainingPercent,
            lastTest: lastTest
        });
        
    } catch (error) {
        log.error('SMART status error:', error);
        res.status(500).json({ error: 'Failed to get SMART status: ' + error.message });
    }
});

// =============================================================================
// DISK HEALTH PANEL - Global health status for all disks
// =============================================================================

/**
 * Helper: Format power-on hours into human-readable string
 */
function formatPowerOnHours(hours) {
    if (hours < 24) return `${hours} horas`;
    const days = Math.floor(hours / 24);
    const remainHours = hours % 24;
    if (days < 30) return `${days} días, ${remainHours} horas`;
    const months = Math.floor(days / 30);
    const remainDays = days % 30;
    if (months < 12) return `${months} meses, ${remainDays} días`;
    const years = Math.floor(months / 12);
    const remainMonths = months % 12;
    return `${years} año${years > 1 ? 's' : ''}, ${remainMonths} mes${remainMonths !== 1 ? 'es' : ''}`;
}

/**
 * Helper: Calculate health status based on SMART data
 */
function calculateHealthStatus(diskData) {
    // CRITICAL conditions
    if (!diskData.health.smartPassed) return 'critical';
    if (diskData.sectors && diskData.sectors.reallocated > 10) return 'critical';
    if (diskData.sectors && diskData.sectors.pending > 0) return 'critical';
    if (diskData.ssdLife && diskData.ssdLife.lifeRemaining < 10) return 'critical';
    
    // WARNING conditions
    if (diskData.sectors && diskData.sectors.reallocated > 0 && diskData.sectors.reallocated <= 10) return 'warning';
    if (diskData.ssdLife && diskData.ssdLife.lifeRemaining >= 10 && diskData.ssdLife.lifeRemaining <= 20) return 'warning';
    if (diskData.temperature && diskData.temperature.current > 50) return 'warning';
    
    return 'ok';
}

/**
 * GET /storage/disks/health - Get comprehensive health status for all disks
 */
router.get('/disks/health', requireAuth, async (req, res) => {
    try {
        // Detect all block devices
        const lsblkJson = execFileSync('lsblk', ['-J', '-d', '-o', 'NAME,TYPE,SIZE,MODEL,ROTA,TRAN'], { 
            encoding: 'utf8', 
            timeout: 10000 
        });
        
        const lsblk = JSON.parse(lsblkJson);
        const devices = (lsblk.blockdevices || []).filter(dev => {
            // Filter out non-disk devices
            if (dev.type !== 'disk') return false;
            if (dev.name.startsWith('loop') || dev.name.startsWith('zram') || dev.name.startsWith('ram')) return false;
            if (dev.name.startsWith('mmcblk')) return false; // Skip SD cards (usually boot)
            // Skip devices with size 0B or null (empty USB adapters, card readers, etc.)
            const sizeStr = String(dev.size || '0');
            if (sizeStr === '0' || sizeStr === '0B') return false;
            return true;
        });

        const disks = [];
        
        for (const device of devices) {
            const diskId = device.name;
            const devicePath = `/dev/${diskId}`;
            
            // Determine disk type
            let diskType = 'hdd';
            if (diskId.startsWith('nvme')) {
                diskType = 'nvme';
            } else if (device.rota === 0) {
                diskType = 'ssd';
            }
            
            // For NVMe, smartctl needs the namespace (nvme0n1, not nvme0)
            const smartPath = diskType === 'nvme' && !diskId.includes('n') ? `${devicePath}n1` : devicePath;
            
            const diskInfo = {
                id: diskId,
                model: device.model || 'Unknown',
                serial: '',
                type: diskType,
                capacity: device.size || 'N/A',
                transport: device.tran || 'unknown',
                health: {
                    status: 'ok',
                    smartPassed: true,
                    smartAvailable: true
                },
                sectors: null,
                ssdLife: null,
                powerOnTime: { hours: 0, formatted: 'N/A' },
                temperature: { current: 0, status: 'ok' },
                lastTest: null,
                testInProgress: false,
                testProgress: 0
            };

            // Get SMART data
            try {
                let smartJson;
                try {
                    smartJson = execFileSync('sudo', ['smartctl', '-j', '-a', smartPath], { 
                        encoding: 'utf8',
                        timeout: 10000,
                        stdio: ['pipe', 'pipe', 'pipe']
                    });
                } catch (execErr) {
                    // smartctl exits non-zero for various reasons but may still output valid JSON
                    smartJson = execErr.stdout ? execErr.stdout.toString() : null;
                    if (!smartJson) throw execErr;
                }
                
                const smart = JSON.parse(smartJson);
                
                // Model from SMART (more reliable than lsblk for some USB adapters)
                if (smart.model_name) {
                    diskInfo.model = smart.model_name;
                }
                
                // Serial number
                diskInfo.serial = smart.serial_number || '';
                
                // Capacity from SMART (more reliable for USB-connected disks)
                if (smart.user_capacity && smart.user_capacity.bytes) {
                    const gb = smart.user_capacity.bytes / 1073741824;
                    diskInfo.capacity = formatSize(Math.round(gb));
                }
                
                // Temperature from top-level field (more reliable than raw attr 194 which can be compound)
                if (smart.temperature && smart.temperature.current) {
                    diskInfo.temperature.current = smart.temperature.current;
                    if (diskInfo.temperature.current > 55) {
                        diskInfo.temperature.status = 'hot';
                    } else if (diskInfo.temperature.current >= 45) {
                        diskInfo.temperature.status = 'warm';
                    }
                }
                
                // SMART health
                if (smart.smart_status && smart.smart_status.passed !== undefined) {
                    diskInfo.health.smartPassed = smart.smart_status.passed;
                }
                
                // Handle NVMe vs SATA/SAS differently
                if (diskType === 'nvme') {
                    const nvmeHealth = smart.nvme_smart_health_information_log;
                    if (nvmeHealth) {
                        // Power-on hours
                        diskInfo.powerOnTime.hours = nvmeHealth.power_on_hours || 0;
                        diskInfo.powerOnTime.formatted = formatPowerOnHours(diskInfo.powerOnTime.hours);
                        
                        // Temperature
                        diskInfo.temperature.current = nvmeHealth.temperature || 0;
                        if (diskInfo.temperature.current > 55) {
                            diskInfo.temperature.status = 'hot';
                        } else if (diskInfo.temperature.current >= 45) {
                            diskInfo.temperature.status = 'warm';
                        }
                        
                        // SSD life for NVMe
                        const dataUnitsWritten = nvmeHealth.data_units_written || 0;
                        const tbw = (dataUnitsWritten * 512000) / 1e12;
                        const percentageUsed = nvmeHealth.percentage_used || 0;
                        const lifeRemaining = Math.max(0, 100 - percentageUsed);
                        
                        diskInfo.ssdLife = {
                            tbw: parseFloat(tbw.toFixed(2)),
                            lifeRemaining: lifeRemaining,
                            lifeRemainingFormatted: `${lifeRemaining}%`
                        };
                    }
                } else {
                    // SATA/SAS HDD or SSD
                    const attrs = smart.ata_smart_attributes;
                    if (attrs && attrs.table) {
                        const getAttribute = (id) => {
                            const attr = attrs.table.find(a => a.id === id);
                            if (!attr) return 0;
                            // Power-on hours (attribute 9) uses normalized value — raw value causes ~82B× overflow on Seagate drives
                            if (id === 9) return attr.value;
                            return attr.raw.value;
                        };
                        
                        // Power-on hours (attribute 9)
                        diskInfo.powerOnTime.hours = getAttribute(9);
                        diskInfo.powerOnTime.formatted = formatPowerOnHours(diskInfo.powerOnTime.hours);
                        
                        // Temperature from attr 194 as fallback (only if not already set from top-level)
                        if (!diskInfo.temperature.current) {
                            const tempRaw = getAttribute(194);
                            // Attr 194 raw can be compound (e.g. 214749347857) — use only lower 16 bits
                            diskInfo.temperature.current = tempRaw > 1000 ? (tempRaw & 0xFFFF) : tempRaw;
                            if (diskInfo.temperature.current > 55) {
                                diskInfo.temperature.status = 'hot';
                            } else if (diskInfo.temperature.current >= 45) {
                                diskInfo.temperature.status = 'warm';
                            }
                        }
                        
                        if (diskType === 'hdd') {
                            // HDD sectors
                            diskInfo.sectors = {
                                reallocated: getAttribute(5),
                                pending: getAttribute(197),
                                uncorrectable: getAttribute(198)
                            };
                        } else {
                            // SSD life
                            const tbwAttr = getAttribute(241); // Total LBAs Written
                            const tbw = (tbwAttr * 512) / 1e12; // Assuming 512-byte sectors
                            const lifeRemaining = getAttribute(231) || getAttribute(233) || 100;
                            
                            diskInfo.ssdLife = {
                                tbw: parseFloat(tbw.toFixed(2)),
                                lifeRemaining: lifeRemaining,
                                lifeRemainingFormatted: `${lifeRemaining}%`
                            };
                        }
                    }
                }
                
                // Last test
                if (smart.ata_smart_data && smart.ata_smart_data.self_test && smart.ata_smart_data.self_test.status) {
                    const testStatus = smart.ata_smart_data.self_test.status;
                    if (testStatus.passed !== undefined) {
                        diskInfo.lastTest = {
                            type: testStatus.string || 'unknown',
                            status: testStatus.passed ? 'completed' : 'failed',
                            timestamp: new Date().toISOString() // smartctl JSON doesn't always have timestamp
                        };
                    }
                    
                    // Test in progress
                    if (testStatus.string && testStatus.string.includes('in progress')) {
                        diskInfo.testInProgress = true;
                        const progressMatch = testStatus.string.match(/(\d+)%/);
                        diskInfo.testProgress = progressMatch ? parseInt(progressMatch[1]) : 0;
                    }
                }
                
            } catch (e) {
                // SMART not available or command failed
                diskInfo.health.smartAvailable = false;
                log.info(`SMART unavailable for ${diskId}:`, e.message);
            }
            
            // Calculate overall health status
            diskInfo.health.status = calculateHealthStatus(diskInfo);
            
            disks.push(diskInfo);
        }
        
        // Calculate summary
        const summary = {
            total: disks.length,
            healthy: disks.filter(d => d.health.status === 'ok').length,
            warning: disks.filter(d => d.health.status === 'warning').length,
            critical: disks.filter(d => d.health.status === 'critical').length
        };
        
        res.json({ disks, summary });
        
    } catch (error) {
        log.error('Disk health error:', error);
        res.status(500).json({ error: 'Failed to get disk health: ' + error.message });
    }
});

// Get I/O statistics for all configured disks
router.get("/disks/iostats", requireAuth, async (req, res) => {
    try {
        const data = getData();
        const configuredDisks = (data.storageConfig || []).map(d => d.id);
        
        if (configuredDisks.length === 0) {
            return res.json({ disks: [] });
        }
        
        // Get iostat data (1 second sample)
        const iostatOutput = execFileSync("iostat", ["-dx", "1", "1", "-o", "JSON"], { 
            encoding: "utf8",
            timeout: 5000
        });
        
        const iostatData = JSON.parse(iostatOutput);
        const diskStats = iostatData.sysstat.hosts[0].statistics[0].disk || [];
        
        const result = [];
        
        for (const diskId of configuredDisks) {
            const stat = diskStats.find(d => d.disk_device === diskId);
            
            if (stat) {
                // Convert kB/s to MB/s
                const readMBs = (stat["rkB/s"] / 1024).toFixed(2);
                const writeMBs = (stat["wkB/s"] / 1024).toFixed(2);
                
                // Get error count from /sys/block if available
                let errorCount = 0;
                try {
                    const ioErrPath = `/sys/block/${diskId}/stat`;
                    if (fs.existsSync(ioErrPath)) {
                        const statContent = fs.readFileSync(ioErrPath, "utf8");
                        // /sys/block/*/stat format: field 10 is I/O errors (0-indexed position 9)
                        const fields = statContent.trim().split(/\s+/);
                        if (fields.length > 9) {
                            errorCount = parseInt(fields[9]) || 0;
                        }
                    }
                } catch (e) {
                    // Ignore error reading /sys
                }
                
                result.push({
                    diskId: diskId,
                    readMBs: parseFloat(readMBs),
                    writeMBs: parseFloat(writeMBs),
                    ioErrors: errorCount,
                    utilization: stat.util || 0
                });
            } else {
                // Disk not found in iostat (might be offline)
                result.push({ diskId: diskId, readMBs: 0, writeMBs: 0, ioErrors: 0, utilization: 0 });
            }
        }
        
        res.json({ disks: result });
    } catch (e) {
        log.error("I/O stats error:", e);
        res.status(500).json({ error: "Failed to get I/O statistics" });
    }
});



// ============================================================================
// CACHE MOVER MANUAL TRIGGER
// ============================================================================
router.post("/cache/mover/trigger", requireAuth, async (req, res) => {
    try {
        // Execute the cache mover script directly
        execFileSync('sudo', ['/usr/local/bin/homepinas-cache-mover.sh'], {
            encoding: 'utf8',
            timeout: 60000  // 1 minute timeout
        });

        res.json({
            success: true,
            message: 'Cache mover ejecutado correctamente'
        });
    } catch (e) {
        log.error('Cache mover trigger error:', e);
        res.status(500).json({
            error: 'Error al ejecutar cache mover',
            details: e.message
        });
    }
});

/**
 * GET /cache/status - Cache disk status and MergerFS policy info
 * FIXED: Bug 1, 2, 3 (inode count, all disks, better regex)
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

        // Get MergerFS policy info - FIX BUG 3: Better regex to capture mergerfs line
        let mergerfsPolicy = {};
        try {
            const mountOutput = execFileSync('mount', [], { encoding: 'utf8', timeout: 5000 });
            // FIX: Use more flexible regex that matches the actual mount format
            const mergerfsLine = mountOutput.split('\n').find(l => 
                l.includes('mergerfs') && (l.includes(POOL_MOUNT) || l.includes('fuse.mergerfs'))
            );
            if (mergerfsLine) {
                // FIX: Extract options from either (opts) format or mount line format
                let opts = null;
                const optsMatch = mergerfsLine.match(/\(([^)]+)\)/);
                if (optsMatch) {
                    opts = optsMatch[1];
                } else {
                    // Alternative: options might be space-separated after type
                    const altMatch = mergerfsLine.match(/type fuse\.mergerfs \((.+?)\)$/);
                    if (altMatch) opts = altMatch[1];
                }

                if (opts) {
                    const createMatch = opts.match(/category\.create=(\w+)/);
                    const moveMatch = opts.match(/moveonenospc=(\w+)/);
                    const minFreeMatch = opts.match(/minfreespace=(\S+?)(?:,|$)/);
                    mergerfsPolicy = {
                        createPolicy: createMatch ? createMatch[1] : 'lfs',  // FIX: default to lfs instead of unknown
                        moveOnNoSpace: moveMatch ? moveMatch[1] === 'true' : false,
                        minFreeSpace: minFreeMatch ? minFreeMatch[1] : null
                    };
                } else {
                    // No options found, use defaults
                    mergerfsPolicy = {
                        createPolicy: 'lfs',
                        moveOnNoSpace: true,
                        minFreeSpace: '20G'
                    };
                }
            }
        } catch (e) {}

        // FIX BUG 1 & 2: Use inode count instead of find -maxdepth 3
        let cacheFileCount = 0;
        let dataFileCount = 0;
        try {
            // Count cache files using inode count (accurate and fast)
            for (const c of cacheInfo) {
                if (!c.error) {
                    try {
                        const dfOutput = execFileSync('df', ['-i', c.mountPoint], {
                            encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'ignore']
                        });
                        const lines = dfOutput.trim().split('\n');
                        if (lines.length >= 2) {
                            const parts = lines[1].split(/\s+/);
                            const inodesUsed = parseInt(parts[2]) || 0;
                            cacheFileCount += inodesUsed;
                        }
                    } catch (e) {}
                }
            }
            
            // FIX: Count ALL data disks, not just 2
            for (let i = 0; i < dataDisks.length; i++) {
                const mountPoint = `${STORAGE_MOUNT_BASE}/disk${i + 1}`;
                try {
                    const dfOutput = execFileSync('df', ['-i', mountPoint], {
                        encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'ignore']
                    });
                    const lines = dfOutput.trim().split('\n');
                    if (lines.length >= 2) {
                        const parts = lines[1].split(/\s+/);
                        const inodesUsed = parseInt(parts[2]) || 0;
                        dataFileCount += inodesUsed;
                    }
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
            try {
                const log = execFileSync('tail', ['-5', '/var/log/homepinas-cache-mover.log'], {
                    encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe']
                }).trim();
                moverStatus.lastLog = log.split('\n').filter(l => l);
            } catch (e) {}
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
                note: 'Accurate (inode count)'  // FIX: Updated note
            }
        });
    } catch (e) {
        log.error('Cache status error:', e);
        res.status(500).json({ error: 'Failed to get cache status' });
    }
});

module.exports = router;
