/**
 * HomePiNAS - VPN Routes Tests
 * Tests for WireGuard VPN management endpoints
 *
 * Covers: GET /status, POST /install, POST /start, POST /stop,
 *         POST /clients (name validation, duplicates), DELETE /clients/:id,
 *         PUT /config (port validation), RBAC (admin only)
 */

const express = require('express');
const request = require('supertest');

// Mock fs
jest.mock('fs', () => {
    const actual = jest.requireActual('fs');
    return {
        ...actual,
        writeFileSync: jest.fn(),
        unlinkSync: jest.fn(),
        readFileSync: jest.fn(() => ''),
        existsSync: jest.fn(() => true)
    };
});

// Mock child_process
jest.mock('child_process', () => ({
    execFile: jest.fn((cmd, args, opts, cb) => {
        // Handle both (cmd, args, cb) and (cmd, args, opts, cb) signatures
        const callback = typeof opts === 'function' ? opts : cb;
        if (callback) callback(null, '', '');
        return { stdout: '', stderr: '' };
    }),
    spawn: jest.fn(() => ({
        stdin: { write: jest.fn(), end: jest.fn() },
        stdout: { on: jest.fn((event, cb) => { if (event === 'data') cb('mockPublicKey123='); }) },
        stderr: { on: jest.fn() },
        on: jest.fn((event, cb) => {
            if (event === 'close') setTimeout(() => cb(0), 0);
        }),
        kill: jest.fn()
    }))
}));

// Mutable flag to control whether WireGuard appears "installed"
let mockWgInstalled = true;

// Mock util.promisify to return appropriate responses
jest.mock('util', () => ({
    ...jest.requireActual('util'),
    promisify: jest.fn((fn) => (...args) => {
        const cmd = args[0];
        const cmdArgs = args[1] || [];

        // which wg → check mutable flag
        if (cmd === 'which') {
            if (!mockWgInstalled) {
                return Promise.reject(new Error('not found'));
            }
            return Promise.resolve({ stdout: '/usr/bin/wg', stderr: '' });
        }
        // systemctl is-active
        if (cmd === 'systemctl' && cmdArgs[0] === 'is-active') {
            return Promise.resolve({ stdout: 'active', stderr: '' });
        }
        // systemctl is-enabled
        if (cmd === 'systemctl' && cmdArgs[0] === 'is-enabled') {
            return Promise.resolve({ stdout: 'enabled', stderr: '' });
        }
        // wg genkey
        if (cmd === 'wg' && cmdArgs[0] === 'genkey') {
            return Promise.resolve({ stdout: 'cFakePrivateKeyBase64String1234567890abc=\n', stderr: '' });
        }
        // wg genpsk
        if (cmd === 'wg' && cmdArgs[0] === 'genpsk') {
            return Promise.resolve({ stdout: 'cFakePresharedKeyBase64String1234567890=\n', stderr: '' });
        }
        // wg show dump
        if (cmd === 'wg' || (typeof cmd === 'string' && cmd.includes('wg'))) {
            return Promise.resolve({ stdout: '', stderr: '' });
        }
        // ip route show default
        if (cmd === 'ip') {
            return Promise.resolve({ stdout: 'default via 192.168.1.1 dev end0 proto static', stderr: '' });
        }
        return Promise.resolve({ stdout: '', stderr: '' });
    })
}));

// Mock os
jest.mock('os', () => ({
    ...jest.requireActual('os'),
    networkInterfaces: jest.fn(() => ({
        end0: [
            { address: '192.168.1.100', family: 'IPv4', internal: false },
            { address: 'fe80::1', family: 'IPv6', internal: false }
        ],
        lo: [
            { address: '127.0.0.1', family: 'IPv4', internal: true }
        ]
    }))
}));

// Mock data utils
jest.mock('../../utils/data', () => ({
    getData: jest.fn(() => ({
        user: { username: 'testadmin', role: 'admin' },
        users: [],
        vpn: {
            installed: true,
            port: 51820,
            dns: '1.1.1.1, 8.8.8.8',
            subnet: '10.66.66.0/24',
            endpoint: 'vpn.example.com',
            serverPublicKey: 'serverPubKey123=',
            clients: []
        }
    })),
    saveData: jest.fn()
}));

// Mock security
jest.mock('../../utils/security', () => ({
    logSecurityEvent: jest.fn(),
    safeExec: jest.fn(() => Promise.resolve({ stdout: '', stderr: '' })),
    sudoExec: jest.fn(() => Promise.resolve({ stdout: '', stderr: '' }))
}));

