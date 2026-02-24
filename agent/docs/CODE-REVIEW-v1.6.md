# Code Review — agent/src/*.js — v1.6-develop
**Reviewer:** Karen (AI) — 2026-02-24  
**Scope:** `backup.js`, `backup-windows.js`, `backup-mac.js`, `backup-linux.js`, `smb-connect.js`, `checkpoint.js`, `integrity.js`, `retry.js`, `usn-journal.js`, `windows-incremental.js`

---

## Summary

The codebase is well-structured overall: clear separation of concerns, consistent use of `execFile` (no shell injection), defensive finally-blocks for cleanup, and good use of shared retry/checkpoint/integrity infrastructure. Two bugs were fixed in this review cycle; a number of non-blocking issues and improvement suggestions are documented below.

---

## Bugs Fixed

### BUG-001 — `smb-connect.js`: Hardcoded `/tmp` path  
**File:** `src/smb-connect.js:155`  
**Severity:** Low (only affected non-Linux platforms in edge cases)  
**Description:** `writeCredFile` used a hardcoded `/tmp/` prefix, which is incorrect on macOS (where `os.tmpdir()` may resolve differently) and unavailable on Windows.  
**Fix:** Changed to `path.join(os.tmpdir(), 'homepinas-creds-...')`. Added `os` import.

### BUG-002 — `usn-journal.js`: Typo in Outlook exclusion pattern  
**File:** `src/usn-journal.js:213`  
**Severity:** Low (wrong files excluded from incremental backup filter)  
**Description:** The pattern `/\\.ostis$/i` is a typo — it would only exclude files ending in `.ostis` (non-existent). Outlook cache files have extension `.ost`.  
**Fix:** Changed to `/\\.ost$/i`.

---

## Non-Blocking Issues

### ISSUE-001 — `smb-connect.js`: Credentials visible in `net use` argument list  
**Severity:** Medium  
**File:** `connectWindowsSMB`, `connectWindowsDrive`  
**Description:** Windows credentials (`/user:xxx`, password) are passed as process arguments to `net use`. While `shell: false` prevents shell injection, the arguments are visible in process listings (`tasklist /V`, Sysinternals Process Explorer). The module header comment incorrectly states "Credentials are never interpolated into command strings."  
**Recommendation:** Correct the comment. For production hardening, consider using a temporary credentials file via `cmdkey` or a session-scoped approach.

### ISSUE-002 — `smb-connect.js`: Silent error swallowing in `cleanWindowsSMB`  
**Severity:** Low  
**File:** `src/smb-connect.js`, `cleanWindowsSMB`  
**Description:** All catch blocks in `cleanWindowsSMB` are empty `catch (e) {}`. Cleanup failures are silently ignored, making it hard to debug stale connections.  
**Recommendation:** At minimum, log at debug/warn level: `console.warn('[SMB] cleanup:', e.message)`.

### ISSUE-003 — `smb-connect.js`: macOS SMB URL contains credentials  
**Severity:** Low  
**File:** `src/smb-connect.js`, `mountMacSMB`  
**Description:** `mount_smbfs` is called with the full `smb://user:password@host/share` URL in the argument list. This URL may appear in process listings and system logs.  
**Recommendation:** Use `-o credentials=FILE` approach if the macOS `mount_smbfs` version supports it.

### ISSUE-004 — `backup-linux.js`: Partial file not cleaned up on partclone failure  
**Severity:** Medium  
**File:** `src/backup-linux.js`, `partcloneCapture`  
**Description:** If `partclone` or `gzip` fails mid-stream, the partial `.img.gz` file remains at `destFile`. The caller's `finally` block unmounts the share but doesn't remove the partial file.  
**Recommendation:** Wrap `partcloneCapture` in a try/finally that unlinks `imgFile` on error, or track it in the caller.

### ISSUE-005 — `backup-linux.js`: Race condition in partclone/gzip pipeline  
**Severity:** Low  
**File:** `src/backup-linux.js`, `partcloneCapture`  
**Description:** `gzip.on('close')` can emit before `partclone.on('close')`, resolving the Promise before the partclone error is checked. In the current implementation, `reject` may be called after `resolve` (second call is a no-op in Promises, so no crash, but error is silently lost).  
**Recommendation:** Use a shared completion flag or pipe errors through a single event path.

