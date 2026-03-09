/**
 * HomePiNAS - Storage: Snapraid
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

router.post('/snapraid/sync', requireAuth, async (req, res) => {
    // SECURITY: Check for stale running state (timeout after 6 hours)
    const MAX_SYNC_TIME = 6 * 60 * 60 * 1000; // 6 hours
    if (snapraidSyncStatus.running) {
        const elapsed = Date.now() - snapraidSyncStatus.startTime;
        if (elapsed > MAX_SYNC_TIME) {
            // Force reset stale state
            logSecurityEvent('SNAPRAID_SYNC_TIMEOUT_RESET', { elapsed }, '');
            snapraidSyncStatus.running = false;
        } else {
            return res.status(409).json({ error: 'Sync already in progress', progress: snapraidSyncStatus.progress });
        }
    }

    snapraidSyncStatus = {
        running: true,
        progress: 0,
        status: 'Starting sync...',
        startTime: Date.now(),
        error: null
    };

    // SECURITY: Use spawn without shell option
    const syncProcess = spawn('sudo', ['snapraid', 'sync', '-v'], {
        stdio: ['pipe', 'pipe', 'pipe']
    });

    let output = '';

    const parseOutput = (data) => {
        const text = data.toString();
        output += text;

        const lines = text.split('\n');
        for (const line of lines) {
            const progressMatch = line.match(/(\d+)%/);
            if (progressMatch) {
                snapraidSyncStatus.progress = parseInt(progressMatch[1]);
            }

            if (line.includes('completed') || line.includes('Nothing to do')) {
                snapraidSyncStatus.progress = 100;
                snapraidSyncStatus.status = 'Sync completed';
            }

            const fileMatch = line.match(/(\d+)\s+(files?|blocks?)/i);
            if (fileMatch) {
                snapraidSyncStatus.status = `Processing ${fileMatch[1]} ${fileMatch[2]}...`;
            }

            if (line.includes('Syncing')) {
                snapraidSyncStatus.status = line.trim().substring(0, 50);
            }

            if (line.includes('Self test') || line.includes('Verifying')) {
                snapraidSyncStatus.status = line.trim().substring(0, 50);
            }
        }
    };

    syncProcess.stdout.on('data', parseOutput);
    syncProcess.stderr.on('data', parseOutput);

    const progressSimulator = setInterval(() => {
        const elapsed = Date.now() - snapraidSyncStatus.startTime;

        if (snapraidSyncStatus.running && snapraidSyncStatus.progress === 0 && elapsed > 2000) {
            const simulatedProgress = Math.min(90, Math.floor((elapsed - 2000) / 100));
            if (simulatedProgress > snapraidSyncStatus.progress) {
                snapraidSyncStatus.progress = simulatedProgress;
                snapraidSyncStatus.status = 'Initializing parity data...';
            }
        }
    }, 500);

    syncProcess.on('close', (code) => {
        clearInterval(progressSimulator);

        if (code === 0) {
            snapraidSyncStatus.progress = 100;
            snapraidSyncStatus.status = 'Sync completed successfully';
            snapraidSyncStatus.error = null;
        } else {
            if (output.includes('Nothing to do')) {
                snapraidSyncStatus.progress = 100;
                snapraidSyncStatus.status = 'Already in sync (nothing to do)';
                snapraidSyncStatus.error = null;
            } else {
                snapraidSyncStatus.error = `Sync exited with code ${code}`;
                snapraidSyncStatus.status = 'Sync failed';
            }
        }
        snapraidSyncStatus.running = false;
        logSecurityEvent('SNAPRAID_SYNC_COMPLETE', { code, duration: Date.now() - snapraidSyncStatus.startTime }, '');
    });

    syncProcess.on('error', (err) => {
        clearInterval(progressSimulator);
        snapraidSyncStatus.error = err.message;
        snapraidSyncStatus.status = 'Sync failed to start';
        snapraidSyncStatus.running = false;
    });

    res.json({ success: true, message: 'SnapRAID sync started in background' });
});

// Get SnapRAID sync progress
router.get('/snapraid/sync/progress', requireAuth, (req, res) => {
    res.json(snapraidSyncStatus);
});

// Run SnapRAID scrub
router.post('/snapraid/scrub', requireAuth, async (req, res) => {
    try {
        execFileSync('sudo', ['snapraid', 'scrub', '-p', '10'], { encoding: 'utf8', timeout: 7200000 });
        logSecurityEvent('SNAPRAID_SCRUB', {}, req.ip);
        res.json({ success: true, message: 'SnapRAID scrub completed' });
    } catch (e) {
        log.error('SnapRAID scrub error:', e);
        res.status(500).json({ error: `SnapRAID scrub failed: ${e.message}` });
    }
});

// Get SnapRAID status
router.get('/snapraid/status', requireAuth, async (req, res) => {
    try {
        const status = execFileSync('sudo', ['snapraid', 'status'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
        res.json({ status });
    } catch (e) {
        res.json({ status: 'Not configured or error' });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// HYBRID DISK DETECTION - Detect new disks and let user decide what to do
// ════════════════════════════════════════════════════════════════════════════


module.exports = router;