// Mock auth middleware
jest.mock('../../middleware/auth', () => ({
    requireAuth: (req, res, next) => {
        req.user = { username: 'testadmin', role: 'admin' };
        next();
    }
}));

// Mock rbac middleware - admin by default
jest.mock('../../middleware/rbac', () => ({
    requireAdmin: (req, res, next) => {
        // Check user role from data for realism
        const { getData } = require('../../utils/data');
        const data = getData();
        const username = req.user?.username;

        // Primary admin check
        if (data.user && data.user.username === username) {
            req.user.role = 'admin';
            req.user.permissions = ['read', 'write', 'delete', 'admin'];
            return next();
        }

        // Multi-user check
        const users = data.users || [];
        const user = users.find(u => u.username === username);
        if (user && user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        req.user.role = 'admin';
        req.user.permissions = ['read', 'write', 'delete', 'admin'];
        next();
    },
    requirePermission: jest.fn(() => (req, res, next) => next()),
    getUserRole: jest.fn(() => 'admin')
}));

// Mock global fetch (for getPublicIP)
global.fetch = jest.fn(() => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ ip: '203.0.113.1' })
}));

const fs = require('fs');
const { getData, saveData } = require('../../utils/data');
const { logSecurityEvent, sudoExec } = require('../../utils/security');

// Suppress console during tests
beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
    console.log.mockRestore();
    console.error.mockRestore();
    console.warn.mockRestore();
});

// Create Express app
const vpnRouter = require('../../routes/vpn');
const app = express();
app.use(express.json());
app.use('/api/vpn', vpnRouter);

// ============================================================================
// GET /status
// ============================================================================

describe('GET /api/vpn/status', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        getData.mockReturnValue({
            user: { username: 'testadmin', role: 'admin' },
            users: [],
            vpn: {
                installed: true,
                port: 51820,
                dns: '1.1.1.1, 8.8.8.8',
                subnet: '10.66.66.0/24',
                endpoint: 'vpn.example.com',
                serverPublicKey: 'serverPubKey123=',
                clients: []
            }
        });
    });

    test('returns VPN status when installed', async () => {
        const res = await request(app).get('/api/vpn/status');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body).toHaveProperty('installed');
        expect(res.body).toHaveProperty('service');
        expect(res.body).toHaveProperty('running');
        expect(res.body).toHaveProperty('port');
        expect(res.body).toHaveProperty('dns');
        expect(res.body).toHaveProperty('clients');
        expect(res.body).toHaveProperty('connectedPeers');
    });

    test('returns client list without private keys', async () => {
        getData.mockReturnValue({
            user: { username: 'testadmin', role: 'admin' },
            users: [],
            vpn: {
                installed: true,
                port: 51820,
                dns: '1.1.1.1',
                subnet: '10.66.66.0/24',
                endpoint: 'vpn.example.com',
                serverPublicKey: 'serverPubKey=',
                clients: [{
                    id: 'abc123',
                    name: 'phone',
                    address: '10.66.66.2',
                    publicKey: 'clientPubKey=',
                    presharedKey: 'psk=',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    revoked: false
                }]
            }
        });

        const res = await request(app).get('/api/vpn/status');

        expect(res.status).toBe(200);
        expect(res.body.clients).toHaveLength(1);
        expect(res.body.clients[0].name).toBe('phone');
        expect(res.body.clients[0].address).toBe('10.66.66.2');
        // SECURITY: No private key exposed
        expect(res.body.clients[0]).not.toHaveProperty('privateKey');
    });

    test('initializes default config when vpn not in data', async () => {
        getData.mockReturnValue({
            user: { username: 'testadmin', role: 'admin' },
            users: []
        });

        const res = await request(app).get('/api/vpn/status');

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('port');
    });
});

// ============================================================================
// POST /install
// ============================================================================

describe('POST /api/vpn/install', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        getData.mockReturnValue({
            user: { username: 'testadmin', role: 'admin' },
            users: [],
            vpn: {
                installed: false,
                port: 51820,
                dns: '1.1.1.1, 8.8.8.8',
                subnet: '10.66.66.0/24',
                endpoint: '',
                serverPublicKey: '',
                clients: []
            }
        });
    });

    test('installs WireGuard successfully', async () => {
        // WireGuard not installed yet
        mockWgInstalled = false;

        const res = await request(app).post('/api/vpn/install');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(sudoExec).toHaveBeenCalled();

        // Restore
        mockWgInstalled = true;
    });

    test('returns success if already installed', async () => {
        // WireGuard already installed
        mockWgInstalled = true;

        const res = await request(app).post('/api/vpn/install');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.message).toContain('ya está instalado');
    });
});

