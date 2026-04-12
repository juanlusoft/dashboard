/**
 * HomePiNAS - Samba User Utility
 *
 * Unified createSambaUser() shared by auth.js and users.js.
 * NOTE: users.js should import from here instead of defining its own copy.
 *
 * This version includes the smbd/nmbd service restart required after
 * creating a new user so that the Samba daemons pick up the new account.
 */

const log = require('./logger');
const { spawn, execFileSync } = require('child_process');
const { sanitizeUsername } = require('./sanitize');

/**
 * Create a Samba user with the given credentials (SECURE VERSION).
 *
 * Steps:
 *  1. Ensure the system user exists (creates it if missing).
 *  2. Adds the user to the `sambashare` group.
 *  3. Sets the Samba password via stdin (never exposed in the process list).
 *  4. Enables the Samba account.
 *  5. Optionally sets ownership of /mnt/storage if mergerfs is mounted.
 *  6. Restarts smbd and nmbd so the new account is active immediately.
 *
 * @param {string} username
 * @param {string} password
 * @returns {Promise<boolean>} true on success, false on failure
 */
async function createSambaUser(username, password) {
    const safeUsername = sanitizeUsername(username);
    if (!safeUsername) {
        log.error('Invalid username format for Samba user');
        return false;
    }

    try {
        // 1. Ensure system user exists
        try {
            execFileSync('id', [safeUsername], { encoding: 'utf8' });
        } catch (e) {
            execFileSync('sudo', ['useradd', '-M', '-s', '/sbin/nologin', safeUsername], { encoding: 'utf8' });
        }

        // 2. Add user to sambashare group
        execFileSync('sudo', ['usermod', '-aG', 'sambashare', safeUsername], { encoding: 'utf8' });

        // 3. Set Samba password using stdin (password never visible in process list)
        await new Promise((resolve, reject) => {
            const smbpasswd = spawn('sudo', ['smbpasswd', '-a', '-s', safeUsername], {
                stdio: ['pipe', 'pipe', 'pipe']
            });

            smbpasswd.stdin.write(password + '\n');
            smbpasswd.stdin.write(password + '\n');
            smbpasswd.stdin.end();

            let stderr = '';
            smbpasswd.stderr.on('data', (data) => { stderr += data.toString(); });

            smbpasswd.on('close', (code) => {
                if (code === 0) resolve();
                else reject(new Error(`smbpasswd failed: ${stderr}`));
            });

            smbpasswd.on('error', reject);
        });

        // 4. Enable the Samba user
        execFileSync('sudo', ['smbpasswd', '-e', safeUsername], { encoding: 'utf8' });

        // 5. Set ownership of storage pool directory (ONLY if mergerfs pool is mounted)
        try {
            execFileSync('mountpoint', ['-q', '/mnt/storage'], { encoding: 'utf8' });
            execFileSync('sudo', ['chown', `${safeUsername}:sambashare`, '/mnt/storage'], { encoding: 'utf8' });
            execFileSync('sudo', ['chmod', '2775', '/mnt/storage'], { encoding: 'utf8' });
        } catch (e) {
            // Storage pool not mounted — skip ownership change
        }

        // 6. Restart Samba daemons so the new account is immediately active
        execFileSync('sudo', ['systemctl', 'restart', 'smbd'], { encoding: 'utf8' });
        execFileSync('sudo', ['systemctl', 'restart', 'nmbd'], { encoding: 'utf8' });

        log.info(`Samba user ${safeUsername} created successfully`);
        return true;
    } catch (e) {
        log.error('Failed to create Samba user:', e.message);
        return false;
    }
}

module.exports = { createSambaUser };
