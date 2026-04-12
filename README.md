# HomePiNAS v2.13.34

Premium NAS Dashboard for Raspberry Pi CM5 - Homelabs.club Edition

![HomePiNAS Dashboard](https://img.shields.io/badge/version-2.13.34-brightgreen)
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

## 🆕 What's New in v2.13.31

### Auditoría Active Backup, Logs, Notificaciones, UPS, HomeStore, Stacks — ~30 fixes

- **🔴 fix(active-backup.js)** — 7 endpoints de recovery/pending sin `requireAdmin` → escalada de privilegios
- **🔴 fix(notifications.js)** — CRLF injection en asunto del email (header injection / email spoofing)
- **🔴 fix(notifications.js)** — Mensaje sin sanitizar en email texto plano → CRLF injection
- **🔴 fix(notifications.js)** — POST /config/email, /config/telegram, /config/error-reporting sin `requireAdmin`
- **🔴 fix(homestore.js)** — Path traversal en `ensureDirectory()`: rutas con `../` podían crear directorios fuera de APPS_BASE
- **🟠 fix(homestore.js)** — Rutas install/uninstall/start/stop/restart/update solo `requireAuth` → `requireAdmin`
- **🟠 fix(stacks.js)** — Rutas create/update/up/down/restart/delete/pull solo `requireAuth` → `requireAdmin`
- **🟠 fix(notifications.js)** — Mensaje Telegram sin sanitizar con parse_mode Markdown → injection
- **🟠 fix(notifications.js)** — Validación de formato email en campos from/to
- **🟠 fix(notifications.js)** — POST /test/email y /test/telegram → `requireAdmin`
- **🟠 fix(logs.js)** — GET /auth, /app, /file, /files sin `requireAdmin` → cualquier usuario leía logs sensibles
- **🟡 fix(active-backup.js)** — Dead code: `if (true)` wrapper eliminado
- **🟡 fix(main.js)** — `abFetch()` (función inexistente) → `authFetch()` con `API_BASE` correcto en Active Backup
- **🟡 fix(main.js)** — XSS en HomeStore: escapeHtml en app.name, app.description, app.icon, app.archNote, cat.name
- **🟡 fix(main.js)** — app.docs URL validada para solo permitir http/https antes de renderizar href
- **🟡 fix(main.js)** — app.icon: validación estricta de URL (https?://) antes de usar en img src

## 🆕 What's New in v2.13.30

### Auditoría Red, Terminal, Sistema, Backup, Scheduler, VPN, Cloud Sync, Cloud Backup — ~25 fixes

- **🔴 fix(terminal.js)** — Todas las rutas HTTP solo requerían auth → ahora `requireAdmin`
- **🔴 fix(terminal-ws.js)** — WebSocket PTY sin check de rol admin → cualquier usuario autenticado podía abrir terminal
- **🔴 fix(ups.js)** — `POST /config` y `POST /test` sin autenticación → endpoints expuestos
- **🔴 fix(update.js)** — `POST /apply` y `POST /apply-os` solo requerían auth → escalada de privilegios en OTA
- **🔴 fix(backup.js)** — Rutas de escritura solo requerían auth → cualquier usuario podía crear/restaurar/eliminar backups
- **🔴 fix(scheduler.js)** — Rutas de escritura solo requerían auth → cualquier usuario podía crear/modificar/eliminar tareas cron
- **🟠 fix(system.js)** — `POST /fan` y `POST /fan/mode` solo requerían auth → control de hardware sin restricción
- **🟠 fix(network.js)** — Nombre de interfaz no escapado antes de construir regex → crash con chars especiales
- **🟠 fix(samba.js)** — Función `requireAdmin` local en lugar de importar de `rbac.js` → inconsistencia RBAC
- **🟠 fix(ddns.js)** — `POST /services/:id/update` sin `requireAdmin` → fuerza actualización DDNS sin privilegios
- **🟠 fix(cloud-sync.js)** — Path traversal: `.startsWith(STORAGE_BASE)` sin normalizar → `path.normalize + path.sep`
- **🟠 fix(cloud-backup.js)** — `sync.name` sin sanitizar `\r\n` antes de insertar en crontab → crontab injection
- **🟡 fix(vpn.js)** — DNS sin validación de formato IP → valor arbitrario en config WireGuard
- **🟡 fix(main.js)** — Samba frontend usaba `status.active` pero backend devuelve `status.running`

## 🆕 What's New in v2.13.29

### Auditoría Docker — 5 fixes
- **🔴 fix(docker.js)** — `POST /update` solo requería auth, no admin → escalada de privilegios
- **🔴 fix(docker.js)** — `PUT /compose/:name` solo requería auth → cualquier usuario podía editar compose
- **🟠 fix(docker.js)** — `POST /compose/import` y `POST /notes/:containerId` → `requireAdmin`
- **🟠 fix(docker.js)** — Error de socket Docker enmascarado como array vacío → ahora devuelve 503
- **🟠 fix(main.js)** — Frontend distingue "Docker no disponible" de "lista vacía"

## 🆕 What's New in v2.13.28

### Auditoría Gestor de Archivos — 5 fixes (críticos → altos)
- **🔴 fix(main.js)** — Copy enviaba `srcPath`/`destPath`; backend espera `source`/`destination` — operaciones silenciosas sin efecto
- **🔴 fix(main.js)** — XSS: `file.path || file.name` sin escapar en resultados de búsqueda
- **🔴 fix(files.js)** — Upload usa `f.originalname` directamente → path traversal (`../../../etc/passwd`)
- **🟠 fix(files.js)** — Move sin comprobación de destino existente → sobrescritura silenciosa de datos
- **🟠 fix(files.js)** — Copy/Move sin comprobación `source === destination` → error de filesystem confuso

## 🆕 What's New in v2.13.27

### Auditoría Almacenamiento — 9 fixes
- **🔴 fix(config.js)** — `validateSession()` undefined causaba crash en runtime; reemplazado por `requireAdmin`
- **🔴 fix(disks.js)** — fstab escribía `ext4` aunque el disco fuera XFS; corregido en add-to-pool y mount-standalone
- **🟠 fix(nfs.js)** — `requireAdmin` local no usaba RBAC estándar; reemplazado por `rbac.js`
- **🟠 fix(badblocks.js)** — `cache/mover/trigger` solo requería auth, no admin
- **🟠 fix(smart.js)** — `smart/:device/test` solo requería auth, no admin
- **🟠 fix(badblocks.js)** — endpoint `/cache/status` duplicado eliminado (170 líneas)
- **🟡 fix(múltiples)** — `snapraidSyncStatus` muerto eliminado de 6 archivos (pool, badblocks, smart, config, cache, wizard)
- **🟡 fix(main.js)** — `Promise.all` en `renderStorageDashboard` sin manejo de errores en 2 de 3 fetches

## 🆕 What's New in v2.13.26

### Auditoría sección Resumen — 3 fixes
- **🔴 fix(system.js)** — `readIna238()` declarada sin `async`: crasheaba Node.js al activar INA238
- **🔴 fix(frontend)** — `globalStats` inicializado con todos los campos; el dashboard ya no muestra "0" antes del primer fetch
- **🟠 fix(frontend)** — Tarjeta de consumo: oculta correctamente si el sensor desaparece; campos nulos muestran `--` en lugar de `"null"`

## 🆕 What's New in v2.13.25

### Active Directory — Auditoría y correcciones (7 fixes)
- **🔴 Bug** — `userAccountControl` siempre mostraba "Activo": corregido con parsing de bit flag `!(parseInt(value) & 2)`
- **✨ Nuevo** — Habilitar/deshabilitar usuarios AD desde el dashboard (botón 🔒/🔓 por usuario)
- **✨ Nuevo** — Ver miembros de grupos AD con botón "👥 Ver" (endpoint `GET /groups/:name/members`)
- **🔧 Tests** — Mock de `exec` muerto eliminado; mock de `spawn` corregido (stdin faltaba)
- **🔧 Tests** — Tests añadidos para enable, disable y listmembers

## 🆕 What's New in v2.13.24

### Fixes de calidad de código (6 bugs)
- **system.js** — Busy-wait síncrono de INA238 reemplazado por `await setTimeout` (libera event loop)
- **scheduler.js** — Temp file movido de `/mnt/storage/.tmp` a `os.tmpdir()` (seguro antes de montar storage)
- **backup.js** — Eliminado código muerto `args.unshift()` que era sobreescrito inmediatamente
- **users.js** — Corregido orden de argumentos en `logSecurityEvent` (user/ip invertidos)
- **badblocks.js** — Eliminado import `validateSession` no utilizado
- **disks.js** — Eliminado `snapraidSyncStatus` declarado pero nunca usado

## 🆕 What's New in v2.13.23

### Auditoría de usuarios — 14 fixes (críticos → bajos)
- **🔴 C1** — 2FA arreglado para usuarios multi-usuario (buscaba en admin legacy en lugar de `data.users`)
- **🔴 C2** — Sesiones invalidadas al eliminar usuario (`destroyByUsername`)
- **🔴 C3** — Sesiones invalidadas al cambiar contraseña (propia y por admin)
- **🟠 A1** — Docker, red, discos y SnapRAID ahora requieren rol admin (antes solo requireAuth)
- **🟠 A2** — Recovery codes para 2FA: 8 códigos de un solo uso generados al activar
- **🟠 A3** — Reset de emergencia restringido a localhost (antes accesible desde la red local)
- **🟡 M1** — `lastLogin` se actualiza correctamente en cada login (auth y 2FA)
- **🟡 M2** — `createSambaUser()` unificado en `utils/sambaUser.js` (eliminada duplicación)
- **🟡 M3** — Límite de 5 sesiones simultáneas por usuario
- **🟡 M4** — Admin puede deshabilitar 2FA de otro usuario desde el dashboard
- **🟢 B1** — Contraseña mínima 8 caracteres + al menos una letra y un número
- **🟢 B2** — `requireAdmin` unificado usando `rbac.js` en todos los routers
- **🟢 B3** — Badge de estado 2FA visible en tabla de usuarios; botón "Desactivar 2FA" para admins
- **🟢 B4** — Campos `email` y `displayName` añadidos a usuarios (opcionales)

## 🆕 What's New in v2.13.22

### Auto-activación INA238 sin intervención manual
- **🔧 install.sh** — `setup_ina238()` escanea buses I2C, activa el driver y crea servicio systemd para persistir en reinicios
- **🔧 system.js** — `readIna238()` intenta activar el driver automáticamente si el chip está en I2C pero no en hwmon; guarda bus/addr en data.json para no re-escanear

## 🆕 What's New in v2.13.21

### Fix tarjeta Consumo — no aparecía en algunos NAS
- **🔧 system.js** — Detección INA238 ampliada: acepta nombres como `ina238-i2c-10-48` además de `ina238`
- **🔧 main.js** — Grid se ajusta a 4 columnas automáticamente si el chip no está disponible (sin hueco vacío)

## 🆕 What's New in v2.13.20

### Fix dashboard — repaso completo de campos sin actualización en quickRefresh
- **🔧 main.js** — `hostname`, `distro`, `cpuModel`, IP Local y contador DDNS ahora tienen ID y se actualizan en cada ciclo de stats

## 🆕 What's New in v2.13.19

### Fix tarjeta Memoria — Total y Swap mostraban 0
- **🔧 main.js** — `ramTotal` y `swap` añadidos al quickRefresh con IDs; misma causa que el bug de CPU

## 🆕 What's New in v2.13.18

### Fix tarjeta CPU — núcleos, hilos y GHz mostraban 0
- **🔧 main.js** — Añadidos IDs a los spans de núcleos/hilos/GHz; se actualizan en el quickRefresh cuando los datos llegan del backend

## 🆕 What's New in v2.13.17

### ⚡ Monitor de Consumo Eléctrico (INA238)
- **Nueva tarjeta en el dashboard** — muestra vatios, voltaje, corriente y temperatura del chip en tiempo real
- **Detección automática** — busca el chip INA238 en los dispositivos hwmon del sistema
- **Color dinámico** — verde (<30W), naranja (30–50W), rojo (>50W)
- **Se oculta automáticamente** si el hardware no está presente

## 🆕 What's New in v2.13.16

### Fix ventilador EMC2305 — verificado en hardware real
- **🔧 system.js** — Registros tach corregidos: fan1 usa `0x3E`/`0x3F` (antes `0x46`/`0x47` que era fan3)
- **🔧 system.js** — Fórmula RPM corregida: `(msb<<5)|(lsb>>3)` en lugar de `(msb<<8)|lsb`
- **🔧 system.js** — `GET /fan/status` ahora lee RPM y PWM por I2C directo si hwmon no está disponible
- **🔧 system.js** — `EMC2305_HWMON_PATH` dinámico: busca el número de hwmon real en lugar de hardcodear hwmon3
- **🔧 system.js** — Detección de chip mejorada: comprueba registro Product ID (0xFD) en lugar de 0x00

## 🆕 What's New in v2.13.15

### Fixes calidad — tercera ronda
- **🔧 cloud-sync.js** — Endpoint `POST /folders/:id/unshare` añadido; ahora se pueden quitar dispositivos de carpetas Syncthing
- **🔧 vpn.js** — Detección de interfaz de red mejorada: 3 pasos (ip route → ip link UP → fallback `end0`)
- **🔧 ups.js** — Shutdown async (`execFile`); resetea `shutdownInitiated` si el comando falla
- **🔧 docker.js** — `docker compose up/down` usa flag `-f <ruta_completa>` explícita
- **🔧 system.js** — Modo ventilador persiste en `data.json`; ya no depende de parsear comentarios del archivo de config
- **🔧 cloud-sync.js** — Cache de API key de Syncthing se invalida cuando cambia el mtime del config.xml

## 🆕 What's New in v2.13.14

### Fixes restantes — segunda ronda de auditoría
- **🔧 snapraid.js** — Scrub convertido a async (spawn); ya no bloquea el event loop durante el proceso de 2h; nuevo endpoint `GET /snapraid/scrub/progress`
- **🔧 backup.js** — `syncBackupCronJobs()` escribe jobs activados al crontab del sistema cuando se crean/editan/borran
- **🔧 badblocks.js** — `formatBytes` añadido al import desde `./shared`
- **🔧 ups.js** — `notifyOnPower` detecta cambios AC/batería y genera eventos en el historial
- **🔧 network.js** — `dhcpcd.conf` ahora se escribe con `sudo cp` desde tmp (respeta permisos de root)
- **🔧 users.js** — `/sbin/nologin` → `/usr/sbin/nologin` (compatible con Debian Bookworm)
- **🔧 scheduler.js** — Pipes `|` y `;` permitidos en comandos legítimos; solo se bloquean patrones realmente peligrosos

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
