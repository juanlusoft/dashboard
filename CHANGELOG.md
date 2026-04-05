# Changelog

All notable changes to HomePiNAS are documented in this file.


---

## [2.13.0] - 2026-04-05

### Added
- **🌐 DHCP IP Display** — El wizard muestra la IP asignada por el router al seleccionar modo DHCP, usando nuevo endpoint público `/api/network/current-ip` que no requiere autenticación
- **🎨 Network Mode Highlight** — Selección visual con borde, fondo y checkmark (✓) para indicar el modo de red activo (DHCP/Estático) en el wizard
- **🗂️ Storage Type Selection** — Paso 2 del wizard rediseñado: elige entre SnapRAID+MergerFS, Discos Básicos (JBOD) o RAID Estándar (mdadm) antes de seleccionar discos. La elección de sistema de archivos se mueve exclusivamente al paso 5
- **⚡ Parallel Disk Formatting** — Los discos se formatean en paralelo (`Promise.all` + `execFileAsync`) en lugar de secuencialmente, reduciendo significativamente el tiempo de configuración

### Fixed
- Variable CSS `--primary-rgb` no definida que causaba que el highlight de selección fuera invisible
- IP DHCP no se cargaba en el wizard porque el endpoint requería autenticación antes de que existiera sesión

---

## [2.11.0] - 2026-03-08

### Security
- **Factory reset requires auth** — `POST /api/power/factory-reset` now requires admin authentication (was previously public)
- **Emergency reset confirmation** — `POST /api/auth/setup/reset` now requires `{ "confirm": "RESET" }` body
- **XSS fixes** — Sanitize hostname, uptime, temperature values in innerHTML with `escapeHtml()`
- **Per-user file ACLs** — Users can be restricted to specific directory paths

### Added
- **NFS share management** — Full NFS UI in Network view (list/add/delete shares, service status)
- **Per-user file paths** — Admin can set home directory and allowed paths per user (Users → 📁 button)
- **ext4/XFS selector** — Choose filesystem type when creating storage pools in wizard
- **Docker port selector** — Smart port detection for Open Web button (prefers HTTP ports, dropdown for multiple)
- **CI/CD** — GitHub Actions workflow for automated tests on push/PR
- **In-process data mutex** — `withData()` function prevents concurrent write races on data.json

### Fixed
- **Version sync** — All version sources now read from package.json (single source of truth)
- **Docker update preserves config** — Networks, Cmd, Entrypoint, User, Tty now preserved on container recreation
- **Container notes by name** — Notes survive container updates (indexed by name, not ID)
- **Network CIDR calculation** — Proper bit-counting replaces fragile string-split hack
- **Docker log parsing** — Correctly strips multiplexed stream headers (no more garbage bytes)
- **Gateway auto-fill** — Switching from DHCP to manual populates gateway with x.x.x.1
- **fstab filesystem detection** — Uses actual partition type instead of hardcoding ext4
- **JSON body limit** — Increased from 10kb to 256kb for docker-compose files

### Changed
- **CSP documented** — `scriptSrcAttr: 'unsafe-inline'` documented as tech debt (TODO: migrate onclick handlers)
- **Terminal whitelist documented** — Clarified that command whitelist is not a security boundary


---

## [2.10.8] - 2026-03-04

### Added
- **Disk Health Panel** — Comprehensive disk health monitoring in Storage view
  - Auto-detects HDD/SSD/NVMe via `lsblk` + `smartctl -j` (JSON native)
  - Shows: SMART status, reallocated/pending/uncorrectable sectors (HDD), TBW + life remaining (SSD/NVMe)
  - Power-on hours formatted as years/months/days
  - Temperature with traffic light indicators
  - Run SMART tests (short/long) with progress tracking
  - Summary badge: X OK · Y Warning · Z Critical
  - Full i18n support (ES/EN)

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
