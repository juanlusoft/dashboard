# HomePiNAS v2.9.10

Premium NAS Dashboard for Raspberry Pi CM5 - Homelabs.club Edition

![HomePiNAS Dashboard](https://img.shields.io/badge/version-2.9.10-brightgreen)
![PWA Ready](https://img.shields.io/badge/PWA-Ready-blueviolet)
![Mobile Friendly](https://img.shields.io/badge/Mobile-Friendly-blue)

## 🚀 Features

### Core
- **SnapRAID + MergerFS** — Disk pooling with parity protection
- **Samba Sharing** — Network file sharing with automatic user creation
- **Docker Management** — Container control from dashboard
- **Fan Control** — PWM control for EMC2305 (Silent/Balanced/Performance)
- **System Monitoring** — CPU, Memory, Disk, Network stats
- **Web Terminal** — Full terminal access from the browser
- **File Manager** — Upload, download, drag & drop, preview

### Advanced
- **👥 Users & Permissions** — Multi-user with admin/user roles
- **🔐 2FA (TOTP)** — Google Authenticator compatible
- **📧 Notifications** — Email and Telegram alerts
- **📋 Log Viewer** — System and security logs
- **💾 Backup** — Create, schedule, and restore backups
- **⏰ Task Scheduler** — Cron jobs from dashboard
- **🔌 UPS Support** — APC UPS monitoring
- **🌐 DDNS** — DuckDNS, No-IP, Dynu remote access

### 🔒 VPN Server (WireGuard)
- **One-click install** — WireGuard with async progress bar
- **Client management** — Create/revoke clients with QR codes
- **Mobile-ready** — Scan QR from WireGuard mobile app
- **Connected peers** — Real-time status and traffic stats
- **Hot-reload** — `wg syncconf` without disconnecting peers
- **Security** — Private keys never stored in config DB, admin-only RBAC

### ☁️ Cloud Sync (Syncthing)
- **Real-time folder sync** between NAS and other devices
- **Syncthing integration** — Peer-to-peer, encrypted sync
- **Dashboard management** — Add/remove sync folders from UI
- **Auto-detection** — Finds Syncthing config across system users
- **Status monitoring** — Connection and sync status at a glance

### 🖥️ Active Backup for Business
- **Centralized backup** of PCs and servers to NAS
- **Backup Agent** — Install on Windows/Mac, managed from NAS dashboard
- **Image backup** — Full disk (Windows wbadmin, Linux dd/partclone)
- **File backup** — Folders via rsync+SSH with hardlink deduplication
- **Versioning** — Keep multiple backup copies with retention policies
- **Web restore** — Browse and download files from any backup version
- **🆕 USB Recovery Tool** — Bootable Debian ISO for bare-metal restore
- **Dynamic user detection** — Works with any system username

### Mobile & PWA
- **📱 Responsive UI** — Full mobile support
- **📲 PWA Support** — Install as native app
- **🌐 mDNS Discovery** — Access via `homepinas.local`

## 🔒 Security

- Bcrypt password hashing (12 rounds)
- SQLite-backed persistent sessions
- Rate limiting + Helmet headers
- Input sanitization for shell commands
- Restricted sudoers configuration
- HTTPS with self-signed certificates
- 2FA (TOTP) support

## 🆕 What's New in v2.9.10

### UI/UX Improvements
- **🔔 Notification Center** — Functional notification center with modal interface
- **👤 User Menu** — Working user menu with profile access and settings
- **🔑 Password Change** — Built-in password change functionality from user menu
- **📁 File Manager** — Fixed folder tree not updating when creating new directories
- **💻 Terminal** — Enhanced error handling for command shortcuts with better debugging info

### Technical Fixes
- Fixed header notification icon functionality (issue #3)
- Fixed header user menu not displaying dropdown (issue #4) 
- Fixed File Manager folder tree refresh on new folder creation (issue #5)
- Improved Terminal WebSocket error handling for command shortcuts (issue #9)
- Enhanced terminal security with better command argument validation
- Added connection timeouts and detailed error messages for failed terminal connections

## ⚡ Quick Install

### NAS Dashboard

```bash
curl -fsSL https://raw.githubusercontent.com/juanlusoft/homepinas-v2/main/install.sh | sudo bash
```

### 💻 Backup Agent (Windows/Mac)

Download and install the Backup Agent on any PC you want to protect:

| Platform | Download |
|----------|----------|
| Windows | [HomePiNAS-Backup-Setup.exe](https://github.com/juanlusoft/homepinas-v2/releases/latest) |
| macOS | [HomePiNAS-Backup.dmg](https://github.com/juanlusoft/homepinas-v2/releases/latest) |

**Or build from source:**

```bash
git clone https://github.com/juanlusoft/homepinas-v2.git
cd homepinas-v2/agent
npm install
npm start          # Run in development
npm run build:win  # Build Windows .exe
npm run build:mac  # Build macOS .dmg
```

#### How it works

1. **Install the Agent** on your PC → opens automatically
2. **Click "Search NAS"** → finds your HomePiNAS on the network
3. **Wait for approval** → your NAS admin approves the device
4. **Backups run automatically** → scheduled, with retention, no config needed

The admin manages everything from the NAS dashboard: approve devices, set schedule, trigger backups, browse/restore files.

## 📋 Requirements

- Raspberry Pi CM5 (or compatible ARM64 device)
- Raspberry Pi OS Bookworm (64-bit) or Debian Trixie
- At least 2 disks for SnapRAID (1 data + 1 parity)

## 🌐 Access

### Local Network
```
https://homepinas.local         (mDNS)
https://<IP>                    (HTTPS - puerto 443)
http://<IP>                     (HTTP - redirige a HTTPS)
```

### Network Share (SMB)
```
\\homepinas.local\Storage
```

## 📁 Directory Structure

```
/opt/homepinas/              # Application files
/mnt/storage/                # MergerFS pool mount
/mnt/storage/active-backup/  # Active Backup data
/mnt/disks/disk[1-6]/        # Individual data disks
/mnt/parity[1-2]/            # Parity disks
/mnt/disks/cache[1-2]/       # NVMe/SSD cache
```

## 📜 Version History

### v2.9.0 — VPN Server + Security Hardening
- **VPN Server** — Full WireGuard integration from dashboard
- **Client QR codes** — Create clients, scan QR from mobile
- **Async install** — Background install with real-time progress bar
- **Private key isolation** — Keys stored only in /etc/wireguard, never in data.json
- **RBAC** — VPN management restricted to admin users only
- **Dynamic interface detection** — Auto-detects network interface (end0, eth0, etc.)
- **Hot-reload** — `wg syncconf` reloads config without disconnecting peers
- **Version in header** — Shows current version next to HomePiNAS title
- **Security** — execFile hardening, CSP improvements, SRI hashes

### v2.8.0 — Active Directory + Security Audit
- **Active Directory** — Samba AD DC integration
- **Security audit fixes** — exec→execFile, rate limiting, path validation
- **CSRF protection** — Token-based CSRF middleware
- **RBAC middleware** — Role-based access control system

### v2.7.0 — ISO Builder + Cloud Backup
- **USB Recovery ISO** — Bootable Debian ISO builder
- **Cloud Backup** — rclone integration for remote storage
- **App Store** — Install apps from dashboard

### v2.6.0 — Updates + OS Management
- **Dashboard updates** — Check and apply updates from UI
- **OS updates** — apt-get upgrade from dashboard
- **Update banner** — Notification when new version available

### v2.5.0 — Cloud Sync + Polish
- **Cloud Sync** — Syncthing integration for real-time folder sync
- **HTTP → HTTPS redirect** — Automatic secure connection
- **Improved terminal** — Fixed colors on dark backgrounds
- **Dynamic user detection** — No hardcoded usernames
- **UI polish** — Custom modals, fixed race conditions

### v2.4.0 — Active Backup + Recovery
- **Active Backup** — Centralized backup of PCs/servers
- **Backup Agent** — Cross-platform Electron app (Windows/Mac)
- **Agent auto-registration** — Install, discover NAS, wait for approval
- **USB Recovery Tool** — Bootable Debian ISO for bare-metal restore
- **Per-device Samba shares** — Auto-created with random credentials

### v2.3.0 — Extended Features
- File Manager, Users & Permissions, Samba management
- Notifications (Email/Telegram), 2FA (TOTP)
- Log Viewer, Backup & Restore, Task Scheduler
- UPS monitoring, DDNS remote access

### v2.2.0 — Mobile & PWA
- Responsive UI, PWA support, mDNS discovery

### v2.1.0 — Internationalization
- Multi-language (English/Spanish), theme toggle

### v2.0.0 — Major Rewrite
- Complete UI redesign, Docker management, storage wizard

## 🐛 Troubleshooting

### Backup Agent can't find NAS
1. Ensure NAS and PC are on the same network
2. Check Avahi is running: `sudo systemctl status avahi-daemon`
3. Enter IP manually in the Agent if auto-discovery fails

### wbadmin fails on Windows
- Run the Agent as Administrator
- On Windows Home: use Control Panel → Backup → Create system image
- On Windows Pro: `dism /online /enable-feature /featurename:WindowsServerBackup`

### mDNS not working
```bash
sudo systemctl status avahi-daemon
ls -la /etc/avahi/services/homepinas.service
```

## 📝 License

MIT License — [Homelabs.club](https://homelabs.club)

---

**Made with ❤️ for the home lab community**
