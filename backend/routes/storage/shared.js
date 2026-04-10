/**
 * HomePiNAS - Storage Shared Constants & Helpers
 */

const STORAGE_MOUNT_BASE = '/mnt/disks';
const POOL_MOUNT = '/mnt/storage';
const SNAPRAID_CONF = '/etc/snapraid.conf';

/**
 * Format disk size: GB → TB when >= 1024
 * @param {number|string} gb - Size in GB
 * @returns {string} Formatted size string
 */
function formatSize(gb) {
    const num = parseFloat(gb) || 0;
    if (num >= 1024) {
        return (num / 1024).toFixed(1) + ' TB';
    }
    return Math.round(num) + ' GB';
}

/**
 * Format bytes to human-readable size
 * @param {number} bytes - Size in bytes
 * @returns {string} Formatted size string
 */
function formatBytes(bytes) {
    const num = parseInt(bytes) || 0;
    if (num >= 1024 ** 4) return (num / 1024 ** 4).toFixed(1) + ' TB';
    if (num >= 1024 ** 3) return (num / 1024 ** 3).toFixed(1) + ' GB';
    if (num >= 1024 ** 2) return (num / 1024 ** 2).toFixed(0) + ' MB';
    return num + ' B';
}

module.exports = { STORAGE_MOUNT_BASE, POOL_MOUNT, SNAPRAID_CONF, formatSize, formatBytes };
