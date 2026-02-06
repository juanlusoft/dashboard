/**
 * HomePiNAS Cloud Backup - rclone integration
 * Supports 40+ cloud services: Google Drive, Dropbox, OneDrive, S3, etc.
 */

const express = require('express');
const router = express.Router();
const { execSync, exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Auth middleware
const { requireAuth } = require('./auth');

// Config paths
const RCLONE_CONFIG = '/home/homepinas/.config/rclone/rclone.conf';
const RCLONE_BIN = '/usr/bin/rclone';

// Supported providers with display info
const PROVIDERS = {
    'drive': { name: 'Google Drive', icon: '📁', color: '#4285f4' },
    'dropbox': { name: 'Dropbox', icon: '📦', color: '#0061ff' },
    'onedrive': { name: 'Microsoft OneDrive', icon: '☁️', color: '#0078d4' },
    'mega': { name: 'MEGA', icon: '🔴', color: '#d9272e' },
    's3': { name: 'Amazon S3', icon: '🪣', color: '#ff9900' },
    'b2': { name: 'Backblaze B2', icon: '🔥', color: '#e21e29' },
    'pcloud': { name: 'pCloud', icon: '🌥️', color: '#00bcd4' },
    'box': { name: 'Box', icon: '📤', color: '#0061d5' },
    'sftp': { name: 'SFTP', icon: '🔐', color: '#4caf50' },
    'webdav': { name: 'WebDAV', icon: '🌐', color: '#607d8b' },
    'ftp': { name: 'FTP', icon: '📂', color: '#795548' },
    'nextcloud': { name: 'Nextcloud', icon: '☁️', color: '#0082c9' },
    'gdrive': { name: 'Google Drive', icon: '📁', color: '#4285f4' },  // alias
};

// Helper: Check if rclone is installed
function isRcloneInstalled() {
    try {
        execSync('which rclone', { encoding: 'utf8' });
        return true;
    } catch {
        return false;
    }
}

// Helper: Get rclone version
function getRcloneVersion() {
    try {
        const output = execSync('rclone version 2>/dev/null | head -1', { encoding: 'utf8' });
        const match = output.match(/rclone v([\d.]+)/);
        return match ? match[1] : null;
    } catch {
        return null;
    }
}

// Helper: List configured remotes
function listRemotes() {
    try {
        const output = execSync('rclone listremotes 2>/dev/null', { encoding: 'utf8' });
        return output.trim().split('\n').filter(Boolean).map(r => r.replace(':', ''));
    } catch {
        return [];
    }
}

// Helper: Get remote type
function getRemoteType(remoteName) {
    try {
        const output = execSync(`rclone config show "${remoteName}" 2>/dev/null`, { encoding: 'utf8' });
        const match = output.match(/type\s*=\s*(\w+)/);
        return match ? match[1] : 'unknown';
    } catch {
        return 'unknown';
    }
}

// Helper: Get remote info
function getRemoteInfo(remoteName) {
    try {
        const output = execSync(`rclone about "${remoteName}:" --json 2>/dev/null`, { encoding: 'utf8', timeout: 30000 });
        return JSON.parse(output);
    } catch {
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════

// GET /status - Check rclone status
router.get('/status', requireAuth, (req, res) => {
    const installed = isRcloneInstalled();
    const version = installed ? getRcloneVersion() : null;
    const remotes = installed ? listRemotes() : [];
    
    res.json({
        installed,
        version,
        remotesCount: remotes.length,
        configPath: RCLONE_CONFIG
    });
});

// GET /providers - List available providers
router.get('/providers', requireAuth, (req, res) => {
    const providers = Object.entries(PROVIDERS).map(([id, info]) => ({
        id,
        ...info
    }));
    res.json({ providers });
});

// GET /remotes - List configured remotes with details
router.get('/remotes', requireAuth, async (req, res) => {
    try {
        const remoteNames = listRemotes();
        const remotes = [];
        
        for (const name of remoteNames) {
            const type = getRemoteType(name);
            const providerInfo = PROVIDERS[type] || { name: type, icon: '☁️', color: '#666' };
            
            remotes.push({
                name,
                type,
                displayName: providerInfo.name,
                icon: providerInfo.icon,
                color: providerInfo.color
            });
        }
        
        res.json({ remotes });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /remotes/:name/about - Get remote space info
router.get('/remotes/:name/about', requireAuth, async (req, res) => {
    const { name } = req.params;
    
    try {
        const info = getRemoteInfo(name);
        if (info) {
            res.json({
                total: info.total,
                used: info.used,
                free: info.free,
                trashed: info.trashed || 0
            });
        } else {
            res.json({ total: null, used: null, free: null });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /remotes/:name/ls - List files in remote
router.get('/remotes/:name/ls', requireAuth, async (req, res) => {
    const { name } = req.params;
    const remotePath = req.query.path || '';
    
    try {
        const fullPath = remotePath ? `${name}:${remotePath}` : `${name}:`;
        const output = execSync(`rclone lsjson "${fullPath}" --max-depth 1 2>/dev/null`, { 
            encoding: 'utf8',
            timeout: 60000 
        });
        
        const items = JSON.parse(output);
        res.json({ 
            path: remotePath,
            items: items.map(item => ({
                name: item.Name,
                path: remotePath ? `${remotePath}/${item.Name}` : item.Name,
                isDir: item.IsDir,
                size: item.Size,
                modTime: item.ModTime,
                mimeType: item.MimeType
            }))
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /remotes/:name/delete - Delete a remote config
router.post('/remotes/:name/delete', requireAuth, async (req, res) => {
    const { name } = req.params;
    
    try {
        execSync(`rclone config delete "${name}" 2>/dev/null`, { encoding: 'utf8' });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /config/create - Create new remote interactively
// This starts the rclone config process and returns a session ID
router.post('/config/create', requireAuth, async (req, res) => {
    const { provider, name } = req.body;
    
    if (!provider || !name) {
        return res.status(400).json({ error: 'Provider and name required' });
    }
    
    // Validate name (alphanumeric and underscore only)
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        return res.status(400).json({ error: 'Invalid remote name. Use only letters, numbers, underscore, dash.' });
    }
    
    // Check if name already exists
    const existing = listRemotes();
    if (existing.includes(name)) {
        return res.status(400).json({ error: 'Remote with this name already exists' });
    }
    
    try {
        // For OAuth-based providers, we need to use rclone authorize
        // For simple providers (sftp, ftp, webdav), we can configure directly
        
        const simpleProviders = ['sftp', 'ftp', 'webdav', 's3', 'b2'];
        
        if (simpleProviders.includes(provider)) {
            // Return form fields needed for this provider
            const fields = getProviderFields(provider);
            res.json({ 
                needsOAuth: false,
                fields 
            });
        } else {
            // OAuth providers - need to run rclone authorize
            res.json({
                needsOAuth: true,
                instructions: `Para configurar ${PROVIDERS[provider]?.name || provider}, necesitas autorizar acceso:
                
1. En una terminal del NAS, ejecuta:
   rclone authorize "${provider}"
   
2. Se abrirá un navegador para autorizar
3. Copia el token que aparece
4. Pégalo en el siguiente paso`,
                provider
            });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /config/save-simple - Save simple (non-OAuth) remote config
router.post('/config/save-simple', requireAuth, async (req, res) => {
    const { name, provider, config } = req.body;
    
    if (!name || !provider || !config) {
        return res.status(400).json({ error: 'Name, provider, and config required' });
    }
    
    try {
        // Build rclone config command
        let cmd = `rclone config create "${name}" "${provider}"`;
        
        for (const [key, value] of Object.entries(config)) {
            if (value) {
                cmd += ` "${key}" "${value}"`;
            }
        }
        
        execSync(cmd + ' 2>/dev/null', { encoding: 'utf8' });
        res.json({ success: true, name });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /config/save-oauth - Save OAuth remote with token
router.post('/config/save-oauth', requireAuth, async (req, res) => {
    const { name, provider, token } = req.body;
    
    if (!name || !provider || !token) {
        return res.status(400).json({ error: 'Name, provider, and token required' });
    }
    
    try {
        // Create config with token
        const cmd = `rclone config create "${name}" "${provider}" token '${token}'`;
        execSync(cmd + ' 2>/dev/null', { encoding: 'utf8' });
        res.json({ success: true, name });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /sync - Start sync operation
router.post('/sync', requireAuth, async (req, res) => {
    const { source, dest, mode = 'copy', deleteFiles = false } = req.body;
    
    if (!source || !dest) {
        return res.status(400).json({ error: 'Source and destination required' });
    }
    
    try {
        let cmd;
        
        switch (mode) {
            case 'sync':
                // Sync makes dest identical to source
                cmd = `rclone sync "${source}" "${dest}"`;
                if (deleteFiles) cmd += ' --delete-during';
                break;
            case 'copy':
                // Copy only copies new/changed files
                cmd = `rclone copy "${source}" "${dest}"`;
                break;
            case 'move':
                // Move files (delete from source after copy)
                cmd = `rclone move "${source}" "${dest}"`;
                break;
            default:
                cmd = `rclone copy "${source}" "${dest}"`;
        }
        
        // Add progress flag
        cmd += ' --progress --stats-one-line';
        
        // Run async
        const jobId = Date.now().toString();
        const logFile = `/tmp/rclone-job-${jobId}.log`;
        
        exec(`${cmd} > ${logFile} 2>&1 &`, (err) => {
            if (err) console.error('Rclone job error:', err);
        });
        
        res.json({ 
            success: true, 
            jobId,
            message: 'Sync started in background'
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /jobs/:id - Get job status
router.get('/jobs/:id', requireAuth, (req, res) => {
    const { id } = req.params;
    const logFile = `/tmp/rclone-job-${id}.log`;
    
    try {
        if (fs.existsSync(logFile)) {
            const log = fs.readFileSync(logFile, 'utf8');
            const lines = log.trim().split('\n');
            const lastLine = lines[lines.length - 1] || '';
            
            // Check if process is still running
            const isRunning = lastLine.includes('Transferred:') && !lastLine.includes('100%');
            
            res.json({
                jobId: id,
                running: isRunning,
                lastLine,
                log: lines.slice(-20).join('\n')
            });
        } else {
            res.json({ jobId: id, running: false, error: 'Job not found' });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Helper: Get configuration fields for a provider
function getProviderFields(provider) {
    const fields = {
        sftp: [
            { name: 'host', label: 'Host', type: 'text', required: true },
            { name: 'user', label: 'Usuario', type: 'text', required: true },
            { name: 'pass', label: 'Contraseña', type: 'password', required: false },
            { name: 'port', label: 'Puerto', type: 'number', default: 22 },
            { name: 'key_file', label: 'Archivo de clave SSH', type: 'text', required: false },
        ],
        ftp: [
            { name: 'host', label: 'Host', type: 'text', required: true },
            { name: 'user', label: 'Usuario', type: 'text', required: true },
            { name: 'pass', label: 'Contraseña', type: 'password', required: true },
            { name: 'port', label: 'Puerto', type: 'number', default: 21 },
        ],
        webdav: [
            { name: 'url', label: 'URL WebDAV', type: 'text', required: true, placeholder: 'https://example.com/dav' },
            { name: 'user', label: 'Usuario', type: 'text', required: true },
            { name: 'pass', label: 'Contraseña', type: 'password', required: true },
        ],
        s3: [
            { name: 'provider', label: 'Proveedor S3', type: 'select', options: ['AWS', 'Minio', 'Wasabi', 'DigitalOcean', 'Other'], required: true },
            { name: 'access_key_id', label: 'Access Key ID', type: 'text', required: true },
            { name: 'secret_access_key', label: 'Secret Access Key', type: 'password', required: true },
            { name: 'region', label: 'Región', type: 'text', default: 'us-east-1' },
            { name: 'endpoint', label: 'Endpoint (si no es AWS)', type: 'text', required: false },
        ],
        b2: [
            { name: 'account', label: 'Account ID', type: 'text', required: true },
            { name: 'key', label: 'Application Key', type: 'password', required: true },
        ],
    };
    
    return fields[provider] || [];
}

// POST /install - Install rclone
router.post('/install', requireAuth, async (req, res) => {
    try {
        // Install rclone using official script
        execSync('curl https://rclone.org/install.sh | sudo bash', { 
            encoding: 'utf8',
            timeout: 120000 
        });
        
        const version = getRcloneVersion();
        res.json({ success: true, version });
    } catch (e) {
        res.status(500).json({ error: 'Failed to install rclone: ' + e.message });
    }
});

module.exports = router;
