# Changelog

All notable changes to HomePiNAS are documented in this file.

## [2.10.9] - 2026-03-06

### Fixed
- Allow "admin" as username during initial setup (was blocked as reserved)
- Specific error messages for username validation (start with letter, reserved names)
- Filter phantom/ghost SATA disks (numeric-only model names like "456" on JMB585)
- Dark theme not persisting after page refresh (localStorage key mismatch)
- Race condition: dashboard polling could overwrite other views mid-render
- Network config was a stub — now actually applies via nmcli with dhcpcd fallback
- Network form missing Gateway and DNS fields on initial render (only appeared after toggling DHCP)
- Login only worked for setup admin — additional users created via User Management couldn't login

### Added
- Volume/mount paths shown in Docker container cards
- Password validation: minimum 6 characters with clear error message

## [2.10.8] - 2026-03-04

### Fixed
- **Fan control: profiles not applied after reboot** — fanctl script required EMC2305 hwmon (never created by kernel driver), now uses I2C directly (`i2cset` on bus 10, addr 0x2e)
- **Fan control: pwmfan (RPi CPU fan) never controlled** — script now also manages the pwmfan sysfs device
- **Fan speed detection**: dashboard now reads EMC2305 fan RPMs via I2C tachometer registers when hwmon is unavailable
- **Individual fan control**: POST `/system/fan` now falls back to I2C for EMC2305 fans
- Added `i2c-tools` as install dependency, `i2cset`/`i2cget` to sudoers

## [2.10.5] - 2026-03-02
## [2.10.6] - 2026-03-02
## [2.10.7] - 2026-03-02

### Fixed
- **CRITICAL: remove ALL `-R` flags from chown/chmod sambashare** — Recursive permission changes could destroy system when pool not mounted (active-backup.js, install.sh sudoers)
- Sudoers now allows chown/chmod only on `/mnt/storage` and `/mnt/storage/*` (no recursive)
- active-backup share creation uses setgid (2775) on top dir only

---


### Fixed
- **CRITICAL: sudo broken after setup** — `chown -R :sambashare` and `chmod -R 2775` on `/mnt/storage` propagated to entire filesystem when pool wasn't mounted, breaking sudo permissions on `/usr/bin/sudo` and `/etc/` (auth.js, storage.js)
- Now checks mountpoint before setting permissions, and never uses `-R` flag

---


### Merged
- **Full sync main ↔ develop** — All 421 commits from develop merged into main
- Includes all fixes from v2.9.10 (issues #1-#9)
- Active Backup styles and UI improvements
- APP_VERSION fix in install.sh (no more collision with /etc/os-release)

### Added
- **HomeStore enhancements** — External Docker app detection (#6)
- **SMART tests** — View and relaunch SMART diagnostics (#8)
- **WireGuard** — Public key included in client export (#7)

### Fixed
- **Logs** — Duplicate filter boxes and broken search (#1, #2)
- **Header** — Notification icon and user menu functional (#3, #4)
- **File Manager** — Folder tree refresh on new directory (#5)
- **Terminal** — Better error handling for disconnected shortcuts (#9)

---

## [2.9.10] - 2026-03-01

### Fixed
- **Header notifications** — Notification center icon now opens functional notification modal (issue #3)
- **Header user menu** — User menu icon now displays dropdown with profile options (issue #4)
- **File Manager tree refresh** — Folder tree now updates correctly when creating new directories (issue #5)
- **Terminal shortcuts connection** — Enhanced error handling for command shortcuts with detailed connection timeout and error messages (issue #9)

### Added
- **Notification Center** — Modal interface for system notifications (placeholder for future expansion)
- **User Menu Dropdown** — Profile access, settings, and password change functionality
- **Password Change Modal** — Built-in password change form accessible from user menu
- **Terminal error diagnostics** — Better debugging information for failed WebSocket connections
- **Command argument support** — Terminal now properly handles commands with arguments while maintaining security

### Security
- **Enhanced command validation** — Improved backend validation for terminal commands and arguments
- **Path traversal prevention** — Stricter validation prevents path-based command execution

---

## [2.5.0] - 2025-02-05

### Added
- **Cloud Sync** — Syncthing integration for real-time folder synchronization
  - Add/remove sync folders from dashboard
  - Monitor connection and sync status
  - Peer-to-peer encrypted sync between devices

### Changed
- **HTTP → HTTPS redirect** — HTTP requests now automatically redirect to HTTPS
- **Dynamic user detection** — Syncthing service now detects system username automatically (no hardcoded paths)

### Fixed
- **Terminal colors** — Fixed visibility of colored text on dark backgrounds
- **Cloud Sync delete folder** — Replaced browser `confirm()` with custom modal for better UX
- **SPA routing race condition** — Fixed incorrect view rendering on initial page load
- **Cloud Sync duplicate title** — Removed duplicate heading in Cloud Sync view
- **CSP compliance** — Replaced inline onclick handlers with addEventListener

---

## [2.4.0] - 2025-02-04

### Added
- **Active Backup for Business** — Centralized backup solution for PCs and servers
  - Backup Agent for Windows/Mac (Electron app)
  - Image backup (full disk) and file backup (folders with deduplication)
  - Versioning with retention policies
  - Web-based file restore
- **USB Recovery Tool** — Bootable Debian ISO for bare-metal restore
- **Agent auto-registration** — Devices discover NAS via mDNS, admin approves from dashboard
- **Per-device Samba shares** — Auto-created with random credentials for each backup device

### Fixed
- Session expiration handling during polling
- NaN display for container RAM stats
- Disk action modal from card buttons
- Virtual device filtering (zram/ram/loop)

---

## [2.3.0] - 2025-02-01

### Added
- **File Manager** — Upload, download, drag & drop, preview
- **Users & Permissions** — Multi-user with admin/user roles
- **Samba Management** — Network shares from dashboard
- **Notifications** — Email and Telegram alerts
- **2FA (TOTP)** — Google Authenticator compatible
- **Log Viewer** — System and security logs
- **Backup & Restore** — Configuration backup
- **Task Scheduler** — Cron jobs from dashboard
- **UPS Monitoring** — APC UPS support
- **DDNS** — DuckDNS, No-IP, Dynu integration

---

## [2.2.0] - 2025-01-28

### Added
- **Responsive UI** — Full mobile support
- **PWA Support** — Install as native app
- **mDNS Discovery** — Access via `homepinas.local`

---

## [2.1.0] - 2025-01-25

### Added
- **Multi-language** — English and Spanish support
- **Theme toggle** — Light/dark mode

---

## [2.0.0] - 2025-01-20

### Changed
- Complete UI redesign
- New storage wizard
- Docker management overhaul

---

## [1.0.0] - 2025-01-15

### Added
- Initial release
- SnapRAID + MergerFS integration
- Basic dashboard with system monitoring
- Fan control (EMC2305)
- Web terminal
