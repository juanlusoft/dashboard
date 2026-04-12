/**
 * HomePiNAS - Update Routes
 * v1.5.7 - OTA Updates
 *
 * System update from GitHub repository
 */

const log = require('../utils/logger');
const express = require('express');
const router = express.Router();
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const { requireAuth } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/rbac');
const { criticalLimiter } = require('../middleware/rateLimit');
const { logSecurityEvent } = require('../utils/security');

const INSTALL_DIR = '/opt/homepinas';
const REPO_URL = 'https://github.com/juanlusoft/dashboard.git';
const EXPECTED_REMOTE = 'github.com/juanlusoft/dashboard'; // SECURITY: Expected repo pattern

let updateInProgress = false;

// Check for updates
router.get('/check', requireAuth, async (req, res) => {
    try {
        // Get current local version (use readFileSync to avoid Node require cache)
        const packageJson = JSON.parse(fs.readFileSync(path.join(INSTALL_DIR, 'package.json'), 'utf8'));
        const currentVersion = packageJson.version;

        // Fetch latest version from GitHub
        let latestVersion = currentVersion;
        let updateAvailable = false;
        let changelog = '';
        let localChanges = false;
        let localChangesFiles = [];

        try {
            // Check for local modifications FIRST
            try {
                const statusOutput = execFileSync('sudo', ['git', 'status', '--porcelain'], {
                    cwd: INSTALL_DIR,
                    encoding: 'utf8',
                    timeout: 10000
                }).trim();
                
                if (statusOutput) {
                    localChanges = true;
                    localChangesFiles = statusOutput.split('\n').slice(0, 5).map(l => l.trim());
                }
            } catch (e) {
                log.error('Git status check failed:', e.message);
            }

            // Ensure git safe directory is set (sudo changes HOME)
            try {
                execFileSync('sudo', ['git', 'config', '--global', '--add', 'safe.directory', INSTALL_DIR], {
                    encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
                });
            } catch (e) {}

            // SECURITY: Use execFileSync with explicit arguments
            execFileSync('sudo', ['git', 'fetch', 'origin', '--quiet'], {
                cwd: INSTALL_DIR,
                encoding: 'utf8',
                timeout: 30000
            });

            // Detect current branch
            let currentBranch = 'main';
            try {
                currentBranch = execFileSync('sudo', ['git', 'branch', '--show-current'], {
                    cwd: INSTALL_DIR, encoding: 'utf8', timeout: 5000
                }).trim() || 'main';
            } catch (e) {}

            // Get commits ahead of current HEAD on the SAME branch
            const remoteInfo = execFileSync('sudo', ['git', 'log', `HEAD..origin/${currentBranch}`, '--oneline'], {
                cwd: INSTALL_DIR,
                encoding: 'utf8',
                timeout: 10000
            }).trim();

            // Limit to first 5 lines
            const remoteLines = remoteInfo.split('\n').slice(0, 5).join('\n');

            if (remoteInfo) {
                updateAvailable = true;
                changelog = remoteLines;

                // Try to get latest version from remote package.json
                try {
                    const remotePackage = execFileSync('sudo', ['git', 'show', `origin/${currentBranch}:package.json`], {
                        cwd: INSTALL_DIR,
                        encoding: 'utf8',
                        timeout: 10000
                    });
                    const remotePkg = JSON.parse(remotePackage);
                    latestVersion = remotePkg.version;
                } catch (e) {
                    // Can't get remote version, that's ok
                }
            }
        } catch (e) {
            // Git fetch failed, maybe no internet or permissions
            log.error('Update check failed:', e.message);
            changelog = `Error checking updates: ${e.message}`;
        }

        res.json({
            currentVersion,
            latestVersion,
            updateAvailable,
            changelog,
            localChanges,
            localChangesFiles,
            installDir: INSTALL_DIR
        });
    } catch (e) {
        log.error('Update check error:', e);
        res.status(500).json({ error: 'Failed to check for updates' });
    }
});

