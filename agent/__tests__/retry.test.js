const { retry, isRetryable, NETWORK_ERRORS } = require('../src/retry');

describe('Retry with Exponential Backoff', () => {
  describe('retry()', () => {
    it('returns result on first success', async () => {
      const result = await retry(() => Promise.resolve('ok'));
      expect(result).toBe('ok');
    });

    it('retries on failure and succeeds', async () => {
      let attempts = 0;
      const result = await retry(
        async () => {
          attempts++;
          if (attempts < 3) throw new Error('fail');
          return 'recovered';
        },
        { baseDelayMs: 10, maxRetries: 5 }
      );
      expect(result).toBe('recovered');
      expect(attempts).toBe(3);
    });

    it('throws after max retries exhausted', async () => {
      await expect(
        retry(() => Promise.reject(new Error('persistent failure')), {
          maxRetries: 2,
          baseDelayMs: 10,
        })
      ).rejects.toThrow('persistent failure');
    });

    it('does not retry non-retryable errors', async () => {
      let attempts = 0;
      await expect(
        retry(
          async () => {
            attempts++;
            throw new Error('auth failure');
          },
          {
            maxRetries: 5,
            baseDelayMs: 10,
            retryableErrors: ['ECONNRESET', 'timeout'],
          }
        )
      ).rejects.toThrow('auth failure');
      expect(attempts).toBe(1);
    });

    it('retries matching retryable errors', async () => {
      let attempts = 0;
      await expect(
        retry(
          async () => {
            attempts++;
            const err = new Error('connection reset');
            err.code = 'ECONNRESET';
            throw err;
          },
          {
            maxRetries: 2,
            baseDelayMs: 10,
            retryableErrors: ['ECONNRESET'],
          }
        )
      ).rejects.toThrow();
      expect(attempts).toBe(3); // 1 initial + 2 retries
    });

    it('calls onRetry callback', async () => {
      const retries = [];
      let attempts = 0;

      await retry(
        async () => {
          attempts++;
          if (attempts < 3) throw new Error('fail');
          return 'ok';
        },
        {
          baseDelayMs: 10,
          onRetry: (err, attempt, delay) => {
            retries.push({ attempt, delay });
          },
        }
      );

      expect(retries).toHaveLength(2);
      expect(retries[0].attempt).toBe(1);
      expect(retries[1].attempt).toBe(2);
    });

    it('passes attempt number to fn', async () => {
      const attempts = [];
      await retry(
        async (attempt) => {
          attempts.push(attempt);
          if (attempt < 2) throw new Error('fail');
          return 'ok';
        },
        { baseDelayMs: 10 }
      );
      expect(attempts).toEqual([0, 1, 2]);
    });

    it('respects maxDelayMs cap', async () => {
      const delays = [];
      let attempts = 0;

      await expect(
        retry(
          async () => {
            attempts++;
            throw new Error('fail');
          },
          {
            maxRetries: 3,
            baseDelayMs: 10000,
            maxDelayMs: 100,
            jitter: false,
            onRetry: (err, attempt, delay) => delays.push(delay),
          }
        )
      ).rejects.toThrow();

      // All delays should be capped at 100ms
      expect(delays.every(d => d <= 100)).toBe(true);
    });
  });

  describe('isRetryable()', () => {
    it('matches error codes', () => {
      const err = new Error('something');
      err.code = 'ECONNRESET';
      expect(isRetryable(err, ['ECONNRESET'])).toBe(true);
      expect(isRetryable(err, ['ETIMEDOUT'])).toBe(false);
    });

    it('matches error message substrings', () => {
      const err = new Error('Connection timeout occurred');
      expect(isRetryable(err, ['timeout'])).toBe(true);
      expect(isRetryable(err, ['auth'])).toBe(false);
    });

    it('matches regex patterns', () => {
      const err = new Error('error 53: network path not found');
      expect(isRetryable(err, [/error \d+/])).toBe(true);
      expect(isRetryable(err, [/error 999/])).toBe(false);
    });

    it('NETWORK_ERRORS covers common SMB errors', () => {
      const smbErrors = [
        new Error('error 53'),
        new Error('error 64'),
        new Error('connection reset'),
        Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
      ];
      for (const err of smbErrors) {
        expect(isRetryable(err, NETWORK_ERRORS)).toBe(true);
      }
    });
  });
});
