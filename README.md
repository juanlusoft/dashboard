# HomePiNAS v2.13.13

Premium NAS Dashboard for Raspberry Pi CM5 - Homelabs.club Edition

![HomePiNAS Dashboard](https://img.shields.io/badge/version-2.13.13-brightgreen)
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

## 🆕 What's New in v2.13.13

### Fixes de calidad — Auditoría de código
- **🔧 disks.js** — `filesystem` undefined en mount-standalone (siempre usaba ext4); `updateMergerFSSystemdUnit` no definida (crash al quitar disco del pool)
- **🔧 badblocks.js** — 10 regexes corruptos con doble escape (`/\\s+/` → `/\s+/`); doble `module.exports` eliminado
- **🔧 ups.js** — `shutdownOnCritical` ahora realmente apaga el sistema cuando la batería baja del umbral
- **🔧 active-backup.js** — Campo Telegram `token` → `botToken` (notificaciones de fallo nunca se enviaban)
- **🔧 active-directory.js** — `samba-tool user show` añadido sudo (fallaba en producción)

## 🆕 What's New in v2.13.12

### Auditoría de Seguridad — 14 fixes
- **🔴 IP dinámica** — Eliminada IP hardcodeada en Active Backup, detección automática
- **🔴 Rate limiting agente** — Endpoints `/agent/*` protegidos contra fuerza bruta (30 req/15min)
- **🔴 Path traversal backup** — Validación de base path en descarga de ficheros de backup
- **🔴 SSH key injection** — Validación de formato de clave SSH antes de incluir en instrucciones
- **🟠 TLS agente TOFU** — Trust-on-First-Use para certificados autofirmados del NAS
- **🟠 Multer filename** — Sanitización de nombres de fichero en subidas
- **🟠 PTY env whitelist** — Terminal solo hereda variables de entorno seguras
- **🟠 Error handler** — Errores 500 devuelven mensaje genérico al cliente
- **🟠 Cron validation** — Patrones peligrosos detectados con regex (bypass por espacios resuelto)
- **🟡 Logs filter** — Slashes eliminados del parámetro de filtro
- **🟡 Session timeout** — Reducido a 30 min por defecto, configurable hasta 8h máximo
- **🟢 sanitizeForLog** — Ampliado para cubrir más campos sensibles

## 🆕 What's New in v2.13.8

### Fix formateo de disco en Raspberry Pi
- **⏱️ udevadm settle** — Espera a que el kernel registre la nueva partición antes de formatear
- **🔧 Race condition** — Eliminado el problema de timing que causaba "Format failed" en la Pi

## 🆕 What's New in v2.13.7

### Fix añadir disco a pool con datos existentes
- **🔧 Confirmación inteligente** — Al detectar disco con filesystem, ahora pregunta qué hacer en lugar de fallar
- **➕ Añadir sin formatear** — Opción para incorporar el disco manteniendo sus datos actuales
- **🗑️ Formatear con confirmación** — Opción de formatear con doble confirmación para evitar borrados accidentales

## 🆕 What's New in v2.13.6

### Mejoras por Javier (PRs #12–#15)
- **📡 Gráfica de red en tiempo real** — Ancho de banda por interfaz con selector y escala automática
- **💾 Columna disco en gestor de archivos** — Muestra en qué disco físico está cada archivo (MergerFS)
- **🔧 Fix espacio libre real** — Muestra GB disponibles en lugar del tamaño total del disco
- **🌡️ Fix estado ventilador** — Detecta correctamente el timer `homepinas-fanctl.timer`
- **🔘 Fix botón Mover Ahora** — Ancho automático para que no se deforme en la tarjeta de caché

## 🆕 What's New in v2.13.5

### Docker Widget — Icons & Context Menu
- **🐳 Visual icon grid** — Container icons from dashboard-icons CDN (walkxcode)
- **🖱️ Context menu** — Right-click/click menu with Start/Stop, Logs, Edit, Delete actions
- **🔗 Docker Hub links** — Open container image page directly from dashboard
- **📐 Improved grid** — Better layout and visual hierarchy for container list

## 🆕 What's New in v2.13.4

### Agente Windows - Active Backup
- **🔍 Detección segura** — Firma oculta `hnv2` para identificar HomePiNAS sin escanear por nombre
- **✅ Sin credenciales** — El agente se registra solo; el admin aprueba desde el dashboard
- **🔌 Puerto corregido** — Puerto por defecto corregido a 443
- **🚫 Puerto 3000 eliminado** — Ya no se escanea el puerto 3000 obsoleto
- **📊 Fix disponible pool** — Espacio disponible calculado como total-usado (sin confusión por reserva ext4)

## 🆕 What's New in v2.13.0

### Features
- **🌐 DHCP IP Display** — Wizard step 1 now shows the router-assigned IP when DHCP mode is selected
- **🎨 Network Mode Selection** — Visual highlight (border + background + checkmark) shows the active network mode (DHCP/Static) in the wizard
- **🗂️ Storage Type Wizard** — Step 2 redesigned: choose between SnapRAID+MergerFS, Basic Disks (JBOD) or Standard RAID (mdadm) before selecting disks. Filesystem choice moved exclusively to step 5
- **⚡ Parallel Disk Formatting** — Disks are now formatted simultaneously (Promise.all) instead of sequentially, reducing setup time significantly

### Fixes
- Fixed `--primary-rgb` CSS variable not defined causing invisible selection highlight
- Fixed DHCP IP not loading in wizard (endpoint required auth before session existed)

## ⚡ Quick Install

### NAS Dashboard

```bash
curl -fsSL https://raw.githubusercontent.com/juanlusoft/dashboard/main/install.sh | sudo bash
```

### 💻 Backup Agent (Windows/Mac)

Download and install the Backup Agent on any PC you want to protect:

| Platform | Download |
|----------|----------|
| Windows | [HomePiNAS-Backup-Setup.exe](https://github.com/juanlusoft/dashboard/releases/latest) |
| macOS | [HomePiNAS-Backup.dmg](https://github.com/juanlusoft/dashboard/releases/latest) |

**Or build from source:**

```bash
git clone https://github.com/juanlusoft/dashboard.git
cd dashboard/agent
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
