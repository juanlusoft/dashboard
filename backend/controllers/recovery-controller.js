/**
 * Recovery Controller — HTTP handlers for disaster recovery operations
 * Single Responsibility: Recovery ISO building, status checks, downloads
 * Delegates to recovery-service for business logic
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { getData } = require('../utils/data');
const { logSecurityEvent } = require('../utils/security');
const {
  getRecoveryStatus,
  getRecoveryISOPath,
  getRecoveryScriptsDir,
  getRecoveryBuildScript,
} = require('../services/recovery-service');

// Build state tracking (in production, use database)
let isBuilding = false;
let buildProgress = 0;

// ──────────────────────────────────────────
// RECOVERY STATUS & INFO
// ──────────────────────────────────────────

/**
 * GET /recovery/status - Get recovery tool status
 * Returns whether recovery ISO is available and build status
 */
function getRecoveryToolStatus(req, res) {
  try {
    const status = getRecoveryStatus();
    res.json({
      success: true,
      status,
      isBuilding,
      buildProgress,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /recovery/scripts - Get available recovery scripts
 */
function getRecoveryScripts(req, res) {
  try {
    const scriptsDir = getRecoveryScriptsDir();
    if (!fs.existsSync(scriptsDir)) {
      return res.json({ success: true, scripts: [] });
    }

    const scripts = fs
      .readdirSync(scriptsDir)
      .filter((f) => f.endsWith('.sh') || f.endsWith('.py'))
      .map((f) => ({
        name: f,
        path: path.join(scriptsDir, f),
      }));

    res.json({ success: true, scripts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ──────────────────────────────────────────
// RECOVERY ISO BUILD
// ──────────────────────────────────────────

/**
 * POST /recovery/build - Trigger recovery ISO build
 * Async operation; client polls status via GET /recovery/status
 */
async function buildRecoveryISO(req, res) {
  if (isBuilding) {
    return res.status(409).json({ error: 'Build already in progress' });
  }

  isBuilding = true;
  buildProgress = 0;

  // Return immediately; build happens in background
  res.json({
    success: true,
    message: 'Build started; poll /recovery/status for progress',
  });

  // Execute build in background (don't await)
  buildRecoveryISOInBackground();
}

/**
 * Execute recovery ISO build (background task)
 * Updates buildProgress as work completes
 */
async function buildRecoveryISOInBackground() {
  try {
    const buildScript = getRecoveryBuildScript();

    if (!fs.existsSync(buildScript)) {
      console.error(`[Recovery] Build script not found: ${buildScript}`);
      isBuilding = false;
      buildProgress = 0;
      return;
    }

    buildProgress = 10; // Started

    // Spawn build process
    const child = spawn('bash', [buildScript], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (data) => {
      output += data.toString();
      updateBuildProgress(output);
    });

    child.stderr.on('data', (data) => {
      console.error(`[Recovery Build] ${data}`);
    });

    child.on('close', (code) => {
      if (code === 0) {
        buildProgress = 100;
        console.log('[Recovery] ISO build completed');
        logSecurityEvent('recovery_iso_built', {});
      } else {
        console.error(`[Recovery] Build failed with code ${code}`);
        buildProgress = 0;
        isBuilding = false;
      }
      isBuilding = false;
    });
  } catch (err) {
    console.error(`[Recovery] Build error: ${err.message}`);
    buildProgress = 0;
    isBuilding = false;
  }
}

/**
 * Update build progress based on output logs
 * This is a simplified example; tailor to your build process
 */
function updateBuildProgress(output) {
  // Count completed steps in output (examples: "✓ packages installed", "✓ kernel built")
  const steps = output.match(/✓/g) || [];
  if (steps.length > 0) {
    buildProgress = Math.min(50 + steps.length * 5, 95);
  }
}

// ──────────────────────────────────────────
// RECOVERY ISO DOWNLOAD
// ──────────────────────────────────────────

/**
 * GET /recovery/download - Download recovery ISO
 */
function downloadRecoveryISO(req, res) {
  try {
    const isoPath = getRecoveryISOPath();

    if (!fs.existsSync(isoPath)) {
      return res.status(404).json({ error: 'Recovery ISO not found; build it first' });
    }

    const stat = fs.statSync(isoPath);
    const filename = path.basename(isoPath);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', stat.size);

    const fileStream = fs.createReadStream(isoPath);
    fileStream.pipe(res);

    logSecurityEvent('recovery_iso_downloaded', {
      filename,
      size: stat.size,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ──────────────────────────────────────────
// RECOVERY SCRIPTS DOWNLOAD
// ──────────────────────────────────────────

/**
 * GET /recovery/scripts/:name - Download specific recovery script
 */
function downloadRecoveryScript(req, res) {
  try {
    const scriptsDir = getRecoveryScriptsDir();
    const scriptName = path.basename(req.params.name); // Prevent path traversal
    const scriptPath = path.join(scriptsDir, scriptName);

    // Security: only allow files in recovery scripts directory
    if (!scriptPath.startsWith(scriptsDir)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!fs.existsSync(scriptPath)) {
      return res.status(404).json({ error: 'Script not found' });
    }

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${scriptName}"`);

    const fileStream = fs.createReadStream(scriptPath);
    fileStream.pipe(res);

    logSecurityEvent('recovery_script_downloaded', { scriptName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  getRecoveryToolStatus,
  getRecoveryScripts,
  buildRecoveryISO,
  downloadRecoveryISO,
  downloadRecoveryScript,
};