// ============================================================================
// POST /start
// ============================================================================

describe('POST /api/vpn/start', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        getData.mockReturnValue({
            user: { username: 'testadmin', role: 'admin' },
            users: [],
            vpn: {
                installed: true,
                port: 51820,
                dns: '1.1.1.1',
                subnet: '10.66.66.0/24',
                endpoint: 'vpn.example.com',
                serverPublicKey: 'key=',
                clients: []
            }
        });
    });

    test('starts VPN service', async () => {
        const res = await request(app).post('/api/vpn/start');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.message).toContain('activado');
        expect(sudoExec).toHaveBeenCalledWith('systemctl', ['enable', 'wg-quick@wg0']);
        expect(sudoExec).toHaveBeenCalledWith('systemctl', ['start', 'wg-quick@wg0']);
        expect(logSecurityEvent).toHaveBeenCalledWith('vpn_started', expect.anything());
    });

    test('rejects start when not installed', async () => {
        // WireGuard not installed
        mockWgInstalled = false;

        const res = await request(app).post('/api/vpn/start');

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toContain('no está instalado');

        // Restore
        mockWgInstalled = true;
    });
});

// ============================================================================
// POST /stop
// ============================================================================

describe('POST /api/vpn/stop', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        getData.mockReturnValue({
            user: { username: 'testadmin', role: 'admin' },
            users: [],
            vpn: {
                installed: true,
                port: 51820,
                dns: '1.1.1.1',
                subnet: '10.66.66.0/24',
                endpoint: 'vpn.example.com',
                serverPublicKey: 'key=',
                clients: []
            }
        });
    });

    test('stops VPN service', async () => {
        const res = await request(app).post('/api/vpn/stop');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.message).toContain('detenido');
        expect(sudoExec).toHaveBeenCalledWith('systemctl', ['stop', 'wg-quick@wg0']);
        expect(sudoExec).toHaveBeenCalledWith('systemctl', ['disable', 'wg-quick@wg0']);
        expect(logSecurityEvent).toHaveBeenCalledWith('vpn_stopped', expect.anything());
    });
});

// ============================================================================
// POST /clients
// ============================================================================

