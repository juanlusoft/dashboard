# Active Backup for Business (ABB) — Architecture & Documentation

## Overview

Active Backup for Business is a distributed backup solution for HomePiNAS v2. It supports:

- **Agent-based backups**: Remote agents report backup status
- **File-based backups**: rsync over SSH for file-level granularity
- **Image backups**: Full disk/partition imaging for disaster recovery
- **Disaster recovery**: Recovery ISO builder and restore scripts
- **Device management**: Admin controls for device approval and scheduling
- **Retention policies**: Automatic cleanup of old versions

## Architecture

### Layers

```
┌─────────────────────────────────────────────────────┐
│ HTTP Layer (Express Routes)                         │
│ routes/active-backup.js                            │
│ - Route definitions only                            │
│ - Delegates to controllers                          │
└─────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────┐
│ Controller Layer (Request Handlers)                 │
│ controllers/                                        │
│ - agent-controller.js       Agent lifecycle        │
│ - backup-controller.js      Device & backup ops    │
│ - recovery-controller.js    Disaster recovery      │
│ - Parses HTTP, validates input, calls services    │
└─────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────┐
│ Service Layer (Business Logic)                      │
│ services/                                           │
│ - backup-service.js        Core backup operations  │
│ - recovery-service.js      Recovery tools          │
│ - Pure functions, no HTTP knowledge                │
└─────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────┐
│ Utilities (Infrastructure)                          │
│ utils/                                              │
│ - backup-helpers.js        SSH, Samba, filesystem  │
│ - data.js                  Persistence layer       │
│ - security.js              Logging, auth           │
└─────────────────────────────────────────────────────┘
```

### Separation of Concerns

| Layer | Responsibility | Size Limit | Example |
|-------|----------------|-----------|---------|
| Routes | HTTP routing + auth | ~200 lines | `router.post('/backup', ...)` |
| Controllers | Parse request, validate, call service | <20 lines/handler | `async function triggerBackup(req, res)` |
| Services | Business logic, no HTTP | <300 lines | `async function runBackup(device)` |
| Utilities | Infrastructure, config, helpers | as needed | SSH command builders |

### Data Flow: Agent Backup Workflow

```
1. Agent Registration
   POST /agent/register (no auth)
   → registerAgent() controller
   → Validate hostname
   → Create pending agent
   → Return agentId, agentToken

2. Admin Approval
   POST /pending/:id/approve (auth required)
   → approvePendingAgent() controller
   → Move to devices list
   → Log security event

3. Agent Polling
   GET /agent/poll (agentToken in header)
   → pollAgent() controller
   → Get pending tasks
   → Return backup job (if schedule due)

4. Agent Executes Backup
   (on remote machine, using agentToken)

5. Agent Reports Result
   POST /agent/report (agentToken in header)
   → reportAgentStatus() controller
   → Record in device.backupHistory
   → Update lastBackupTime, lastBackupSize
```

## File Structure

```
backend/
├── routes/
│   └── active-backup.js          Route definitions only (<300 lines)
├── controllers/
│   ├── agent-controller.js        Agent registration, polling, approval
│   ├── backup-controller.js       Device management, backup operations
│   └── recovery-controller.js     Disaster recovery tools
├── services/
│   ├── backup-service.js          Core backup logic, version management
│   └── recovery-service.js        Recovery ISO building, instructions
├── utils/
│   ├── backup-helpers.js          SSH, Samba, filesystem helpers
│   ├── data.js                    JSON persistence layer
│   └── security.js                Logging and auth utilities
└── middleware/
    └── auth.js                    JWT/token authentication

tests/
├── integration/
│   └── active-backup.test.js      Full workflow tests
└── unit/
    ├── backup-service.test.js     Service unit tests
    └── agent-controller.test.js   Controller unit tests
```

## Key Design Decisions

### 1. Agent-Pull Model (Not Push)

**Decision**: Agents poll the server for tasks, not the reverse.

**Why**:
- No need to know agent IP/hostname ahead of time
- Works through NAT/firewalls
- Agent controls its own schedule
- Simpler to scale (no server→agent connections)

**Implication**: 
- Server has tasks queue; agents poll periodically
- Polling creates natural rate limiting

### 2. File Size Limits

**Rule**: Max 300 lines per file, max 30 lines per function.

**Exception**: Active Backup approved exceptions:
- Services can grow to ~400 lines if cohesive domain logic
- Rsync backup logic split into `buildRsyncArgs()` and `executeRsyncCommand()`

**Why**: 
- Easier to test
- Easier to maintain
- Forces better separation of concerns

### 3. Password Encryption

**Current**: Base64 encoding (NOT secure for production)

**TODO**: 
- Use libsodium or bcrypt for password storage
- Use environment variables for API keys
- Document security best practices

### 4. Retention Policy

**Strategy**: Keep N most recent versions; delete older ones.

**Example**: retention=7 means keep 7 most recent backups.

**Implementation**: `enforceRetention()` in backup-service.js runs after each successful backup.

### 5. Symlink Strategy

**latest**: Symlink to most recent version

