/**
 * Retry with Exponential Backoff
 * 
 * Wraps async operations with automatic retry logic.
 * Used for network operations (SMB connect, API calls, file transfers)
 * that can fail transiently.
 * 
 * Backoff sequence: 1s, 2s, 4s, 8s, 16s (default 5 retries)
 */

const DEFAULT_OPTIONS = {
  maxRetries: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  factor: 2,
  // Jitter: add random 0-25% to prevent thundering herd
  jitter: true,
  // Only retry on these error patterns (null = retry all)
  retryableErrors: null,
  // Callback before each retry
  onRetry: null,
};

/**
 * Execute an async function with exponential backoff retry.
 * 
 * @param {Function} fn - Async function to execute. Receives (attempt) as argument.
 * @param {Object} options - Retry configuration
 * @returns {Promise<*>} Result of fn()
 * @throws Last error if all retries exhausted
 * 
 * @example
 *   const result = await retry(
 *     () => connectSMB(sharePath),
 *     { maxRetries: 3, onRetry: (err, attempt) => console.log(`Retry ${attempt}`) }
 *   );
 */
async function retry(fn, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;

      // Check if error is retryable
      if (opts.retryableErrors && !isRetryable(err, opts.retryableErrors)) {
        throw err; // Non-retryable, fail immediately
      }

      // Last attempt — don't retry
      if (attempt >= opts.maxRetries) break;

      // Calculate delay with exponential backoff
      let delayMs = Math.min(
        opts.baseDelayMs * Math.pow(opts.factor, attempt),
        opts.maxDelayMs
      );

      // Add jitter
      if (opts.jitter) {
        delayMs += Math.random() * delayMs * 0.25;
      }

      // Notify before retry
      if (opts.onRetry) {
        opts.onRetry(err, attempt + 1, delayMs);
      }

      await sleep(delayMs);
    }
  }

  throw lastError;
}

/**
 * Check if an error matches retryable patterns.
 * Patterns can be strings (matched against error.message) or error codes.
 */
function isRetryable(err, patterns) {
  const msg = (err.message || '').toLowerCase();
  const code = err.code || '';

  for (const pattern of patterns) {
    if (typeof pattern === 'string') {
      if (msg.includes(pattern.toLowerCase()) || code === pattern) return true;
    } else if (pattern instanceof RegExp) {
      if (pattern.test(msg) || pattern.test(code)) return true;
    }
  }
  return false;
}

/**
 * Common retryable error patterns for network/SMB operations.
 */
const NETWORK_ERRORS = [
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENETUNREACH',
  'EAI_AGAIN',
  'network',
  'connection',
  'timeout',
  'disconnected',
  'error 53',    // Windows SMB: network path not found
  'error 64',    // Windows SMB: network name deleted
  'error 1219',  // Windows SMB: multiple connections
  'error 1326',  // Windows SMB: logon failure (transient)
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { retry, isRetryable, NETWORK_ERRORS, sleep };
