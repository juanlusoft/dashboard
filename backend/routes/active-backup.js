/**
 * HomePiNAS v2 - Active Backup for Business (ABB)
 * Route handlers for backup device management, backup operations, and recovery
 *
 * Architecture:
 * - Routes layer: HTTP request/response handling only
 * - Controllers: HTTP-specific logic (parameter parsing, validation, responses)
 * - Services: Business logic (backup, recovery, device management)
 * - Utils: Helpers and common functions
 *
 * File size: <300 lines (routing only)
 * Each handler: <20 lines (delegates to controllers)
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { ensureBackupBase } = require('../utils/backup-helpers');

// Import controllers
const agentController = require('../controllers/agent-controller');
const backupController = require('../controllers/backup-controller');
const recoveryController = require('../controllers/recovery-controller');

const router = express.Router();

// Ensure backup directories exist
ensureBackupBase();

// ═════════════════════════════════════════════════════════════════════════
// AGENT ENDPOINTS (no auth required — agent uses agentToken header)
// ═════════════════════════════════════════════════════════════════════════

/**
 * POST /agent/register
 * @description Agent self-registration (returns agentToken)
 * @body {hostname, ip, os, mac}
 */
router.post('/agent/register', agentController.registerAgent);

/**
 * GET /agent/poll
 * @description Agent polls for pending backup tasks
 * @header x-agent-token Required agent authentication token
 */
router.get('/agent/poll', agentController.pollAgent);

/**
 * POST /agent/report
 * @description Agent reports backup completion or error
 * @header x-agent-token Required agent authentication token
 * @body {taskId, status, version, error?, size?}
 */
router.post('/agent/report', agentController.reportAgentStatus);

// ═════════════════════════════════════════════════════════════════════════
// DEVICE MANAGEMENT (authenticated)
// ═════════════════════════════════════════════════════════════════════════

// Apply auth middleware to all routes below
router.use(requireAuth);

/**
 * GET /devices
 * @description List all registered backup devices with status
 */
router.get('/devices', backupController.listDevices);

/**
 * GET /devices/:id/images
 * @description List image files for a device (image backup type)
 */
router.get('/devices/:id/images', backupController.getDeviceImages);

/**
 * GET /devices/:id/instructions
 * @description Get setup/configuration instructions (SSH or image backup)
 */
router.get('/devices/:id/instructions', backupController.getDeviceInstructions);

/**
 * POST /devices
 * @description Register a new backup device (manual registration)
 * @body {hostname, ip, port?, username, password, backupType, backupPath?, schedule?, retention?, sambaBrowse?}
 */
router.post('/devices', backupController.createDevice);

/**
 * PUT /devices/:id
 * @description Update device settings (schedule, retention, credentials)
 * @body {schedule?, retention?, password?, sambaBrowse?}
 */
router.put('/devices/:id', backupController.updateDevice);

/**
 * DELETE /devices/:id
 * @description Remove device and its backup history
 */
router.delete('/devices/:id', backupController.deleteDevice);

// ═════════════════════════════════════════════════════════════════════════
// BACKUP OPERATIONS
// ═════════════════════════════════════════════════════════════════════════

/**
 * POST /devices/:id/backup
 * @description Trigger immediate backup for a device
 */
router.post('/devices/:id/backup', backupController.triggerBackup);

/**
 * GET /devices/:id/status
 * @description Get current backup status for device
 */
router.get('/devices/:id/status', backupController.getBackupStatus);

/**
 * GET /devices/:id/versions
 * @description List all backup versions for device
 */
router.get('/devices/:id/versions', backupController.listVersions);

// ═════════════════════════════════════════════════════════════════════════
// RECOVERY TOOLS
// ═════════════════════════════════════════════════════════════════════════

/**
 * GET /recovery/status
 * @description Get recovery ISO availability and build status
 */
router.get('/recovery/status', recoveryController.getRecoveryToolStatus);

/**
 * POST /recovery/build
 * @description Build recovery ISO (async; poll status for progress)
 */
router.post('/recovery/build', recoveryController.buildRecoveryISO);

/**
 * GET /recovery/download
 * @description Download recovery ISO file
 */
router.get('/recovery/download', recoveryController.downloadRecoveryISO);

/**
 * GET /recovery/scripts
 * @description List available recovery scripts
 */
router.get('/recovery/scripts', recoveryController.getRecoveryScripts);

/**
 * GET /recovery/scripts/:name
 * @description Download specific recovery script
 */
router.get('/recovery/scripts/:name', recoveryController.downloadRecoveryScript);

// ═════════════════════════════════════════════════════════════════════════
// AGENT APPROVAL (admin)
// ═════════════════════════════════════════════════════════════════════════

/**
 * GET /pending
 * @description List pending agent approvals
 */
router.get('/pending', agentController.getPendingAgents);

/**
 * POST /pending/:id/approve
 * @description Approve pending agent and add to registered devices
 */
router.post('/pending/:id/approve', agentController.approvePendingAgent);

/**
 * POST /pending/:id/reject
 * @description Reject pending agent registration
 */
router.post('/pending/:id/reject', agentController.rejectPendingAgent);

// ═════════════════════════════════════════════════════════════════════════

module.exports = router;
