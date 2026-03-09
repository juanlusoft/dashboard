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

module.exports = { STORAGE_MOUNT_BASE, POOL_MOUNT, SNAPRAID_CONF, formatSize };
