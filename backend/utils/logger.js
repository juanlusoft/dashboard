/**
 * HomePiNAS - Structured Logger
 * Replaces raw console.log with leveled logging.
 * Set LOG_LEVEL env var: debug | info | warn | error (default: info)
 * 
 * @example
 *   const log = require('../utils/logger');
 *   log.info('Server started on port %d', port);
 *   log.error('Failed to read file', err.message);
 *   log.debug('Request body:', body); // only shown if LOG_LEVEL=debug
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[process.env.LOG_LEVEL || 'info'] ?? LEVELS.info;

/**
 * Format a log line with timestamp and level tag
 * @param {'DEBUG'|'INFO'|'WARN'|'ERROR'} tag - Level tag
 * @param {any[]} args - Arguments to log
 */
function formatLog(tag, args) {
    const ts = new Date().toISOString();
    return [`[${ts}] [${tag}]`, ...args];
}

const log = {
    debug(...args) {
        if (currentLevel <= LEVELS.debug) {
            console.log(...formatLog('DEBUG', args));
        }
    },
    info(...args) {
        if (currentLevel <= LEVELS.info) {
            console.log(...formatLog('INFO', args));
        }
    },
    warn(...args) {
        if (currentLevel <= LEVELS.warn) {
            console.warn(...formatLog('WARN', args));
        }
    },
    error(...args) {
        if (currentLevel <= LEVELS.error) {
            console.error(...formatLog('ERROR', args));
        }
    }
};

module.exports = log;