### ISSUE-006 — `backup-mac.js`: No retry around `asr` capture  
**Severity:** Low  
**File:** `src/backup-mac.js`, `macImageBackup`  
**Description:** The `sudo asr create` call has a 2-hour timeout but no retry. A transient I/O error would fail the entire backup.  
**Recommendation:** Wrap `asr` in the `retry` helper with `maxRetries: 2`.

### ISSUE-007 — `backup-mac.js`: Hardcoded mount point  
**Severity:** Low  
**File:** `src/backup-mac.js`  
**Description:** `/Volumes/homepinas-backup` is hardcoded. Concurrent backups (or leftover mounts) would collide.  
**Recommendation:** Append `process.pid` to the mount point (same pattern as Linux).

### ISSUE-008 — `usn-journal.js`: Fallback in `getChangedFiles` is a no-op  
**Severity:** Low  
**File:** `src/usn-journal.js`, `getChangedFiles`  
**Description:** The comment inside the PowerShell script says "if fsutil fails, fall back to file enumeration" but the catch block just emits a warning and produces zero results — effectively triggering a full backup silently. The comment is misleading.  
**Recommendation:** Either implement the fallback (file enumeration) or remove the misleading comment and clarify that failure here triggers a full backup on the next cycle.

### ISSUE-009 — `windows-incremental.js`: Dead code  
**Severity:** Info  
**File:** `src/windows-incremental.js`, `getIncrementalFileList`  
**Description:** `getIncrementalFileList(cpId)` is defined but never called from anywhere in the codebase (the incremental list is fetched directly inside `determineBackupStrategy`).  
**Recommendation:** Remove or mark as reserved for future public API.

### ISSUE-010 — `integrity.js`: Sync I/O inside async function  
**Severity:** Info  
**File:** `src/integrity.js`, `listFiles`  
**Description:** `listFiles` is declared `async` and awaited, but internally uses synchronous `fs.readdirSync`. For large backup directories this blocks the event loop.  
**Recommendation:** Replace with `fs.promises.readdir` + `await` for consistency and event-loop safety.

### ISSUE-011 — `checkpoint.js`: No cap on accumulated checkpoints  
**Severity:** Info  
**File:** `src/checkpoint.js`, `listActive`  
**Description:** Checkpoints accumulate indefinitely (only expired by 72h). A user with many device IDs could grow this directory unboundedly.  
**Recommendation:** Add a max-count cleanup sweep in `listActive` or in `create`.

---

## Positive Highlights

- **Security:** Consistent use of `execFile`/`spawn` with `shell: false` across all files — no shell injection risk.
- **Reliability:** All platform backup functions wrap their main flow in `try/finally` for guaranteed cleanup (unmount, VSS delete, drive disconnect, cred file removal).
- **Checkpoint/resume:** Checkpoint is preserved on failure and cleared only on success — correct behavior for crash recovery.
- **Incremental backups:** Clean integration of USN Journal into the existing checkpoint framework via the `WindowsIncrementalHelper` adapter.
- **Integrity manifest:** SHA256 streaming hash is memory-efficient and the atomic write (tmp + rename) is correctly implemented.
- **Retry:** Well-designed exponential backoff with jitter; `isRetryable` supports both string patterns and regex.
- **Code documentation:** JSDoc on all public functions with parameters, return values, and security notes.

---

## Tests Written

Five new test files added covering all previously untested modules:

| File | Tests | Coverage target |
|------|-------|-----------------|
| `__tests__/smb-connect.test.js` | 22 | All 7 exported functions |
| `__tests__/backup.test.js` | 28 | BackupManager orchestration |
| `__tests__/backup-windows.test.js` | 15 | `runWindowsBackup` (image + file) |
| `__tests__/backup-mac.test.js` | 20 | `runMacBackup` (image + file) |
| `__tests__/backup-linux.test.js` | 24 | `runLinuxBackup` (image + file) |

All external OS calls mocked. Jest test suite: **9 suites, 139 passed, 6 skipped (Windows-only), 0 failed**.