describe('POST /api/vpn/clients', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        getData.mockReturnValue({
            user: { username: 'testadmin', role: 'admin' },
            users: [],
            vpn: {
                installed: true,
                port: 51820,
                dns: '1.1.1.1, 8.8.8.8',
                subnet: '10.66.66.0/24',
                endpoint: 'vpn.example.com',
                serverPublicKey: 'serverPubKey=',
                clients: []
            }
        });
        // Mock sudoExec for readServerPrivateKey
        sudoExec.mockImplementation((cmd, args) => {
            if (cmd === 'cat' && args && args[0] && args[0].includes('wg0.conf')) {
                return Promise.resolve({ stdout: 'PrivateKey = fakeServerPrivateKey=\n', stderr: '' });
            }
            return Promise.resolve({ stdout: '', stderr: '' });
        });
    });

    test('creates new client successfully', async () => {
        const res = await request(app)
            .post('/api/vpn/clients')
            .send({ name: 'my-phone' });

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.client).toHaveProperty('id');
        expect(res.body.client).toHaveProperty('name', 'my-phone');
        expect(res.body.client).toHaveProperty('address');
        expect(res.body).toHaveProperty('config');
        expect(saveData).toHaveBeenCalled();
        expect(logSecurityEvent).toHaveBeenCalledWith('vpn_client_created', expect.anything());
    });

    test('client config does not contain private key in response metadata', async () => {
        const res = await request(app)
            .post('/api/vpn/clients')
            .send({ name: 'laptop' });

        expect(res.status).toBe(201);
        // The client metadata in response should NOT have privateKey
        expect(res.body.client).not.toHaveProperty('privateKey');
        // But the config string should exist (for download/QR)
        expect(res.body.config).toBeTruthy();
    });

    test('rejects missing name', async () => {
        const res = await request(app)
            .post('/api/vpn/clients')
            .send({});

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toContain('requerido');
    });

    test('rejects empty name', async () => {
        const res = await request(app)
            .post('/api/vpn/clients')
            .send({ name: '' });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    test('rejects invalid characters in name', async () => {
        const res = await request(app)
            .post('/api/vpn/clients')
            .send({ name: 'my phone!' });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toContain('inválido');
    });

    test('rejects name with spaces', async () => {
        const res = await request(app)
            .post('/api/vpn/clients')
            .send({ name: 'my phone' });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    test('rejects name longer than 32 characters', async () => {
        const res = await request(app)
            .post('/api/vpn/clients')
            .send({ name: 'a'.repeat(33) });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    test('allows valid names with hyphens and underscores', async () => {
        const res = await request(app)
            .post('/api/vpn/clients')
            .send({ name: 'my_phone-2' });

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.client.name).toBe('my_phone-2');
    });

    test('rejects duplicate client name', async () => {
        getData.mockReturnValue({
            user: { username: 'testadmin', role: 'admin' },
            users: [],
            vpn: {
                installed: true,
                port: 51820,
                dns: '1.1.1.1',
                subnet: '10.66.66.0/24',
                endpoint: 'vpn.example.com',
                serverPublicKey: 'key=',
                clients: [{
                    id: 'existing1',
                    name: 'phone',
                    publicKey: 'existingPubKey=',
                    presharedKey: 'existingPsk=',
                    address: '10.66.66.2',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    revoked: false
                }]
            }
        });

        const res = await request(app)
            .post('/api/vpn/clients')
            .send({ name: 'phone' });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toContain('Ya existe');
    });

    test('allows same name if previous client was revoked', async () => {
        getData.mockReturnValue({
            user: { username: 'testadmin', role: 'admin' },
            users: [],
            vpn: {
                installed: true,
                port: 51820,
                dns: '1.1.1.1',
                subnet: '10.66.66.0/24',
                endpoint: 'vpn.example.com',
                serverPublicKey: 'key=',
                clients: [{
                    id: 'revoked1',
                    name: 'phone',
                    publicKey: 'oldPubKey=',
                    presharedKey: 'oldPsk=',
                    address: '10.66.66.2',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    revoked: true
                }]
            }
        });

        const res = await request(app)
            .post('/api/vpn/clients')
            .send({ name: 'phone' });

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
    });

    test('assigns correct sequential IP addresses', async () => {
        getData.mockReturnValue({
            user: { username: 'testadmin', role: 'admin' },
            users: [],
            vpn: {
                installed: true,
                port: 51820,
                dns: '1.1.1.1',
                subnet: '10.66.66.0/24',
                endpoint: 'vpn.example.com',
                serverPublicKey: 'key=',
                clients: [{
                    id: 'c1',
                    name: 'client1',
                    publicKey: 'pk1=',
                    presharedKey: 'psk1=',
                    address: '10.66.66.2',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    revoked: false
                }]
            }
        });

        const res = await request(app)
            .post('/api/vpn/clients')
            .send({ name: 'client2' });

        expect(res.status).toBe(201);
        // Should get .3 since .2 is taken
        expect(res.body.client.address).toBe('10.66.66.3');
    });
});

// ============================================================================
// DELETE /clients/:id
// ============================================================================

describe('DELETE /api/vpn/clients/:id', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        getData.mockReturnValue({
            user: { username: 'testadmin', role: 'admin' },
            users: [],
            vpn: {
                installed: true,
                port: 51820,
                dns: '1.1.1.1',
                subnet: '10.66.66.0/24',
                endpoint: 'vpn.example.com',
                serverPublicKey: 'key=',
                clients: [{
                    id: 'client-abc',
                    name: 'my-phone',
                    publicKey: 'clientPubKey=',
                    presharedKey: 'clientPsk=',
                    address: '10.66.66.2',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    revoked: false
                }]
            }
        });
        sudoExec.mockImplementation((cmd, args) => {
            if (cmd === 'cat' && args && args[0] && args[0].includes('wg0.conf')) {
                return Promise.resolve({ stdout: 'PrivateKey = fakeServerPrivateKey=\n', stderr: '' });
            }
            return Promise.resolve({ stdout: '', stderr: '' });
        });
    });

    test('revokes client successfully', async () => {
        const res = await request(app)
            .delete('/api/vpn/clients/client-abc');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.message).toContain('my-phone');
        expect(res.body.message).toContain('revocado');
        expect(saveData).toHaveBeenCalled();
        expect(logSecurityEvent).toHaveBeenCalledWith('vpn_client_revoked', expect.anything());
    });

    test('returns 404 for non-existent client', async () => {
        const res = await request(app)
            .delete('/api/vpn/clients/nonexistent-id');

        expect(res.status).toBe(404);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toContain('no encontrado');
    });

    test('deletes client config file from disk', async () => {
        await request(app)
            .delete('/api/vpn/clients/client-abc');

        // Should call sudoExec to overwrite/delete the client conf file
        expect(sudoExec).toHaveBeenCalledWith(
            'tee',
            [expect.stringContaining('my-phone.conf')],
            expect.anything()
        );
    });
});

