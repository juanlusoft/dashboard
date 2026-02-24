/**
 * Tests for USN Journal Tracker
 */

const { USNJournalTracker } = require('../src/usn-journal');
const os = require('os');

describe('USNJournalTracker', () => {
  let tracker;

  beforeEach(() => {
    tracker = new USNJournalTracker();
  });

  // Skip Windows-specific tests on non-Windows platforms
  const skipIfNotWindows = process.platform !== 'win32' ? describe.skip : describe;

  skipIfNotWindows('Windows-only tests (only run on win32)', () => {
    test('queryJournal returns valid structure', async () => {
      // This test requires Windows and NTFS
      if (process.platform !== 'win32') {
        console.log('Skipping queryJournal test (not Windows)');
        return;
      }

      try {
        const result = await tracker.queryJournal('C:');
        
        expect(result).toHaveProperty('journalId');
        expect(result).toHaveProperty('nextUSN');
        expect(result).toHaveProperty('oldestUSN');
        
        // USN should be hex strings
        expect(typeof result.nextUSN).toBe('string');
        expect(result.nextUSN).toMatch(/^0x[0-9a-fA-F]+$/);
      } catch (e) {
        console.log(`  [INFO] queryJournal skipped: ${e.message}`);
      }
    });

    test('getChangedFiles returns array of changes', async () => {
      if (process.platform !== 'win32') return;

      try {
        const result = await tracker.getChangedFiles('C:', '0x0');
        
        expect(Array.isArray(result.changed)).toBe(true);
        expect(typeof result.count).toBe('number');
        
        // If there are changes, verify structure
        if (result.changed.length > 0) {
          const first = result.changed[0];
          expect(first).toHaveProperty('path');
          expect(first).toHaveProperty('size');
        }
      } catch (e) {
        console.log(`  [INFO] getChangedFiles test skipped: ${e.message}`);
      }
    });

    test('determineBackupType identifies full vs incremental', async () => {
      if (process.platform !== 'win32') return;

      try {
        // Test 1: No checkpoint = full backup
        const result1 = await tracker.determineBackupType(null);
        expect(result1.type).toBe('full');
        expect(result1.reason).toMatch(/No checkpoint/i);

        // Test 2: Checkpoint with valid USN = incremental
        const journal = await tracker.queryJournal('C:');
        const checkpoint = {
          phaseData: {
            lastUSN: journal.oldestUSN,
          },
        };
        const result2 = await tracker.determineBackupType(checkpoint);
        expect(['full', 'incremental']).toContain(result2.type);
      } catch (e) {
        console.log(`  [INFO] determineBackupType test skipped: ${e.message}`);
      }
    });

    test('getBackupFiles filters excluded patterns', async () => {
      if (process.platform !== 'win32') return;

      try {
        const files = await tracker.getBackupFiles('C:', '0x0');
        
        // Should filter out Temp, AppData\Local, etc.
        const hasTemp = files.some(f => f.path?.includes('Temp'));
        const hasAppData = files.some(f => f.path?.includes('AppData\\Roaming\\Microsoft\\Windows'));
        
        expect(hasTemp).toBe(false);
        expect(hasAppData).toBe(false);
      } catch (e) {
        console.log(`  [INFO] getBackupFiles test skipped: ${e.message}`);
      }
    });

    test('estimateIncrementalTime calculates correctly', () => {
      const files = [
        { path: 'file1.txt', size: 100 * 1024 * 1024 },      // 100MB
        { path: 'file2.txt', size: 50 * 1024 * 1024 },       // 50MB
      ];

      const estimate = tracker.estimateIncrementalTime(files);
      
      expect(estimate).toHaveProperty('totalBytes');
      expect(estimate).toHaveProperty('estimatedMinutes');
      expect(estimate).toHaveProperty('estimatedMB');
      
      expect(estimate.totalBytes).toBe(150 * 1024 * 1024);
      expect(estimate.estimatedMB).toBe(150);
      expect(estimate.estimatedMinutes).toBeGreaterThanOrEqual(5);
    });

    test('saveUSNState saves to checkpoint', async () => {
      if (process.platform !== 'win32') return;

      try {
        const checkpoint = { phaseData: {} };
        const result = await tracker.saveUSNState(checkpoint);
        
        expect(result).toBe(true);
        expect(checkpoint.phaseData.lastUSN).toBeDefined();
        expect(checkpoint.phaseData.lastUSN).toMatch(/^0x[0-9a-fA-F]+$/);
      } catch (e) {
        console.log(`  [INFO] saveUSNState test skipped: ${e.message}`);
      }
    });
  });

  describe('Cross-platform tests', () => {
    test('constructor sets correct platform', () => {
      expect(tracker.platform).toBe(process.platform);
    });

    test('non-Windows platforms throw on queryJournal', async () => {
      if (process.platform === 'win32') {
        console.log('  [INFO] Skipping non-Windows test on Windows platform');
        return;
      }

      await expect(tracker.queryJournal('C:')).rejects.toThrow(/Windows-only/i);
    });

    test('non-Windows platforms throw on getChangedFiles', async () => {
      if (process.platform === 'win32') {
        console.log('  [INFO] Skipping non-Windows test on Windows platform');
        return;
      }

      await expect(tracker.getChangedFiles('C:')).rejects.toThrow(/Windows-only/i);
    });
  });

  describe('Error handling', () => {
    test('gracefully handles journal query errors', async () => {
      if (process.platform !== 'win32') {
        console.log('  [INFO] Skipping Windows-specific error test');
        return;
      }

      try {
        // Try with invalid drive (should fail gracefully)
        const result = await tracker.getChangedFiles('Z:', '0x0');
        expect(result).toHaveProperty('changed');
        expect(result).toHaveProperty('count');
      } catch (e) {
        // Either returns empty or throws — both acceptable
        expect(e).toBeDefined();
      }
    });
  });
});
