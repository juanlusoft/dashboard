/**
 * Agent Controller — HTTP handlers for agent registration, polling, and reporting
 * Single Responsibility: Manage agent lifecycle (register, poll, report)
 * Delegates persistence to backup-service and agent-service
 */

const crypto = require('crypto');
const { getData, saveData } = require('../utils/data');
const { logSecurityEvent } = require('../utils/security');

// ──────────────────────────────────────────
// AGENT REGISTRATION & LIFECYCLE
// ──────────────────────────────────────────

/**
 * POST /agent/register - Agent announces itself
 * Returns agentId and agentToken for future polling
 * No auth required (agent identifies itself by hostname/MAC)
 */
function registerAgent(req, res) {
  const { hostname, ip, os: agentOS, mac } = req.body;

  if (!hostname) {
    return res.status(400).json({ error: 'hostname is required' });
  }

  const data = getData();
  ensureActiveBackupStructure(data);

  // Check if already registered (approved device)
  const existing = findRegisteredAgent(data, { hostname, ip, mac });
  if (existing) {
    return res.json({
      success: true,
      agentId: existing.id,
      agentToken: existing.agentToken,
      status: 'approved',
    });
  }

  // Check if pending approval
  const pending = findPendingAgent(data, { hostname, ip, mac });
  if (pending) {
    return res.json({
      success: true,
      agentId: pending.id,
      agentToken: pending.agentToken,
      status: 'pending',
    });
  }

  // Register new pending agent
  return registerNewAgent(req, res, data, { hostname, ip, agentOS, mac });
}

/**
 * GET /agent/poll - Agent polls for config and backup tasks
 * Auth via X-Agent-Token header
 */
function pollAgent(req, res) {
  const token = req.headers['x-agent-token'];
  if (!token) {
    return res.status(401).json({ error: 'Missing agent token' });
  }

  const data = getData();
  const agent = findAgentByToken(data, token);

  if (!agent) {
    return res.status(403).json({ error: 'Invalid agent token' });
  }

  // Only approved agents get tasks
  if (agent.status !== 'approved') {
    return res.json({
      tasks: [],
      message: 'Agent pending approval',
    });
  }

  const tasks = getPendingTasks(data, agent.id);

  // Update lastSeen
  agent.lastSeen = new Date().toISOString();
  agent.ip = req.ip?.replace('::ffff:', '') || agent.ip;
  saveData(data);

  res.json({
    success: true,
    agentId: agent.id,
    tasks,
    config: {
      deviceId: agent.id,
      deviceName: agent.name,
      backupType: agent.backupType || 'image',
      schedule: agent.schedule || '0 3 * * *',
      retention: agent.retention || 3,
      paths: agent.paths || [],
      enabled: agent.enabled !== false,
      sambaShare: agent.sambaShare,
      sambaUser: agent.sambaUser,
      sambaPass: agent.sambaPass,
      nasAddress: req.hostname || '192.168.1.100',
    },
  });
}

/**
 * POST /agent/report - Agent reports backup results
 * Auth via X-Agent-Token header
 */
function reportAgentStatus(req, res) {
  const token = req.headers['x-agent-token'];
  if (!token) {
    return res.status(401).json({ error: 'Missing agent token' });
  }

  const data = getData();
  const agent = findAgentByToken(data, token);

  if (!agent) {
    return res.status(403).json({ error: 'Invalid agent token' });
  }

  const { status, taskId, version, error, size } = req.body;

  if (!taskId || !status) {
    return res.status(400).json({ error: 'taskId and status required' });
  }

  // Record the report (log, update device status, etc.)
  recordAgentReport(data, agent.id, {
    taskId,
    status,
    version,
    error,
    size,
    reportedAt: new Date().toISOString(),
  });

  saveData(data);
  logSecurityEvent('agent_report', { agentId: agent.id, status, taskId });

  res.json({ success: true, message: 'Report received' });
}

// ──────────────────────────────────────────
// AGENT APPROVAL (Admin)
// ──────────────────────────────────────────

/**
 * POST /pending/:id/approve - Approve pending agent (admin)
 */
async function approvePendingAgent(req, res) {
  const data = getData();
  const pendingIdx = data.activeBackup?.pendingAgents.findIndex(
    (a) => a.id === req.params.id,
  );

  if (pendingIdx === -1) {
    return res.status(404).json({ error: 'Pending agent not found' });
  }

  const agent = data.activeBackup.pendingAgents[pendingIdx];

  // Move from pending to registered devices
  const device = {
    id: agent.id,
    agentToken: agent.agentToken,
    hostname: agent.hostname,
    ip: agent.ip,
    os: agent.os,
    agentMac: agent.mac,
    agentHostname: agent.hostname,
    status: 'approved',
    backupType: 'rsync',
    backupPath: '/mnt/backup',
    schedule: 'daily',
    retention: 7,
    createdAt: new Date().toISOString(),
    approvedAt: new Date().toISOString(),
  };

  data.activeBackup.devices.push(device);
  data.activeBackup.pendingAgents.splice(pendingIdx, 1);
  saveData(data);

  logSecurityEvent('agent_approved', { agentId: agent.id, hostname: agent.hostname });

  res.json({ success: true, device });
}