// ============================================================================
// PUT /config
// ============================================================================

describe('PUT /api/vpn/config', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        getData.mockReturnValue({
            user: { username: 'testadmin', role: 'admin' },
            users: [],
            vpn: {
                installed: true,
                port: 51820,
                dns: '1.1.1.1, 8.8.8.8',
                subnet: '10.66.66.0/24',
                endpoint: 'vpn.example.com',
                serverPublicKey: 'key=',
                clients: []
            }
        });
        sudoExec.mockImplementation((cmd, args) => {
            if (cmd === 'cat' && args && args[0] && args[0].includes('wg0.conf')) {
                return Promise.resolve({ stdout: 'PrivateKey = fakeServerKey=\n', stderr: '' });
            }
            return Promise.resolve({ stdout: '', stderr: '' });
        });
    });

    test('updates port successfully', async () => {
        const res = await request(app)
            .put('/api/vpn/config')
            .send({ port: 51821 });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.message).toContain('actualizada');
        expect(saveData).toHaveBeenCalled();
        expect(logSecurityEvent).toHaveBeenCalledWith('vpn_config_updated', expect.anything());
    });

    test('updates DNS successfully', async () => {
        const res = await request(app)
            .put('/api/vpn/config')
            .send({ dns: '8.8.8.8, 8.8.4.4' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    test('updates endpoint successfully', async () => {
        const res = await request(app)
            .put('/api/vpn/config')
            .send({ endpoint: 'new-vpn.example.com' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    test('rejects port below 1024', async () => {
        const res = await request(app)
            .put('/api/vpn/config')
            .send({ port: 80 });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toContain('Puerto inválido');
    });

    test('rejects port above 65535', async () => {
        const res = await request(app)
            .put('/api/vpn/config')
            .send({ port: 70000 });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toContain('Puerto inválido');
    });

    test('rejects non-numeric port', async () => {
        const res = await request(app)
            .put('/api/vpn/config')
            .send({ port: 'abc' });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    test('rejects DNS longer than 200 characters', async () => {
        const res = await request(app)
            .put('/api/vpn/config')
            .send({ dns: 'a'.repeat(201) });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toContain('DNS inválido');
    });

    test('rejects endpoint longer than 253 characters', async () => {
        const res = await request(app)
            .put('/api/vpn/config')
            .send({ endpoint: 'a'.repeat(254) });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toContain('Endpoint inválido');
    });
});

// ============================================================================
// RBAC - Admin only
// ============================================================================

describe('RBAC - Admin middleware', () => {
    test('rejects non-admin users', async () => {
        // Override rbac mock to simulate non-admin
        const { requireAdmin } = require('../../middleware/rbac');

        // Temporarily change getData to return non-admin user
        getData.mockReturnValue({
            user: { username: 'otheradmin', role: 'admin' },
            users: [{ username: 'testadmin', role: 'user' }]
        });

        const res = await request(app).get('/api/vpn/status');

        expect(res.status).toBe(403);
        expect(res.body.error).toContain('Admin');
    });
});

// ============================================================================
// POST /uninstall
// ============================================================================

describe('POST /api/vpn/uninstall', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        getData.mockReturnValue({
            user: { username: 'testadmin', role: 'admin' },
            users: [],
            vpn: {
                installed: true,
                port: 51820,
                dns: '1.1.1.1',
                subnet: '10.66.66.0/24',
                endpoint: 'vpn.example.com',
                serverPublicKey: 'key=',
                clients: [{ id: 'c1', name: 'phone', revoked: false }]
            }
        });
    });

    test('uninstalls WireGuard successfully', async () => {
        const res = await request(app).post('/api/vpn/uninstall');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.message).toContain('desinstalado');
        expect(sudoExec).toHaveBeenCalledWith('systemctl', ['stop', 'wg-quick@wg0']);
        expect(sudoExec).toHaveBeenCalledWith('systemctl', ['disable', 'wg-quick@wg0']);
        expect(sudoExec).toHaveBeenCalledWith(
            'apt-get',
            ['remove', '-y', '-o', 'Dpkg::Options::=--force-confold', 'wireguard', 'wireguard-tools'],
            expect.objectContaining({ timeout: 120000 })
        );
        expect(saveData).toHaveBeenCalled();
        expect(logSecurityEvent).toHaveBeenCalledWith('vpn_uninstalled', expect.anything());
    });
});
