/**
 * HomePiNAS v2 - User Management Routes
 * Multi-user system with roles: admin, user, readonly
 */

const log = require('../utils/logger');
const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');

const { requireAuth } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/rbac');
const { logSecurityEvent } = require('../utils/security');
const { validateUsername, validatePassword } = require('../utils/sanitize');
const { getData, saveData } = require('../utils/data');
const { destroyByUsername } = require('../utils/session');

const BCRYPT_ROUNDS = 12;

/**
 * Get the users array from data, handling legacy single-user format.
 * Legacy format stores a single user in getData().user (no 's').
 * Modern format stores an array in getData().users.
 */
function getUsers() {
  const data = getData();

  // Modern multi-user format (only if array has entries)
  if (data.users && Array.isArray(data.users) && data.users.length > 0) {
    return data.users;
  }

  // Legacy single-user format or empty users array: include legacy user
  if (data.user) {
    const legacyUser = {
      ...data.user,
      role: data.user.role || 'admin',
      createdAt: data.user.createdAt || new Date().toISOString(),
      lastLogin: data.user.lastLogin || null,
    };
    return [legacyUser];
  }

  // No users at all - return empty array
  return [];
}

/**
 * Strip password from user object before sending to client
 */
function sanitizeUser(user) {
  const { password, ...safe } = user;
  // Ensure paths fields are always present
  safe.homePath = safe.homePath || '';
  safe.allowedPaths = safe.allowedPaths || [];
  return safe;
}

/**
 * Find a user by username (case-insensitive)
 */
function findUser(username) {
  const users = getUsers();
  return users.find(u => u.username.toLowerCase() === username.toLowerCase());
}

/**
 * Save the users array back to data store
 */
function saveUsers(users) {
  const data = getData();
  data.users = users;
  // Keep data.user for backward compatibility with auth.js login
  // The legacy single-user field is still used for authentication
  saveData(data);
}

/**
 * Create a Samba system user (for share access)
 * Uses spawn for smbpasswd since it needs stdin for password input
 */
async function createSambaUser(username, password) {
  const { execFileSync, spawn } = require('child_process');

  try {
    execFileSync('sudo', ['useradd', '-M', '-s', '/usr/sbin/nologin', username], { encoding: 'utf8' });
  } catch (err) {
    // User might already exist, that's OK
  }

  try {
    execFileSync('sudo', ['usermod', '-aG', 'sambashare', username], { encoding: 'utf8' });
  } catch (err) {}

  try {
    // smbpasswd needs stdin for password - use spawn
    await new Promise((resolve, reject) => {
      const proc = spawn('sudo', ['smbpasswd', '-a', '-s', username], {
        stdio: ['pipe', 'pipe', 'pipe']
      });
      proc.stdin.write(password + '\n');
      proc.stdin.write(password + '\n');
      proc.stdin.end();
      proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`smbpasswd exit ${code}`)));
      proc.on('error', reject);
      setTimeout(() => { proc.kill(); reject(new Error('smbpasswd timeout')); }, 10000);
    });
    execFileSync('sudo', ['smbpasswd', '-e', username], { encoding: 'utf8' });
  } catch (err) {
    log.warn('Could not set Samba password:', err.message);
  }
}

/**
 * Remove a Samba system user
 */
async function removeSambaUser(username) {
  const { execFileSync } = require('child_process');
  try {
    execFileSync('sudo', ['smbpasswd', '-x', username], { encoding: 'utf8', timeout: 10000 });
  } catch (err) {
    log.warn('Could not remove Samba user:', err.message);
  }
  try {
    execFileSync('sudo', ['userdel', username], { encoding: 'utf8', timeout: 10000 });
  } catch (err) {
    log.warn('Could not remove system user:', err.message);
  }
}

// All routes require authentication
router.use(requireAuth);

/**
 * GET /me
 * Get current authenticated user's info
 * (Placed before /:username routes to avoid param conflict)
 */
router.get('/me', (req, res) => {
  try {
    const user = findUser(req.user.username);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(sanitizeUser(user));
  } catch (err) {
    log.error('Get current user error:', err.message);
    res.status(500).json({ error: 'Failed to get user info' });
  }
});

/**
 * PUT /me/password
 * Change own password (any authenticated user)
 * Body: { currentPassword, newPassword }
 */
