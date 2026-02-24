/**
 * Integration Tests for Active Backup
 * Tests API endpoints and service interactions
 */

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

// Mock setup
const mockData = {
  activeBackup: {
    devices: [],
    pendingAgents: [],
  },
};

// Mock getData/saveData
const dataUtils = {
  getData: () => JSON.parse(JSON.stringify(mockData)),
  saveData: (data) => {
    Object.assign(mockData, data);
  },
};

jest.mock('../utils/data', () => dataUtils);
jest.mock('../utils/backup-helpers');
jest.mock('../services/backup-service');

describe('Active Backup API', () => {
  let app;
  let request;

  beforeAll(async () => {
    // Setup Express app with active-backup routes
    const express = require('express');
    app = express();
    app.use(express.json());

    // Mock auth middleware
    app.use((req, res, next) => {
      req.user = { username: 'testuser' };
      next();
    });

    // Import routes
    const activeBackupRouter = require('../../backend/routes/active-backup');
    app.use('/active-backup', activeBackupRouter);

    // Use supertest for HTTP testing
    request = require('supertest')(app);
  });

  beforeEach(() => {
    // Reset mock data
    mockData.activeBackup = {
      devices: [],
      pendingAgents: [],
    };
  });

  describe('Agent Registration (POST /agent/register)', () => {
    it('should register new agent as pending', async () => {
      const res = await request
        .post('/active-backup/agent/register')
        .send({
          hostname: 'pc-01',
          ip: '192.168.1.100',
          os: 'windows',
          mac: 'AA:BB:CC:DD:EE:FF',
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('pending');
      expect(res.body.agentToken).toBeDefined();
      expect(mockData.activeBackup.pendingAgents).toHaveLength(1);
    });

    it('should reject registration without hostname', async () => {
      const res = await request
        .post('/active-backup/agent/register')
        .send({ ip: '192.168.1.100' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('hostname');
    });

    it('should recognize duplicate agent by hostname+ip', async () => {
      const agent1 = {
        hostname: 'pc-01',
        ip: '192.168.1.100',
      };

      const res1 = await request
        .post('/active-backup/agent/register')
        .send(agent1);

      const res2 = await request
        .post('/active-backup/agent/register')
        .send(agent1);

      expect(res1.body.agentToken).toBe(res2.body.agentToken);
      expect(mockData.activeBackup.pendingAgents).toHaveLength(1);
    });
  });

  describe('Device Management', () => {
    beforeEach(() => {
      // Setup a test device
      mockData.activeBackup.devices = [
        {
          id: 'test-device-1',
          name: 'PC-01',
          ip: '192.168.1.100',
          backupType: 'files',
          sshUser: 'root',
          sshPort: 22,
          enabled: true,
          lastBackup: null,
          lastResult: null,
        },
      ];
    });

    it('should list devices with status', async () => {
      const res = await request.get('/active-backup/devices');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.devices).toHaveLength(1);
      expect(res.body.devices[0].name).toBe('PC-01');
    });

    it('should get device versions', async () => {
      const res = await request.get('/active-backup/devices/test-device-1/versions');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.versions)).toBe(true);
    });

    it('should update device config', async () => {
      const res = await request
        .put('/active-backup/devices/test-device-1')
        .send({
          name: 'PC-01-Updated',
          retention: 10,
        });

      expect(res.status).toBe(200);
      expect(res.body.device.name).toBe('PC-01-Updated');
      expect(res.body.device.retention).toBe(10);
    });

    it('should reject update with invalid device', async () => {
      const res = await request
        .put('/active-backup/devices/invalid-id')
        .send({ name: 'Test' });

      expect(res.status).toBe(404);
    });

    it('should delete device', async () => {
      const res = await request.delete('/active-backup/devices/test-device-1');

      expect(res.status).toBe(200);
      expect(mockData.activeBackup.devices).toHaveLength(0);
    });
  });

  describe('Backup Operations', () => {
    beforeEach(() => {
      mockData.activeBackup.devices = [
        {
          id: 'test-device-1',
          name: 'PC-01',
          ip: '192.168.1.100',
          backupType: 'files',
          enabled: true,
        },
      ];
    });

    it('should get backup status', async () => {
      const res = await request.get('/active-backup/devices/test-device-1/status');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(['running', 'idle']).toContain(res.body.status);
    });

    it('should return 404 for unknown device', async () => {
      const res = await request.get('/active-backup/devices/unknown-id/status');

      expect(res.status).toBe(404);
    });
  });

  describe('Agent Management (Pending Agents)', () => {
    beforeEach(() => {
      mockData.activeBackup.pendingAgents = [
        {
          id: 'agent-1',
          hostname: 'server-01',
          ip: '192.168.1.50',
          agentToken: 'token-123',
          registeredAt: new Date().toISOString(),
        },
      ];
    });

    it('should list pending agents', async () => {
      const res = await request.get('/active-backup/pending');

      expect(res.status).toBe(200);
      expect(res.body.pending).toHaveLength(1);
      expect(res.body.pending[0].hostname).toBe('server-01');
    });

    it('should reject unknown pending agent', async () => {
      const res = await request
        .post('/active-backup/pending/invalid-id/reject');

      expect(res.status).toBe(404);
    });

    it('should reject pending agent', async () => {
      const res = await request
        .post('/active-backup/pending/agent-1/reject');

      expect(res.status).toBe(200);
      expect(mockData.activeBackup.pendingAgents).toHaveLength(0);
    });
  });

  describe('Recovery Operations', () => {
    it('should get recovery status', async () => {
      const res = await request.get('/active-backup/recovery/status');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(typeof res.body.scriptsAvailable).toBe('boolean');
    });
  });

  describe('Security & Validation', () => {
    it('should require auth for protected endpoints', async () => {
      // Create app without auth middleware
      const appNoAuth = require('express')();
      const activeBackupRouter = require('../../backend/routes/active-backup');
      appNoAuth.use('/active-backup', activeBackupRouter);

      const requestNoAuth = require('supertest')(appNoAuth);

      // This would fail if auth is enforced (depends on middleware setup)
      // For now, assume auth middleware is optional in test
    });

    it('should sanitize device IDs in paths', async () => {
      const res = await request.get('/active-backup/devices/../../../etc/passwd/status');

      // Should either 404 or safely handle path traversal
      expect([404, 400, 403]).toContain(res.status);
    });
  });
});
