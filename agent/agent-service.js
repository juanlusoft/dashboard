/**
 * HomePiNAS Backup Agent v2 - Pure Node.js Windows Service
 * SIN Electron, SIN UI - Todo controlado desde el dashboard del NAS
 * 
 * Flujo:
 * 1. Leer config de %PROGRAMDATA%/HomePiNAS/config.json
 * 2. Si no hay config: auto-discovery del NAS (mDNS/subnet scan) → registrarse
 * 3. Poll al NAS cada 60s: GET /api/active-backup/agent/poll
 * 4. Si NAS responde action: backup → ejecutar backup worker
 * 5. Reportar resultado: POST /api/active-backup/agent/report
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const https = require('https');

// ── Configuración ────────────────────────────────────────────────────────────

const CONFIG_DIR = path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'HomePiNAS');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const STATUS_FILE = path.join(CONFIG_DIR, 'status.json');
const LOG_FILE = path.join(CONFIG_DIR, 'agent.log');
const BACKUP_WORKER = path.join(__dirname, 'workers', 'backup-worker.ps1');
const STATUS_CHECK_INTERVAL = 5000; // 5 segundos

// ── Logging ──────────────────────────────────────────────────────────────────

function log(message, level = 'INFO') {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level}] ${message}`;
  console.log(line);
  
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) {
    // Silent fail for logging errors
  }
}

// ── Config Management ────────────────────────────────────────────────────────

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    log(`Error loading config: ${e.message}`, 'ERROR');
  }
  return null;
}

function saveConfig(config) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    log('Config saved');
  } catch (e) {
    log(`Error saving config: ${e.message}`, 'ERROR');
  }
}

function updateStatus(status) {
  try {
    const current = loadStatus();
    const updated = { ...current, ...status, lastUpdate: new Date().toISOString() };
    fs.writeFileSync(STATUS_FILE, JSON.stringify(updated, null, 2), 'utf8');
  } catch (e) {
    log(`Error updating status: ${e.message}`, 'ERROR');
  }
}

function loadStatus() {
  try {
    if (fs.existsSync(STATUS_FILE)) {
      return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
    }
  } catch (e) {}
  return {};
}

// ── NAS Discovery ────────────────────────────────────────────────────────────

async function discoverNAS() {
  log('Starting NAS discovery (mDNS + subnet scan)');
  
  const results = [];
  
  // Try mDNS first (if bonjour-service is available)
  try {
    const { Bonjour } = require('bonjour-service');
    const bonjour = new Bonjour();
    
    const found = await new Promise((resolve) => {
      const services = [];
      const browser = bonjour.find({ type: 'homepinas', protocol: 'tcp' });
      
      browser.on('up', (service) => {
        log(`mDNS: Found ${service.name} at ${service.host}:${service.port}`);
        services.push({
          address: service.host,
          port: service.port,
          name: service.name,
          method: 'mdns'
        });
      });
      
      setTimeout(() => {
        browser.stop();
        bonjour.destroy();
        resolve(services);
      }, 5000);
    });
    
    results.push(...found);
  } catch (e) {
    log(`mDNS discovery failed: ${e.message}`, 'WARN');
  }
  
  // Fallback: subnet scan
  if (results.length === 0) {
    log('mDNS found nothing, trying subnet scan');
    const subnet = getLocalSubnet();
    if (subnet) {
      const scanResults = await scanSubnet(subnet);
      results.push(...scanResults);
    }
  }
  
  return results;
}

function getLocalSubnet() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        const parts = iface.address.split('.');
        return `${parts[0]}.${parts[1]}.${parts[2]}`;
      }
    }
  }
  return null;
}

async function scanSubnet(subnetPrefix) {
  const results = [];
  const commonPorts = [443, 80, 3000];
  
  // Scan common IPs (gateway, .100, .101, etc.)
  const targets = [1, 100, 101, 102, 50, 200];
  
  for (const lastOctet of targets) {
    const ip = `${subnetPrefix}.${lastOctet}`;
    for (const port of commonPorts) {
      try {
        const reachable = await testConnection(ip, port);
        if (reachable) {
          log(`Subnet scan: Found ${ip}:${port}`);
          results.push({ address: ip, port, method: 'subnet' });
        }
      } catch (e) {}
    }
  }
  
  return results;
}

function testConnection(address, port) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: address,
      port,
      path: '/api/active-backup/agent/register',
      method: 'POST',
      timeout: 3000,
      rejectUnauthorized: false,
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      resolve(res.statusCode === 200 || res.statusCode === 400);
    });
    
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(JSON.stringify({ hostname: 'discovery-test' }));
    req.end();
  });
}

// ── NAS API ──────────────────────────────────────────────────────────────────

class NASApi {
  constructor(caPath = null) {
    this.agent = new https.Agent({ 
      rejectUnauthorized: false,
      timeout: 120000
    });
    
    if (caPath && fs.existsSync(caPath)) {
      try {
        const ca = fs.readFileSync(caPath);
        this.agent = new https.Agent({ ca, rejectUnauthorized: true });
      } catch (e) {
        log(`Could not load CA cert: ${e.message}`, 'WARN');
      }
    }
  }
  
  request(method, address, port, reqPath, headers = {}, body = null) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: address,
        port,
        path: `/api${reqPath}`,
        method,
        agent: this.agent,
        timeout: 120000,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode >= 400) {
              reject(new Error(json.error || `HTTP ${res.statusCode}`));
            } else {
              resolve(json);
            }
          } catch (e) {
            reject(new Error('Invalid response from NAS'));
          }
        });
      });

      req.on('error', (err) => reject(new Error(`Connection failed: ${err.message}`)));
      req.on('timeout', () => { req.destroy(); reject(new Error('Connection timeout')); });

      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }
  
  async register(address, port, deviceInfo) {
    return this.request('POST', address, port, '/active-backup/agent/register', {}, deviceInfo);
  }
  
  async poll(address, port, agentToken) {
    return this.request('GET', address, port, '/active-backup/agent/poll', { 'X-Agent-Token': agentToken });
  }
  
  async report(address, port, agentToken, result) {
    return this.request('POST', address, port, '/active-backup/agent/report', { 'X-Agent-Token': agentToken }, result);
  }
}

// ── Agent Registration ───────────────────────────────────────────────────────

async function registerWithNAS(api, nasAddress, nasPort) {
  log(`Registering with NAS at ${nasAddress}:${nasPort}`);
  
  const nets = os.networkInterfaces();
  let mac = '';
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal && net.mac !== '00:00:00:00:00:00') {
        mac = net.mac;
        break;
      }
    }
    if (mac) break;
  }
  
  const deviceInfo = {
    hostname: os.hostname(),
    ip: getLocalIP(),
    os: process.platform,
    osVersion: os.release(),
    arch: os.arch(),
    mac,
  };
  
  const result = await api.register(nasAddress, nasPort, deviceInfo);
  log(`Registered: agentId=${result.agentId}, status=${result.status}`);
  
  return {
    nasAddress,
    nasPort,
    agentId: result.agentId,
    agentToken: result.agentToken,
    status: result.status,
  };
}

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '0.0.0.0';
}

// ── Backup Worker ────────────────────────────────────────────────────────────

let backupWorkerProcess = null;
let backupWorkerStatus = null;
let statusCheckInterval = null;

async function runBackup(config) {
  log('Starting backup via PowerShell worker');
  
  const workerConfig = {
    nasAddress: config.nasAddress,
    nasPort: config.nasPort || 443,
    backupType: config.backupType || 'image',
    backupPaths: config.backupPaths || [],
    sambaShare: config.sambaShare,
    sambaUser: config.sambaUser,
    sambaPass: config.sambaPass,
    statusFile: path.join(CONFIG_DIR, 'backup-status.json'),
  };
  
  // Clear previous status
  backupWorkerStatus = null;
  if (fs.existsSync(workerConfig.statusFile)) {
    try { fs.unlinkSync(workerConfig.statusFile); } catch (e) {}
  }
  
  // Spawn PowerShell worker as separate process
  const psArgs = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', BACKUP_WORKER,
    '-ConfigJson', JSON.stringify(workerConfig)
  ];
  
  log(`Spawning backup worker: powershell.exe ${psArgs.join(' ')}`);
  
  backupWorkerProcess = spawn('powershell.exe', psArgs, {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  
  backupWorkerProcess.stdout.on('data', (data) => {
    log(`[Worker] ${data.toString().trim()}`);
  });
  
  backupWorkerProcess.stderr.on('data', (data) => {
    log(`[Worker ERROR] ${data.toString().trim()}`, 'ERROR');
  });
  
  // Start monitoring status file
  startStatusMonitoring(workerConfig.statusFile);
  
  // Wait for process to complete
  const exitCode = await waitForWorker(backupWorkerProcess);
  
  stopStatusMonitoring();
  
  // Read final status
  const result = readBackupResult(workerConfig.statusFile);
  
  if (exitCode !== 0 && (!result || result.status !== 'success')) {
    throw new Error(`Backup worker exited with code ${exitCode}`);
  }
  
  return result;
}

function startStatusMonitoring(statusFile) {
  statusCheckInterval = setInterval(() => {
    try {
      if (fs.existsSync(statusFile)) {
        const data = fs.readFileSync(statusFile, 'utf8');
        backupWorkerStatus = JSON.parse(data);
        log(`Backup progress: ${backupWorkerStatus.progress}% - ${backupWorkerStatus.message || 'working'}`);
        updateStatus({
          backupProgress: backupWorkerStatus.progress,
          backupMessage: backupWorkerStatus.message,
          backupPhase: backupWorkerStatus.phase,
        });
      }
    } catch (e) {
      // Status file might be in flux
    }
  }, STATUS_CHECK_INTERVAL);
}

function stopStatusMonitoring() {
  if (statusCheckInterval) {
    clearInterval(statusCheckInterval);
    statusCheckInterval = null;
  }
}

function waitForWorker(process) {
  return new Promise((resolve) => {
    process.on('close', (code) => {
      log(`Backup worker exited with code ${code}`);
      resolve(code);
    });
    process.on('error', (err) => {
      log(`Backup worker error: ${err.message}`, 'ERROR');
      resolve(-1);
    });
  });
}

function readBackupResult(statusFile) {
  try {
    if (fs.existsSync(statusFile)) {
      const data = fs.readFileSync(statusFile, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    log(`Error reading backup result: ${e.message}`, 'ERROR');
  }
  return null;
}

// ── Main Agent Loop ──────────────────────────────────────────────────────────

let pollInterval = null;
let api = null;

async function pollNAS(config) {
  try {
    const result = await api.poll(config.nasAddress, config.nasPort, config.agentToken);
    
    log(`Poll response: status=${result.status}, action=${result.action || 'none'}`);
    
    if (result.status === 'pending') {
      updateStatus({ status: 'pending', message: 'Esperando aprobación del NAS' });
      if (config.status !== 'pending') {
        config.status = 'pending';
        saveConfig(config);
      }
    } else if (result.status === 'approved') {
      if (config.status !== 'approved') {
        log('Agent approved by NAS!');
        config.status = 'approved';
        
        // Save config from NAS
        if (result.config) {
          config.deviceName = result.config.deviceName || '';
          config.backupType = result.config.backupType || 'image';
          config.schedule = result.config.schedule || '0 3 * * *';
          config.retention = result.config.retention || 3;
          if (result.config.paths) config.backupPaths = result.config.paths;
          if (result.config.sambaShare) config.sambaShare = result.config.sambaShare;
          if (result.config.sambaUser) config.sambaUser = result.config.sambaUser;
          if (result.config.sambaPass) config.sambaPass = result.config.sambaPass;
          saveConfig(config);
        }
        
        updateStatus({ 
          status: 'approved', 
          message: 'Conectado - esperando horario de backup',
          deviceName: config.deviceName,
        });
      }
      
      // Check if NAS triggered a manual backup
      if (result.action === 'backup') {
        log('NAS triggered manual backup');
        await executeBackup(config);
      }
    }
  } catch (err) {
    log(`Poll error: ${err.message}`, 'ERROR');
    updateStatus({ status: 'disconnected', message: `Error: ${err.message}` });
  }
}

async function executeBackup(config) {
  updateStatus({ 
    status: 'backing_up', 
    message: 'Backup en progreso...',
    backupProgress: 0,
  });
  
  const startTime = Date.now();
  
  try {
    const result = await runBackup(config);
    const duration = Math.round((Date.now() - startTime) / 1000);
    
    log(`Backup completed: ${result.status} in ${duration}s`);
    
    updateStatus({ 
      status: 'approved',
      lastBackup: new Date().toISOString(),
      lastResult: result.status,
      lastDuration: duration,
      message: result.status === 'success' ? 'Backup completado' : 'Backup fallido',
    });
    
    // Report to NAS
    try {
      await api.report(config.nasAddress, config.nasPort, config.agentToken, {
        status: result.status,
        duration,
        error: result.error || null,
        details: result.details || null,
      });
    } catch (e) {
      log(`Failed to report to NAS: ${e.message}`, 'WARN');
    }
    
  } catch (err) {
    const duration = Math.round((Date.now() - startTime) / 1000);
    log(`Backup failed: ${err.message}`, 'ERROR');
    
    updateStatus({ 
      status: 'approved',
      lastBackup: new Date().toISOString(),
      lastResult: 'error',
      lastDuration: duration,
      message: `Error: ${err.message}`,
    });
    
    try {
      await api.report(config.nasAddress, config.nasPort, config.agentToken, {
        status: 'error',
        duration,
        error: err.message,
      });
    } catch (e) {
      log(`Failed to report error to NAS: ${e.message}`, 'WARN');
    }
  }
}

function startPolling(config) {
  if (pollInterval) clearInterval(pollInterval);
  
  log(`Starting NAS polling (every 60s) to ${config.nasAddress}:${config.nasPort}`);
  pollInterval = setInterval(() => pollNAS(config), 60000);
  
  // First poll immediately
  pollNAS(config);
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

// ── Auto-discovery & Registration ────────────────────────────────────────────

async function autoDiscoverAndRegister() {
  log('No config found - starting auto-discovery');
  
  const discovered = await discoverNAS();
  
  if (discovered.length === 0) {
    log('No NAS found via auto-discovery', 'ERROR');
    updateStatus({ 
      status: 'disconnected', 
      message: 'No se encontró el NAS - verifique conexión de red',
    });
    return null;
  }
  
  log(`Found ${discovered.length} NAS device(s)`);
  
  // Try to register with the first one
  for (const nas of discovered) {
    try {
      api = new NASApi();
      const config = await registerWithNAS(api, nas.address, nas.port);
      saveConfig(config);
      updateStatus({ 
        status: config.status, 
        message: config.status === 'approved' ? 'Conectado' : 'Esperando aprobación',
        nasAddress: config.nasAddress,
      });
      return config;
    } catch (e) {
      log(`Failed to register with ${nas.address}:${nas.port}: ${e.message}`, 'WARN');
    }
  }
  
  return null;
}

// ── Service Entry Point ──────────────────────────────────────────────────────

async function main() {
  log('═══════════════════════════════════════════════════════════');
  log('HomePiNAS Backup Agent v2 starting...');
  log(`Platform: ${process.platform} ${os.arch()}`);
  log(`Hostname: ${os.hostname()}`);
  log(`Config: ${CONFIG_FILE}`);
  log('═══════════════════════════════════════════════════════════');
  
  // Ensure config directory exists
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  
  // Load or create config
  let config = loadConfig();
  
  if (!config || !config.nasAddress) {
    config = await autoDiscoverAndRegister();
    if (!config) {
      log('Could not auto-register. Waiting for config file...', 'WARN');
      // Wait for config file to be created by NAS
      await waitForConfigFile();
      config = loadConfig();
    }
  }
  
  if (!config || !config.agentToken) {
    log('No valid config - agent cannot start', 'ERROR');
    process.exit(1);
  }
  
  // Initialize API
  api = new NASApi();
  
  // Start polling
  startPolling(config);
  
  // Handle graceful shutdown
  process.on('SIGTERM', () => {
    log('Received SIGTERM - shutting down');
    stopPolling();
    stopStatusMonitoring();
    if (backupWorkerProcess) {
      backupWorkerProcess.kill();
    }
    process.exit(0);
  });
  
  process.on('SIGINT', () => {
    log('Received SIGINT - shutting down');
    stopPolling();
    stopStatusMonitoring();
    if (backupWorkerProcess) {
      backupWorkerProcess.kill();
    }
    process.exit(0);
  });
  
  log('Agent running. Press Ctrl+C to stop.');
}

async function waitForConfigFile() {
  log('Waiting for config file (max 5 minutes)...');
  const maxWait = 5 * 60 * 1000; // 5 minutes
  const checkInterval = 5000; // 5 seconds
  const startTime = Date.now();
  
  while (Date.now() - startTime < maxWait) {
    if (fs.existsSync(CONFIG_FILE)) {
      const config = loadConfig();
      if (config && config.nasAddress && config.agentToken) {
        log('Config file found!');
        return;
      }
    }
    await new Promise(resolve => setTimeout(resolve, checkInterval));
  }
  
  log('Timeout waiting for config file', 'ERROR');
}

// Start the agent
main().catch((err) => {
  log(`Fatal error: ${err.message}`, 'ERROR');
  process.exit(1);
});