**Why**: 
- Fast restore without scanning all versions
- Clean API for "current" backup
- Works across rsync with `--link-dest`

## API Reference

### Agent Endpoints (no auth required)

#### POST /agent/register
Register new agent
```json
{
  "hostname": "workstation-01",
  "ip": "192.168.1.50",
  "os": "windows",
  "mac": "AA:BB:CC:DD:EE:FF"
}
```

Response:
```json
{
  "success": true,
  "agentId": "abc123",
  "agentToken": "secret_token",
  "status": "pending"
}
```

#### GET /agent/poll
Poll for backup tasks
- Header: `X-Agent-Token: secret_token`

Response:
```json
{
  "success": true,
  "agentId": "abc123",
  "tasks": [
    { "taskId": "task_1", "type": "backup", "path": "/data" }
  ],
  "config": { "hostname": "server", "backupPath": "/backup" }
}
```

#### POST /agent/report
Report backup result
- Header: `X-Agent-Token: secret_token`

Body:
```json
{
  "taskId": "task_1",
  "status": "success",
  "version": "v1",
  "size": 536870912
}
```

### Admin Endpoints (auth required)

#### GET /devices
List all devices

#### POST /devices
Create device manually

#### PUT /devices/:id
Update device schedule, retention, password

#### DELETE /devices/:id
Remove device and backups

#### POST /devices/:id/backup
Trigger immediate backup

#### GET /devices/:id/versions
List backup versions

#### GET /pending
List pending agent approvals

#### POST /pending/:id/approve
Approve pending agent

#### POST /pending/:id/reject
Reject pending agent

#### GET /recovery/status
Get recovery ISO status

#### POST /recovery/build
Build recovery ISO (async)

#### GET /recovery/download
Download recovery ISO

## Testing

### Unit Tests
Located in `tests/unit/`:
- Test individual functions in isolation
- Mock dependencies (file I/O, SSH, etc.)
- Target 80%+ code coverage

### Integration Tests
Located in `tests/integration/`:
- Test full workflows (register → approve → backup)
- Use real file I/O, fake SSH
- Verify error handling and edge cases

### Run Tests
```bash
npm test                          # All tests
npm test -- --coverage           # With coverage report
npm test -- --watch              # Watch mode
```

## Security Considerations

### Authentication
- **Agent endpoints**: Use X-Agent-Token header (no user auth needed)
- **Admin endpoints**: JWT or session-based auth via `requireAuth` middleware

### Authorization
- Only authenticated users can trigger backups
- Only owners can delete devices
- Agents can only access their own data

### Data Protection
- **Passwords**: Currently base64 (TODO: encrypt with bcrypt/libsodium)
- **SSH Keys**: Stored in ~/.ssh/id_rsa, restricted permissions
- **Samba Credentials**: In data.json (TODO: use secrets manager)

### Logging
- All device operations logged via `logSecurityEvent()`
- Agent registrations, approvals, backups all logged
- Useful for audit trails

## Troubleshooting

### Agent Won't Connect
1. Check agent hostname in pending list: `GET /pending`
2. Approve the agent: `POST /pending/{id}/approve`
3. Verify agent can reach server (firewall, network)
4. Check server logs for errors

### Backup Failed
1. Check device status: `GET /devices/{id}/status`
2. Check device credentials (SSH, Samba, etc.)
3. Verify disk space on backup target
4. Check logs: `/var/log/homepinas/active-backup.log`

### Recovery ISO Won't Build
1. Check build script: `GET /recovery/status`
2. Check disk space for ISO (~4GB)
3. Check build script permissions
4. Check recovery-usb/ directory structure

## Performance Notes

### Backup Speed
- rsync with `--link-dest` deduplicates blocks → space efficient
- First backup slowest; subsequent backups much faster
- Network bandwidth is bottleneck, not CPU

### Scaling Limits
- ~50 agents per server (depends on hardware)
- Each agent can backup ~1TB per hour (SSH throughput)
- Retention of 30 versions takes ~30TB storage

### Optimization Ideas
1. **Parallel backups**: Run multiple agents simultaneously (currently serial)
2. **Incremental backups**: Track file changes, backup only deltas
3. **Compression**: gzip for network, varies space/CPU tradeoff
4. **Deduplication**: ZFS or btrfs snapshots

## Future Enhancements

1. **Database**: Move from JSON to PostgreSQL for scaling
2. **Task queue**: Redis for distributed task scheduling
3. **Agent discovery**: Multicast/mDNS to auto-find agents
4. **Backup encryption**: Full-disk encryption with key management
5. **Replication**: Backup backups to remote server
6. **GUI**: React dashboard for management

## Code Quality Standards

All code follows the `code-quality` skill:

- ✅ Separation of concerns (routes, controllers, services, utils)
- ✅ Max 300 lines per file
- ✅ Max 30 lines per function (split longer functions)
- ✅ Meaningful variable names
- ✅ Error handling as normal flow
- ✅ JSDoc comments for WHY, not WHAT
- ✅ Unit + integration tests for all logic
- ✅ DRY principle (no copy-paste)

See `~/.openclaw/skills/code-quality/SKILL.md` for details.
