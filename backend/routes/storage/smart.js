/**
 * HomePiNAS - Storage: Smart
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

// =============================================================================
// SMART MONITORING ENDPOINTS
// =============================================================================

// GET /storage/smart/:device - Get detailed SMART information for a device
router.get('/smart/:device', requireAuth, async (req, res) => {
    try {
        const device = req.params.device;
        
        // Validate device name (security)
        if (!/^[a-zA-Z0-9]+$/.test(device)) {
            return res.status(400).json({ error: 'Invalid device name' });
        }
        
        const devicePath = `/dev/${device}`;
        
        // Get SMART attributes
        const smartData = execFileSync('sudo', ['smartctl', '-A', '-f', 'brief', devicePath], { 
            encoding: 'utf8',
            timeout: 10000
        });
        
        // Get SMART health
        const smartHealth = execFileSync('sudo', ['smartctl', '-H', devicePath], { 
            encoding: 'utf8',
            timeout: 5000
        });
        
        // Get device info
        const smartInfo = execFileSync('sudo', ['smartctl', '-i', devicePath], { 
            encoding: 'utf8',
            timeout: 5000
        });
        
        // Get test log
        const smartTests = execFileSync('sudo', ['smartctl', '-l', 'selftest', devicePath], { 
            encoding: 'utf8',
            timeout: 5000
        });
        
        // Parse health status
        const healthMatch = smartHealth.match(/SMART overall-health self-assessment test result: (.+)/);
        const health = healthMatch ? healthMatch[1].trim() : 'Unknown';
        
        // Parse device info
        const modelMatch = smartInfo.match(/Device Model:\s+(.+)/);
        const serialMatch = smartInfo.match(/Serial Number:\s+(.+)/);
        const firmwareMatch = smartInfo.match(/Firmware Version:\s+(.+)/);
        const capacityMatch = smartInfo.match(/User Capacity:.+\[(.+)\]/);
        
        // Parse attributes
        const attributes = [];
        const attrLines = smartData.split('\n');
        let inAttrSection = false;
        
        for (const line of attrLines) {
            if (line.includes('Vendor Specific SMART Attributes')) {
                inAttrSection = true;
                continue;
            }
            if (!inAttrSection || !line.trim()) continue;
            if (line.startsWith('ID#')) continue; // Skip header
            
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 10) {
                attributes.push({
                    id: parts[0],
                    name: parts[1],
                    flag: parts[2],
                    value: parts[3],
                    worst: parts[4],
                    thresh: parts[5],
                    type: parts[6],
                    updated: parts[7],
                    whenFailed: parts[8],
                    rawValue: parts.slice(9).join(' ')
                });
            }
        }
        
        // Parse test results
        const testResults = [];
        const testLines = smartTests.split('\n');
        let inTestSection = false;
        
        for (const line of testLines) {
            if (line.includes('Num  Test_Description')) {
                inTestSection = true;
                continue;
            }
            if (!inTestSection || !line.trim()) continue;
            
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 9) {
                testResults.push({
                    number: parts[0],
                    description: parts[1],
                    status: parts[2],
                    remaining: parts[3],
                    lifetime: parts[4],
                    lbaOfFirstError: parts[5]
                });
            }
        }
        
        res.json({
            success: true,
            device: device,
            health: health,
            info: {
                model: modelMatch ? modelMatch[1].trim() : 'Unknown',
                serial: serialMatch ? serialMatch[1].trim() : 'Unknown',
                firmware: firmwareMatch ? firmwareMatch[1].trim() : 'Unknown',
                capacity: capacityMatch ? capacityMatch[1].trim() : 'Unknown'
            },
            attributes: attributes,
            tests: testResults.slice(0, 10) // Last 10 tests
        });
        
    } catch (error) {
        log.error('SMART data error:', error);
        res.status(500).json({ error: 'Failed to get SMART data: ' + error.message });
    }
});

// POST /storage/smart/:device/test - Run SMART self-test
router.post('/smart/:device/test', requireAuth, async (req, res) => {
    try {
        const device = req.params.device;
        const testType = req.body.type || 'short';
        
        // Validate device name (security)
        if (!/^[a-zA-Z0-9]+$/.test(device)) {
            return res.status(400).json({ error: 'Invalid device name' });
        }
        
        // Validate test type
        if (!['short', 'long', 'conveyance'].includes(testType)) {
            return res.status(400).json({ error: 'Invalid test type' });
        }
        
        const devicePath = `/dev/${device}`;
        
        // Check if a test is already running
        let currentStatus = '';
        try {
            currentStatus = execFileSync('sudo', ['smartctl', '-a', devicePath], { 
                encoding: 'utf8',
                timeout: 10000
            });
        } catch (e) {
            // smartctl exits non-zero on some disks but still outputs useful text
            currentStatus = e.stdout ? e.stdout.toString() : '';
        }
        
        if (currentStatus.includes('Self-test routine in progress')) {
            return res.status(409).json({ 
                error: 'A self-test is already in progress',
                inProgress: true
            });
        }
        
        // Start the test
        try {
            execFileSync('sudo', ['smartctl', '-t', testType, devicePath], { 
                encoding: 'utf8',
                timeout: 5000
            });
        } catch (e) {
            // smartctl may exit non-zero but still start the test successfully
            const output = e.stdout ? e.stdout.toString() : '';
            if (!output.includes('Testing has begun')) {
                throw e;
            }
        }
        
        logSecurityEvent('SMART_TEST_STARTED', { 
            device, 
            testType,
            user: req.user?.username || 'unknown' 
        });
        
        res.json({
            success: true,
            message: `${testType} self-test started on ${device}`,
            testType: testType,
            device: device
        });
        
    } catch (error) {
        log.error('SMART test error:', error);
        res.status(500).json({ error: 'Failed to start SMART test: ' + error.message });
    }
});


module.exports = router;
