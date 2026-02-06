const express = require('express');
const router = express.Router();
const { exec, spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');

// Load catalog
const CATALOG_PATH = path.join(__dirname, '../data/homestore-catalog.json');
const APPS_BASE = '/opt/homepinas/apps';
const INSTALLED_PATH = path.join(__dirname, '../config/homestore-installed.json');

// Helper: Load catalog
async function loadCatalog() {
    const data = await fs.readFile(CATALOG_PATH, 'utf8');
    return JSON.parse(data);
}

// Helper: Load installed apps
async function loadInstalled() {
    try {
        const data = await fs.readFile(INSTALLED_PATH, 'utf8');
        return JSON.parse(data);
    } catch {
        return { apps: {} };
    }
}

// Helper: Save installed apps
async function saveInstalled(installed) {
    await fs.writeFile(INSTALLED_PATH, JSON.stringify(installed, null, 2));
}

// Helper: Check if Docker is available
async function checkDocker() {
    return new Promise((resolve) => {
        exec('docker --version', (err) => resolve(!err));
    });
}

// Helper: Get container status
async function getContainerStatus(appId) {
    return new Promise((resolve) => {
        exec(`docker ps -a --filter "name=homestore-${appId}" --format "{{.Status}}"`, (err, stdout) => {
            if (err || !stdout.trim()) {
                resolve(null);
            } else {
                const status = stdout.trim().toLowerCase();
                if (status.includes('up')) {
                    resolve('running');
                } else if (status.includes('exited')) {
                    resolve('stopped');
                } else {
                    resolve('unknown');
                }
            }
        });
    });
}

// Helper: Get container stats
async function getContainerStats(appId) {
    return new Promise((resolve) => {
        exec(`docker stats homestore-${appId} --no-stream --format "{{.CPUPerc}},{{.MemUsage}}"`, (err, stdout) => {
            if (err || !stdout.trim()) {
                resolve(null);
            } else {
                const [cpu, mem] = stdout.trim().split(',');
                resolve({ cpu, memory: mem });
            }
        });
    });
}

// GET /homestore/catalog - List all available apps
router.get('/catalog', async (req, res) => {
    try {
        const catalog = await loadCatalog();
        const installed = await loadInstalled();
        
        // Enrich apps with install status
        const apps = await Promise.all(catalog.apps.map(async (app) => {
            const status = await getContainerStatus(app.id);
            return {
                ...app,
                installed: !!installed.apps[app.id],
                status: status,
                installedAt: installed.apps[app.id]?.installedAt
            };
        }));
        
        res.json({
            success: true,
            version: catalog.version,
            categories: catalog.categories,
            apps
        });
    } catch (error) {
        console.error('Error loading catalog:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /homestore/categories - List categories
router.get('/categories', async (req, res) => {
    try {
        const catalog = await loadCatalog();
        res.json({ success: true, categories: catalog.categories });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /homestore/installed - List installed apps
router.get('/installed', async (req, res) => {
    try {
        const catalog = await loadCatalog();
        const installed = await loadInstalled();
        
        const apps = await Promise.all(
            Object.keys(installed.apps).map(async (appId) => {
                const appDef = catalog.apps.find(a => a.id === appId);
                const status = await getContainerStatus(appId);
                const stats = status === 'running' ? await getContainerStats(appId) : null;
                
                return {
                    ...appDef,
                    ...installed.apps[appId],
                    status,
                    stats
                };
            })
        );
        
        res.json({ success: true, apps });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /homestore/app/:id - Get app details
router.get('/app/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const catalog = await loadCatalog();
        const installed = await loadInstalled();
        
        const app = catalog.apps.find(a => a.id === id);
        if (!app) {
            return res.status(404).json({ success: false, error: 'App not found' });
        }
        
        const status = await getContainerStatus(id);
        const stats = status === 'running' ? await getContainerStats(id) : null;
        
        res.json({
            success: true,
            app: {
                ...app,
                installed: !!installed.apps[id],
                status,
                stats,
                installedAt: installed.apps[id]?.installedAt,
                config: installed.apps[id]?.config
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /homestore/install/:id - Install an app
router.post('/install/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { config } = req.body || {};
        
        // Check Docker
        if (!await checkDocker()) {
            return res.status(400).json({ success: false, error: 'Docker is not available' });
        }
        
        const catalog = await loadCatalog();
        const installed = await loadInstalled();
        
        const app = catalog.apps.find(a => a.id === id);
        if (!app) {
            return res.status(404).json({ success: false, error: 'App not found' });
        }
        
        if (installed.apps[id]) {
            return res.status(400).json({ success: false, error: 'App is already installed' });
        }
        
        // Create app directories
        for (const [containerPath, hostPath] of Object.entries(app.volumes)) {
            if (!hostPath.includes('.sock')) { // Don't create docker.sock
                await fs.mkdir(hostPath, { recursive: true }).catch(() => {});
            }
        }
        
        // Build docker run command
        let cmd = `docker run -d --name homestore-${id} --restart unless-stopped`;
        
        // Add ports
        if (app.ports) {
            for (const [host, container] of Object.entries(app.ports)) {
                cmd += ` -p ${host}:${container}`;
            }
        }
        
        // Add volumes
        if (app.volumes) {
            for (const [container, host] of Object.entries(app.volumes)) {
                cmd += ` -v ${host}:${container}`;
            }
        }
        
        // Add environment variables (merge defaults with user config)
        const envVars = { ...app.env, ...(config?.env || {}) };
        for (const [key, value] of Object.entries(envVars)) {
            cmd += ` -e ${key}="${value}"`;
        }
        
        // Add capabilities
        if (app.capabilities) {
            for (const cap of app.capabilities) {
                cmd += ` --cap-add=${cap}`;
            }
        }
        
        // Add sysctls
        if (app.sysctls) {
            for (const [key, value] of Object.entries(app.sysctls)) {
                cmd += ` --sysctl ${key}=${value}`;
            }
        }
        
        // Add privileged if needed
        if (app.privileged) {
            cmd += ' --privileged';
        }
        
        // Add image
        cmd += ` ${app.image}`;
        
        console.log('Installing app:', cmd);
        
        // Execute
        await new Promise((resolve, reject) => {
            exec(cmd, { timeout: 300000 }, (err, stdout, stderr) => {
                if (err) {
                    console.error('Install error:', stderr);
                    reject(new Error(stderr || err.message));
                } else {
                    resolve(stdout);
                }
            });
        });
        
        // Save to installed
        installed.apps[id] = {
            installedAt: new Date().toISOString(),
            config: config || {}
        };
        await saveInstalled(installed);
        
        res.json({
            success: true,
            message: `${app.name} installed successfully`,
            webUI: app.webUI ? `http://localhost:${app.webUI}` : null
        });
        
    } catch (error) {
        console.error('Install error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /homestore/uninstall/:id - Uninstall an app
router.post('/uninstall/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { removeData } = req.body || {};
        
        const catalog = await loadCatalog();
        const installed = await loadInstalled();
        
        const app = catalog.apps.find(a => a.id === id);
        if (!app) {
            return res.status(404).json({ success: false, error: 'App not found' });
        }
        
        if (!installed.apps[id]) {
            return res.status(400).json({ success: false, error: 'App is not installed' });
        }
        
        // Stop and remove container
        await new Promise((resolve) => {
            exec(`docker stop homestore-${id} && docker rm homestore-${id}`, (err) => {
                resolve(); // Continue even if error (container might not exist)
            });
        });
        
        // Optionally remove data
        if (removeData) {
            const appDir = `${APPS_BASE}/${id}`;
            await new Promise((resolve) => {
                exec(`rm -rf "${appDir}"`, (err) => resolve());
            });
        }
        
        // Remove from installed
        delete installed.apps[id];
        await saveInstalled(installed);
        
        res.json({
            success: true,
            message: `${app.name} uninstalled successfully`
        });
        
    } catch (error) {
        console.error('Uninstall error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /homestore/start/:id - Start an app
router.post('/start/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        await new Promise((resolve, reject) => {
            exec(`docker start homestore-${id}`, (err, stdout, stderr) => {
                if (err) reject(new Error(stderr || err.message));
                else resolve();
            });
        });
        
        res.json({ success: true, message: 'App started' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /homestore/stop/:id - Stop an app
router.post('/stop/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        await new Promise((resolve, reject) => {
            exec(`docker stop homestore-${id}`, (err, stdout, stderr) => {
                if (err) reject(new Error(stderr || err.message));
                else resolve();
            });
        });
        
        res.json({ success: true, message: 'App stopped' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /homestore/restart/:id - Restart an app
router.post('/restart/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        await new Promise((resolve, reject) => {
            exec(`docker restart homestore-${id}`, (err, stdout, stderr) => {
                if (err) reject(new Error(stderr || err.message));
                else resolve();
            });
        });
        
        res.json({ success: true, message: 'App restarted' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /homestore/logs/:id - Get app logs
router.get('/logs/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const lines = req.query.lines || 100;
        
        const logs = await new Promise((resolve, reject) => {
            exec(`docker logs homestore-${id} --tail ${lines} 2>&1`, (err, stdout) => {
                if (err) reject(new Error(err.message));
                else resolve(stdout);
            });
        });
        
        res.json({ success: true, logs });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /homestore/update/:id - Update an app (pull new image and recreate)
router.post('/update/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        const catalog = await loadCatalog();
        const installed = await loadInstalled();
        
        const app = catalog.apps.find(a => a.id === id);
        if (!app) {
            return res.status(404).json({ success: false, error: 'App not found' });
        }
        
        if (!installed.apps[id]) {
            return res.status(400).json({ success: false, error: 'App is not installed' });
        }
        
        // Pull new image
        await new Promise((resolve, reject) => {
            exec(`docker pull ${app.image}`, { timeout: 600000 }, (err, stdout, stderr) => {
                if (err) reject(new Error(stderr || err.message));
                else resolve();
            });
        });
        
        // Stop and remove old container
        await new Promise((resolve) => {
            exec(`docker stop homestore-${id} && docker rm homestore-${id}`, () => resolve());
        });
        
        // Reinstall with same config
        const config = installed.apps[id].config;
        
        // Build docker run command (same as install)
        let cmd = `docker run -d --name homestore-${id} --restart unless-stopped`;
        
        if (app.ports) {
            for (const [host, container] of Object.entries(app.ports)) {
                cmd += ` -p ${host}:${container}`;
            }
        }
        
        if (app.volumes) {
            for (const [container, host] of Object.entries(app.volumes)) {
                cmd += ` -v ${host}:${container}`;
            }
        }
        
        const envVars = { ...app.env, ...(config?.env || {}) };
        for (const [key, value] of Object.entries(envVars)) {
            cmd += ` -e ${key}="${value}"`;
        }
        
        if (app.capabilities) {
            for (const cap of app.capabilities) {
                cmd += ` --cap-add=${cap}`;
            }
        }
        
        if (app.sysctls) {
            for (const [key, value] of Object.entries(app.sysctls)) {
                cmd += ` --sysctl ${key}=${value}`;
            }
        }
        
        if (app.privileged) {
            cmd += ' --privileged';
        }
        
        cmd += ` ${app.image}`;
        
        await new Promise((resolve, reject) => {
            exec(cmd, { timeout: 300000 }, (err, stdout, stderr) => {
                if (err) reject(new Error(stderr || err.message));
                else resolve();
            });
        });
        
        // Update installed timestamp
        installed.apps[id].updatedAt = new Date().toISOString();
        await saveInstalled(installed);
        
        res.json({ success: true, message: `${app.name} updated successfully` });
        
    } catch (error) {
        console.error('Update error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /homestore/check-docker - Check if Docker is available
router.get('/check-docker', async (req, res) => {
    const available = await checkDocker();
    res.json({ success: true, available });
});

module.exports = router;