// Perform update
router.post('/apply', requireAuth, requireAdmin, criticalLimiter, async (req, res) => {
    if (updateInProgress) {
        return res.status(409).json({ error: 'Ya hay una actualización en progreso' });
    }
    updateInProgress = true;

    logSecurityEvent('UPDATE_STARTED', { user: req.user.username }, req.ip);

    // SECURITY: Verify we're updating from the expected repository
    try {
        const remoteUrl = execFileSync('sudo', ['git', 'remote', 'get-url', 'origin'], {
            cwd: INSTALL_DIR,
            encoding: 'utf8',
            timeout: 5000
        }).trim();

        if (!remoteUrl.includes(EXPECTED_REMOTE)) {
            logSecurityEvent('UPDATE_REJECTED_WRONG_REPO', { remoteUrl, user: req.user.username }, req.ip);
            return res.status(400).json({
                success: false,
                error: 'Update rejected: Repository does not match expected source'
            });
        }
    } catch (e) {
        logSecurityEvent('UPDATE_REJECTED_VERIFY_FAILED', { error: e.message, user: req.user.username }, req.ip);
        return res.status(500).json({
            success: false,
            error: 'Failed to verify update source'
        });
    }

    // Send response immediately, update will happen in background
    res.json({
        success: true,
        message: 'Update started. The service will restart automatically. Please wait 30 seconds and refresh the page.'
    });

    // Perform update in background after response is sent
    setTimeout(async () => {
        try {
            log.info('[UPDATE] Starting system update...');

            // 1. Pull latest changes - using execFileSync where possible
            log.info('[UPDATE] Pulling latest changes from GitHub...');
            execFileSync('sudo', ['git', 'fetch', 'origin'], {
                cwd: INSTALL_DIR,
                encoding: 'utf8',
                timeout: 60000
            });
            // Detect current branch for update
            let updateBranch = 'main';
            try {
                updateBranch = execFileSync('sudo', ['git', 'branch', '--show-current'], {
                    cwd: INSTALL_DIR, encoding: 'utf8', timeout: 5000
                }).trim() || 'main';
            } catch (e) {}
            execFileSync('sudo', ['git', 'reset', '--hard', `origin/${updateBranch}`], {
                cwd: INSTALL_DIR,
                encoding: 'utf8',
                timeout: 30000
            });

            // 2. Install/update dependencies
            log.info('[UPDATE] Installing dependencies...');
            execFileSync('sudo', ['npm', 'install', '--production'], {
                cwd: INSTALL_DIR,
                encoding: 'utf8',
                timeout: 120000
            });

            // 3. Restart service
            log.info('[UPDATE] Restarting HomePiNAS service...');
            const { execFile } = require('child_process');
            execFile('sudo', ['systemctl', 'restart', 'homepinas'], (error) => {
                if (error) {
                    log.error('[UPDATE] Restart failed:', error.message);
                } else {
                    log.info('[UPDATE] Service restarted successfully');
                }
            });

            logSecurityEvent('UPDATE_COMPLETED', {}, '');
            updateInProgress = false;

        } catch (e) {
            log.error('[UPDATE] Update failed:', e.message);
            logSecurityEvent('UPDATE_FAILED', { error: e.message }, '');
            updateInProgress = false;
        }
    }, 500);
});

// Get update log/status
router.get('/status', requireAuth, (req, res) => {
    try {
        // SECURITY: Use execFileSync with explicit arguments
        let log = 'No git history';
        let currentBranch = 'unknown';
        let lastCommit = 'unknown';

        try {
            log = execFileSync('sudo', ['git', 'log', '--oneline', '-10'], {
                cwd: INSTALL_DIR,
                encoding: 'utf8',
                timeout: 10000
            }).trim();
        } catch (e) {
            // Git log failed
        }

        try {
            currentBranch = execFileSync('sudo', ['git', 'branch', '--show-current'], {
                cwd: INSTALL_DIR,
                encoding: 'utf8',
                timeout: 5000
            }).trim();
        } catch (e) {
            // Branch check failed
        }

        try {
            lastCommit = execFileSync('sudo', ['git', 'log', '-1', '--format=%h %s (%cr)'], {
                cwd: INSTALL_DIR,
                encoding: 'utf8',
                timeout: 5000
            }).trim();
        } catch (e) {
            // Last commit check failed
        }

        res.json({
            branch: currentBranch,
            lastCommit,
            recentChanges: log.split('\n')
        });
    } catch (e) {
        res.status(500).json({ error: 'Failed to get update status' });
    }
});

// =============================================================================
// OS (Debian/Ubuntu) Updates
// =============================================================================

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

// Check for OS updates (apt)
router.get('/check-os', requireAuth, async (req, res) => {
    try {
        // Update package lists
        await execFileAsync('sudo', ['apt-get', 'update', '-qq'], {
            timeout: 60000
        });

        // Get list of upgradable packages
        const { stdout } = await execFileAsync('apt', ['list', '--upgradable'], {
            timeout: 15000,
            encoding: 'utf8'
        });

        const lines = stdout.trim().split('\n').filter(l => l && !l.startsWith('Listing'));
        const packages = lines.map(line => {
            const match = line.match(/^([^/]+)\/.+\s+(\S+)\s+\S+\s+\[upgradable from: (\S+)\]/);
            if (match) return { name: match[1], newVersion: match[2], currentVersion: match[3] };
            return { name: line.split('/')[0], newVersion: '', currentVersion: '' };
        });

        // Count security updates
        let securityCount = 0;
        for (const line of lines) {
            if (line.includes('-security')) securityCount++;
        }

        res.json({
            success: true,
            updatesAvailable: packages.length,
            securityUpdates: securityCount,
            packages: packages.slice(0, 50)
        });
    } catch (e) {
        log.error('OS update check error:', e.message);
        res.status(500).json({ success: false, error: 'Failed to check OS updates: ' + e.message });
    }
});

// Apply OS updates (apt upgrade)
router.post('/apply-os', requireAuth, requireAdmin, criticalLimiter, async (req, res) => {
    if (updateInProgress) {
        return res.status(409).json({ error: 'Ya hay una actualización en progreso' });
    }
    updateInProgress = true;

    logSecurityEvent('OS_UPDATE_STARTED', { user: req.user.username }, req.ip);

    // Send response immediately
    res.json({
        success: true,
        message: 'OS update started. This may take several minutes.'
    });

    // Run upgrade in background
    setTimeout(async () => {
        try {
            log.info('[OS-UPDATE] Starting apt upgrade...');
            await execFileAsync('sudo', ['apt-get', 'upgrade', '-y', '-qq'], {
                timeout: 600000,  // 10 min timeout
                encoding: 'utf8'
            });
            log.info('[OS-UPDATE] Upgrade completed successfully');
            logSecurityEvent('OS_UPDATE_COMPLETED', {}, '');
            updateInProgress = false;
        } catch (e) {
            log.error('[OS-UPDATE] Upgrade failed:', e.message);
            logSecurityEvent('OS_UPDATE_FAILED', { error: e.message }, '');
            updateInProgress = false;
        }
    }, 500);
});

module.exports = router;