/**
 * POST /pending/:id/reject - Reject pending agent (admin)
 */
function rejectPendingAgent(req, res) {
  const data = getData();
  const pendingIdx = data.activeBackup?.pendingAgents.findIndex(
    (a) => a.id === req.params.id,
  );

  if (pendingIdx === -1) {
    return res.status(404).json({ error: 'Pending agent not found' });
  }

  const agent = data.activeBackup.pendingAgents[pendingIdx];
  data.activeBackup.pendingAgents.splice(pendingIdx, 1);
  saveData(data);

  logSecurityEvent('agent_rejected', { agentId: agent.id, hostname: agent.hostname });

  res.json({ success: true, message: 'Agent rejected' });
}

/**
 * GET /pending - List pending agent approvals (admin)
 */
function getPendingAgents(req, res) {
  const data = getData();
  const pending = data.activeBackup?.pendingAgents || [];

  res.json({ success: true, pending });
}

// ──────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────

function ensureActiveBackupStructure(data) {
  if (!data.activeBackup) {
    data.activeBackup = { devices: [], pendingAgents: [] };
  }
  if (!data.activeBackup.pendingAgents) {
    data.activeBackup.pendingAgents = [];
  }
  if (!data.activeBackup.devices) {
    data.activeBackup.devices = [];
  }
}

function findRegisteredAgent(data, { hostname, ip, mac }) {
  return data.activeBackup?.devices.find(
    (d) => d.agentMac === mac || (d.agentHostname === hostname && d.ip === ip),
  );
}

function findPendingAgent(data, { hostname, ip, mac }) {
  return data.activeBackup?.pendingAgents.find(
    (a) => a.mac === mac || (a.hostname === hostname && a.ip === ip),
  );
}

function findAgentByToken(data, token) {
  // First check registered devices
  let agent = data.activeBackup?.devices.find((d) => d.agentToken === token);
  if (agent) {
    agent.type = 'device';
    return agent;
  }

  // Then check pending agents
  agent = data.activeBackup?.pendingAgents.find((a) => a.agentToken === token);
  if (agent) {
    agent.type = 'pending';
  }

  return agent;
}

function getPendingTasks(data, agentId) {
  // TODO: Query task queue for this agent
  // For now, return empty (implement when task scheduling is added)
  const device = data.activeBackup?.devices.find((d) => d.id === agentId);
  if (!device) {
    return [];
  }

  // Check if a scheduled backup is due
  // (This is simplified; use cron/scheduler for production)
  const tasks = [];
  if (device.schedule === 'daily' && shouldRunBackupNow(device)) {
    tasks.push({
      taskId: `task_${Date.now()}`,
      type: 'backup',
      path: device.backupPath,
    });
  }

  return tasks;
}

function shouldRunBackupNow(device) {
  // Simplified check: run if more than 24h since last backup
  // TODO: Use proper cron expression parsing
  const lastBackup = device.lastBackupTime ? new Date(device.lastBackupTime) : null;
  if (!lastBackup) {
    return true;
  }

  const hoursSince = (Date.now() - lastBackup.getTime()) / (1000 * 60 * 60);
  return hoursSince > 23;
}

function recordAgentReport(data, agentId, report) {
  const device = data.activeBackup?.devices.find((d) => d.id === agentId);
  if (!device) {
    return;
  }

  if (!device.backupHistory) {
    device.backupHistory = [];
  }

  device.backupHistory.push(report);

  // Keep only last 50 reports
  if (device.backupHistory.length > 50) {
    device.backupHistory = device.backupHistory.slice(-50);
  }

  // Update last backup time if successful
  if (report.status === 'success') {
    device.lastBackupTime = report.reportedAt;
    device.lastBackupSize = report.size;
  }
}

function registerNewAgent(req, res, data, { hostname, ip, agentOS, mac }) {
  const agentId = `${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
  const agentToken = crypto.randomBytes(32).toString('hex');

  const agent = {
    id: agentId,
    agentToken,
    hostname,
    ip: ip || req.ip,
    os: agentOS || 'unknown',
    mac: mac || null,
    registeredAt: new Date().toISOString(),
  };

  data.activeBackup.pendingAgents.push(agent);
  saveData(data);

  console.log(`[Active Backup] New agent registered: ${hostname} (${ip || req.ip})`);
  logSecurityEvent('agent_registered', { agentId, hostname, ip: ip || req.ip });

  res.json({
    success: true,
    agentId,
    agentToken,
    status: 'pending',
  });
}

module.exports = {
  registerAgent,
  pollAgent,
  reportAgentStatus,
  approvePendingAgent,
  rejectPendingAgent,
  getPendingAgents,
};