router.put('/me/password', async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current password and new password are required' });
    }

    // Validate new password strength
    if (!validatePassword(newPassword)) {
      return res.status(400).json({ error: 'La contraseña debe tener mínimo 8 caracteres e incluir letras y números' });
    }

    const users = getUsers();
    const userIndex = users.findIndex(
      u => u.username.toLowerCase() === req.user.username.toLowerCase()
    );

    if (userIndex === -1) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Verify current password
    const valid = await bcrypt.compare(currentPassword, users[userIndex].password);
    if (!valid) {
      logSecurityEvent('PASSWORD_CHANGE_FAILED', req.user.username, {
        ip: req.ip,
        reason: 'incorrect current password',
      });
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Hash and save new password
    users[userIndex].password = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    saveUsers(users);

    // Invalidate all sessions for this user (forces re-login on other devices)
    destroyByUsername(req.user.username);

    // Update Samba password too
    try {
      const { spawn } = require('child_process');
      await new Promise((resolve, reject) => {
        const proc = spawn('sudo', ['smbpasswd', '-s', req.user.username], { stdio: ['pipe', 'pipe', 'pipe'] });
        proc.stdin.write(newPassword + '\n');
        proc.stdin.write(newPassword + '\n');
        proc.stdin.end();
        proc.on('close', resolve);
        proc.on('error', reject);
        setTimeout(() => { proc.kill(); resolve(); }, 10000);
      });
    } catch {
      log.warn('Samba password update failed for', req.user.username);
    }

    logSecurityEvent('PASSWORD_CHANGED', { user: req.user.username }, req.ip);
    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    log.error('Password change error:', err.message);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

/**
 * GET /
 * List all users (admin only)
 * Returns users without password fields
 */
router.get('/', requireAdmin, (req, res) => {
  try {
    const users = getUsers();
    res.json({
      users: users.map(sanitizeUser),
      count: users.length,
    });
  } catch (err) {
    log.error('List users error:', err.message);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

/**
 * POST /
 * Create a new user (admin only)
 * Body: { username, password, role }
 */
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { username, password, role, email, displayName } = req.body;

    // Validate username
    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }
    if (!validateUsername(username)) {
      return res.status(400).json({ error: 'Invalid username. Must be 3-32 characters, alphanumeric with _ or -' });
    }

    // Validate password
    if (!password) {
      return res.status(400).json({ error: 'Password is required' });
    }
    if (!validatePassword(password)) {
      return res.status(400).json({ error: 'La contraseña debe tener mínimo 8 caracteres e incluir letras y números' });
    }

    // Validate role
    const validRoles = ['admin', 'user', 'readonly'];
    const userRole = role || 'user';
    if (!validRoles.includes(userRole)) {
      return res.status(400).json({ error: `Invalid role. Must be one of: ${validRoles.join(', ')}` });
    }

    // Validate email if provided
    if (email !== undefined && email !== '') {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Invalid email address' });
      }
    }

    // Check if username already exists
    if (findUser(username)) {
      return res.status(409).json({ error: 'Username already exists' });
    }

    // Hash password and create user
    const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const newUser = {
      username,
      password: hashedPassword,
      role: userRole,
      ...(email !== undefined && email !== '' ? { email } : {}),
      ...(displayName !== undefined && displayName !== '' ? { displayName } : {}),
      createdAt: new Date().toISOString(),
      lastLogin: null,
    };

    const users = getUsers();
    users.push(newUser);
    saveUsers(users);

    // Create Samba user for share access
    await createSambaUser(username, password);

    logSecurityEvent('USER_CREATED', req.user.username, {
      ip: req.ip,
      newUser: username,
      role: userRole,
    });

    res.status(201).json({
      message: 'User created successfully',
      user: sanitizeUser(newUser),
    });
  } catch (err) {
    log.error('Create user error:', err.message);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

/**
 * PUT /:username
 * Update a user (admin only)
 * Body: { role, password } (both optional)
 */
router.put('/:username', requireAdmin, async (req, res) => {
  try {
    const targetUsername = req.params.username;
    const { role, password, email, displayName } = req.body;

    const users = getUsers();
    const userIndex = users.findIndex(
      u => u.username.toLowerCase() === targetUsername.toLowerCase()
    );

    if (userIndex === -1) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Validate and update role if provided
    if (role !== undefined) {
      const validRoles = ['admin', 'user', 'readonly'];
      if (!validRoles.includes(role)) {
        return res.status(400).json({ error: `Invalid role. Must be one of: ${validRoles.join(', ')}` });
      }
      users[userIndex].role = role;
    }

    // Validate and update email if provided
    if (email !== undefined) {
      if (email !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Invalid email address' });
      }
      users[userIndex].email = email;
    }

    // Update displayName if provided
    if (displayName !== undefined) {
      users[userIndex].displayName = displayName;
    }

    // Validate and update password if provided
    if (password !== undefined) {
      if (!validatePassword(password)) {
        return res.status(400).json({ error: 'La contraseña debe tener mínimo 8 caracteres e incluir letras y números' });
      }
      users[userIndex].password = await bcrypt.hash(password, BCRYPT_ROUNDS);

      // Update Samba password using spawn (safeExec doesn't support stdin)
      try {
        const { spawn } = require('child_process');
        await new Promise((resolve, reject) => {
          const proc = spawn('sudo', ['smbpasswd', '-s', users[userIndex].username], {
            stdio: ['pipe', 'pipe', 'pipe']
          });
          proc.stdin.write(password + '\n');
          proc.stdin.write(password + '\n');
          proc.stdin.end();
          proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`smbpasswd exit ${code}`)));
          proc.on('error', reject);
          setTimeout(() => { proc.kill(); resolve(); }, 10000);
        });
      } catch (err) {
        log.warn('Samba password update failed for', users[userIndex].username, err.message);
      }
    }

    saveUsers(users);

    // Invalidate sessions if password was changed
    if (password !== undefined) {
      destroyByUsername(targetUsername);
    }

    logSecurityEvent('USER_UPDATED', req.user.username, {
      ip: req.ip,
      targetUser: targetUsername,
      updatedFields: [
        ...(role !== undefined ? ['role'] : []),
        ...(password !== undefined ? ['password'] : []),
        ...(email !== undefined ? ['email'] : []),
        ...(displayName !== undefined ? ['displayName'] : []),
      ],
    });

    res.json({
      message: 'User updated successfully',
      user: sanitizeUser(users[userIndex]),
    });
  } catch (err) {
    log.error('Update user error:', err.message);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

/**
 * DELETE /:username
 * Delete a user (admin only). Cannot delete self.
 */
router.delete('/:username', requireAdmin, async (req, res) => {
  try {
    const targetUsername = req.params.username;

    // Prevent self-deletion
    if (targetUsername.toLowerCase() === req.user.username.toLowerCase()) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    const users = getUsers();
    const userIndex = users.findIndex(
      u => u.username.toLowerCase() === targetUsername.toLowerCase()
    );

    if (userIndex === -1) {
      return res.status(404).json({ error: 'User not found' });
    }

    const deletedUser = users[userIndex];
    users.splice(userIndex, 1);
    saveUsers(users);

    // Invalidate all sessions for the deleted user
    destroyByUsername(deletedUser.username);

    // Remove from Samba
    await removeSambaUser(deletedUser.username);

    logSecurityEvent('USER_DELETED', req.user.username, {
      ip: req.ip,
      deletedUser: deletedUser.username,
      role: deletedUser.role,
    });

    res.json({ message: `User '${deletedUser.username}' deleted successfully` });
  } catch (err) {
    log.error('Delete user error:', err.message);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

/**
 * PUT /:username/paths
 * Configure file paths for a user (admin only)
 * Body: { homePath, allowedPaths }
 * - homePath: user's default directory in File Station (e.g. /mnt/storage/homes/username)
 * - allowedPaths: array of paths the user can access (empty = full access for admin/user roles)
 */
router.put('/:username/paths', requireAdmin, async (req, res) => {
  try {
    const targetUsername = req.params.username;
    const { homePath, allowedPaths } = req.body;

    const users = getUsers();
    const userIndex = users.findIndex(
      u => u.username.toLowerCase() === targetUsername.toLowerCase()
    );

    if (userIndex === -1) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Validate homePath
    if (homePath !== undefined) {
      if (typeof homePath !== 'string') {
        return res.status(400).json({ error: 'homePath must be a string' });
      }
      // Must be within /mnt/storage or empty
      if (homePath && !homePath.startsWith('/mnt/storage')) {
        return res.status(400).json({ error: 'homePath must be within /mnt/storage' });
      }
      users[userIndex].homePath = homePath;

      // Create home directory if it doesn't exist
      if (homePath) {
        const fs = require('fs');
        const { execFileSync } = require('child_process');
        try {
          if (!fs.existsSync(homePath)) {
            execFileSync('sudo', ['mkdir', '-p', homePath], { timeout: 5000 });
            execFileSync('sudo', ['chown', `${targetUsername}:${targetUsername}`, homePath], { timeout: 5000 });
            execFileSync('sudo', ['chmod', '750', homePath], { timeout: 5000 });
          }
        } catch (e) {
          log.warn('Could not create home directory:', e.message);
        }
      }
    }

    // Validate allowedPaths
    if (allowedPaths !== undefined) {
      if (!Array.isArray(allowedPaths)) {
        return res.status(400).json({ error: 'allowedPaths must be an array' });
      }
      // Validate each path
      for (const p of allowedPaths) {
        if (typeof p !== 'string' || !p.startsWith('/mnt/storage')) {
          return res.status(400).json({ error: 'Each path must be within /mnt/storage' });
        }
      }
      users[userIndex].allowedPaths = allowedPaths;
    }

    saveUsers(users);

    logSecurityEvent('USER_PATHS_UPDATED', req.user.username, {
      ip: req.ip,
      targetUser: targetUsername,
      homePath: users[userIndex].homePath,
      allowedPaths: users[userIndex].allowedPaths,
    });

    res.json({
      message: 'User paths updated',
      user: sanitizeUser(users[userIndex]),
    });
  } catch (err) {
    log.error('Update user paths error:', err.message);
    res.status(500).json({ error: 'Failed to update user paths' });
  }
});

/**
 * GET /:username/paths
 * Get file paths configuration for a user
 */
router.get('/:username/paths', requireAdmin, (req, res) => {
  try {
    const targetUsername = req.params.username;
    const user = findUser(targetUsername);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({
      username: user.username,
      homePath: user.homePath || '',
      allowedPaths: user.allowedPaths || [],
    });
  } catch (err) {
    log.error('Get user paths error:', err.message);
    res.status(500).json({ error: 'Failed to get user paths' });
  }
});

module.exports = router;
