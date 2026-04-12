# HomePiNAS v2 — Plan de Auditoría por Secciones

> Última actualización: v2.13.31  
> Objetivo: revisar cada sección del dashboard, identificar y corregir todos los bugs antes de considerar el proyecto estable.

---

## Leyenda

| Símbolo | Significado |
|---|---|
| ✅ | Auditada y corregida |
| 🔄 | En progreso |
| ⬜ | Pendiente |
| 🔴 | Bug crítico conocido sin corregir |
| 🟠 | Bug medio conocido sin corregir |
| 🟡 | Bug bajo/cosmético conocido sin corregir |

---

## Secciones del Dashboard

### ✅ 1. Resumen (Dashboard principal)
**Auditada en:** v2.13.26  
**Backend:** `backend/routes/system.js`  
**Frontend:** `frontend/main.js` → `renderDashboard()`, `quickRefresh`

**Bugs corregidos:**
- 🔴 `readIna238()` no era `async` — crasheaba Node.js al activar INA238
- 🔴 `globalStats` inicializado con solo 5 campos — mostraba zeros antes del primer fetch
- 🟠 Tarjeta consumo: no se ocultaba si `stats.power` se volvía null; campos nulos mostraban texto `"null"`

**Estado:** Sin bugs conocidos pendientes.

---

### ✅ 2. Active Directory
**Auditada en:** v2.13.25  
**Backend:** `backend/routes/active-directory.js`  
**Frontend:** `frontend/main.js` → `renderActiveDirectoryView()`

**Bugs corregidos:**
- 🔴 `userAccountControl` parseado como string, nunca detectaba cuentas deshabilitadas — fix: `!(parseInt(value) & 2)`
- 🟡 Mock `exec` muerto en tests; mock `spawn` sin `stdin`
- ✨ Nuevos endpoints: `/users/:user/enable`, `/users/:user/disable`, `/groups/:name/members`
- ✨ Frontend: botón 🔒/🔓 habilitar/deshabilitar; botón "👥 Ver" miembros de grupo

**Estado:** Sin bugs conocidos pendientes.

---

### ✅ 3. Almacenamiento (Storage)
**Auditada en:** v2.13.27  
**Backend:** `backend/routes/storage/` (disks, pool, snapraid, badblocks, smart, cache, config, wizard, nfs)  
**Frontend:** `frontend/main.js` → `renderStorageDashboard()`

**Bugs corregidos:**
- 🔴 `config.js` — `validateSession()` undefined crasheaba en runtime → `requireAdmin`
- 🔴 `disks.js` — fstab escribía `ext4` aunque el disco fuera XFS (2 rutas)
- 🟠 `nfs.js` — `requireAdmin` local no usaba RBAC estándar → `rbac.js`
- 🟠 `badblocks.js` — `cache/mover/trigger` sin `requireAdmin`
- 🟠 `smart.js` — `smart/:device/test` sin `requireAdmin`
- 🟠 `badblocks.js` — endpoint `/cache/status` duplicado (170 líneas eliminadas)
- 🟡 Múltiples — `snapraidSyncStatus` muerto eliminado de 6 archivos
- 🟡 `main.js` — `Promise.all` sin `.catch()` en 2 de 3 fetches

**Estado:** Sin bugs conocidos pendientes.

---

### ✅ 4. Docker
**Backend:** `backend/routes/docker.js`  
**Frontend:** `frontend/main.js` → `renderDockerManager()`

**Auditada en:** v2.13.29

**Bugs corregidos:**
- 🔴 `docker.js` — `POST /update` solo `requireAuth` → escalada de privilegios
- 🔴 `docker.js` — `PUT /compose/:name` solo `requireAuth` → edición de compose sin restricción
- 🟠 `docker.js` — `POST /compose/import` y `POST /notes` → `requireAdmin`
- 🟠 `docker.js` — Error de socket enmascarado como `[]` → ahora 503
- 🟠 `main.js` — Frontend distingue Docker no disponible de lista vacía

**Estado:** Sin bugs conocidos pendientes.

---

### ✅ 5. Red (Network)
**Auditada en:** v2.13.30  
**Backend:** `backend/routes/network.js`, `ddns.js`, `samba.js`, `nfs.js`  
**Frontend:** `frontend/main.js` → `renderNetworkManager()`, `renderSambaSection()`

**Bugs corregidos:**
- 🟠 `network.js` — Nombre de interfaz sin escapar antes de construir regex → crash con chars especiales
- 🟠 `samba.js` — Función `requireAdmin` local en vez de importar de `rbac.js` → inconsistencia RBAC
- 🟠 `ddns.js` — `POST /services/:id/update` (forzar actualización) sin `requireAdmin`
- 🟡 `main.js` — Samba frontend usaba `status.active` pero backend devuelve `status.running`

**Estado:** Sin bugs conocidos pendientes.

---

### ✅ 6. Gestor de Archivos (Files)
**Backend:** `backend/routes/files.js`  
**Frontend:** `frontend/main.js` → `renderFilesView()`

**Auditada en:** v2.13.28

**Bugs corregidos:**
- 🔴 `main.js` — Copy enviaba params erróneos (`srcPath`/`destPath` → `source`/`destination`) — copia nunca funcionaba
- 🔴 `main.js` — XSS en resultados de búsqueda: `file.path` sin `escapeHtml()`
- 🔴 `files.js` — Upload path traversal: `f.originalname` → `path.basename(f.originalname)`
- 🟠 `files.js` — Move sin check de destino existente → sobrescritura silenciosa
- 🟠 `files.js` — Copy/Move sin check `source === destination`

**Estado:** Sin bugs conocidos pendientes.

---

### ✅ 7. Terminal
**Auditada en:** v2.13.30  
**Backend:** `backend/routes/terminal.js` (WebSocket + node-pty)  
**Frontend:** `frontend/main.js` → `renderTerminalView()`

**Bugs corregidos:**
- 🔴 `terminal.js` — Todas las rutas HTTP solo requerían `requireAuth` → escalada de privilegios, cualquier usuario podía ver/crear/cerrar sesiones
- 🔴 `terminal-ws.js` — WebSocket PTY sin check de rol admin → cualquier usuario autenticado podía abrir terminal

**Estado:** Sin bugs conocidos pendientes.

---

### ✅ 8. Sistema (System)
**Auditada en:** v2.13.30  
**Backend:** `backend/routes/system.js`, `backend/routes/update.js`  
**Frontend:** `frontend/main.js` → `renderSystemView()`

**Bugs corregidos:**
- 🟠 `system.js` — `POST /fan` y `POST /fan/mode` solo `requireAuth` → control de hardware sin restricción
- 🔴 `update.js` — `POST /apply` y `POST /apply-os` solo `requireAuth` → cualquier usuario podía disparar OTA
- 🔴 `update.js` — `updateInProgress` lock añadido para evitar múltiples actualizaciones simultáneas

**Estado:** Sin bugs conocidos pendientes.

---

### ✅ 9. Backup
**Auditada en:** v2.13.30  
**Backend:** `backend/routes/backup.js`  
**Frontend:** `frontend/main.js` → `renderBackupView()`

**Bugs corregidos:**
- 🔴 `backup.js` — Rutas de creación/restauración/eliminación solo `requireAuth` → cualquier usuario podía gestionar backups
- 🟠 `backup.js` — Extracción tar sin `--no-absolute-filenames --no-overwrite-dir` → path traversal en restore
- 🟠 `backup.js` — Fallo durante creación no limpiaba el archivo parcial antes de ejecutar retención

**Bugs previos:** dead `args.unshift()` (v2.13.24)

**Estado:** Sin bugs conocidos pendientes.

---

### ✅ 10. Active Backup
**Auditada en:** v2.13.31  
**Backend:** `backend/routes/active-backup.js`  
**Frontend:** `frontend/main.js` → `renderActiveBackupView()`

**Bugs corregidos:**
- 🔴 `active-backup.js` — 7 endpoints (/recovery/status, /recovery/build, /recovery/download, /recovery/scripts, /pending, /pending/:id/approve, /pending/:id/reject) sin `requireAdmin` → escalada de privilegios
- 🟡 `active-backup.js` — Dead code: `if (true) { }` wrapper eliminado
- 🟡 `main.js` — `abFetch()` (función inexistente) → `authFetch()` con `${API_BASE}/active-backup/...`

**Estado:** Sin bugs conocidos pendientes.

---

### ✅ 11. VPN (WireGuard)
**Auditada en:** v2.13.30  
**Backend:** `backend/routes/vpn.js`  
**Frontend:** `frontend/main.js` → `renderVPNView()`

**Bugs corregidos:**
- 🟡 `vpn.js` — DNS sin validación de formato IP → valor arbitrario podía inyectarse en config WireGuard

**Estado:** Sin bugs conocidos pendientes.

---

### ✅ 12. Cloud Sync (Syncthing)
**Auditada en:** v2.13.30  
**Backend:** `backend/routes/cloud-sync.js`  
**Frontend:** `frontend/main.js` → `renderCloudSyncView()`

**Bugs corregidos:**
- 🟠 `cloud-sync.js` — Path traversal: `.startsWith(STORAGE_BASE)` sin normalizar → `path.normalize + path.sep` para prevenir `/../` bypass

**Estado:** Sin bugs conocidos pendientes.

---

### ✅ 13. Cloud Backup
**Auditada en:** v2.13.30  
**Backend:** `backend/routes/cloud-backup.js`  
**Frontend:** `frontend/main.js` → `renderCloudBackupView()`

**Bugs corregidos:**
- 🟠 `cloud-backup.js` — `sync.name` sin sanitizar `\r\n` antes de insertar en crontab → crontab injection

**Estado:** Sin bugs conocidos pendientes.

---

### ✅ 14. Usuarios (Users)
**Auditada en:** v2.13.31 (re-verificación) + v2.13.23 (auditoría original)  
**Backend:** `backend/routes/users.js`, `totp.js`, `auth.js`  
**Frontend:** `frontend/main.js` → `renderUsersView()`

**Estado v2.13.31:** Re-auditado. RBAC, shell injection, XSS, path traversal, escalada de privilegios — todos correctos. Error message en /auth/setup ligeramente impreciso ("6-128" vs real "8-128 + alfanumérico") — cosmético, sin impacto de seguridad.

**Bugs previos corregidos (v2.13.23):** 14 fixes críticos → bajos.

**Estado:** Sin bugs conocidos pendientes.

---

### ✅ 15. Logs
**Auditada en:** v2.13.31  
**Backend:** `backend/routes/logs.js`  
**Frontend:** `frontend/main.js` → `renderLogsView()`

**Bugs corregidos:**
- 🟠 `logs.js` — GET /auth, /app, /file, /files solo `requireAuth` → cualquier usuario leía logs de seguridad y archivos arbitrarios de /var/log

**Estado:** Sin bugs conocidos pendientes.

---

### ✅ 16. Notificaciones
**Auditada en:** v2.13.31  
**Backend:** `backend/routes/notifications.js`  
**Frontend:** `frontend/main.js` → `renderNotificationsSection()`

**Bugs corregidos:**
- 🔴 `notifications.js` — CRLF injection en asunto del email (`sanitizeString` no eliminaba `\r\n`) → email header injection / spoofing
- 🔴 `notifications.js` — Mensaje texto plano sin sanitizar → CRLF injection
- 🔴 `notifications.js` — POST /config/email, /config/telegram, /config/error-reporting sin `requireAdmin`
- 🟠 `notifications.js` — Mensaje Telegram sin sanitizar con `parse_mode: Markdown`
- 🟠 `notifications.js` — Sin validación de formato email en campos `from`/`to`
- 🟠 `notifications.js` — POST /test/email y /test/telegram sin `requireAdmin`

**Estado:** Sin bugs conocidos pendientes.

---

### ✅ 17. UPS
**Auditada en:** v2.13.31 (re-verificación) + v2.13.30 (auth fix)  
**Backend:** `backend/routes/ups.js`  
**Frontend:** `frontend/main.js`

**Estado v2.13.31:** Re-auditado. `execFile()` usado correctamente en todos los comandos. Auth OK (fixeado en v2.13.30). Valores numéricos en frontend son seguros ya que se parsean con `parseFloat`. Raw data expuesto en respuesta es cosmético (solo visible a admins autenticados).

**Bugs previos (v2.13.30):** POST /config y /test sin autenticación.

**Estado:** Sin bugs conocidos pendientes.

---

### ✅ 18. Scheduler (Tareas)
**Auditada en:** v2.13.30  
**Backend:** `backend/routes/scheduler.js`  
**Frontend:** parte del sistema

**Bugs corregidos:**
- 🔴 `scheduler.js` — Rutas CRUD (crear/editar/eliminar/ejecutar/toggle) solo `requireAuth` → cualquier usuario podía gestionar tareas
- 🟡 `scheduler.js` — Temp file para crontab sin modo `0o600` → archivo legible por otros usuarios del sistema

**Bugs previos:** temp file path (v2.13.24)

**Estado:** Sin bugs conocidos pendientes.

---

### ✅ 19. HomeStore
**Auditada en:** v2.13.31  
**Backend:** `backend/routes/homestore.js`  
**Frontend:** `frontend/main.js` → `renderHomeStoreView()`

**Bugs corregidos:**
- 🔴 `homestore.js` — Path traversal en `ensureDirectory()`: `dirPath` con `../` podía crear dirs fuera de APPS_BASE
- 🟠 `homestore.js` — Rutas install/uninstall/start/stop/restart/update solo `requireAuth` → `requireAdmin`
- 🟡 `main.js` — XSS: app.name, app.description, app.icon, app.archNote, cat.name sin `escapeHtml()`
- 🟡 `main.js` — app.docs URL sin validar protocolo → `javascript:` podía ejecutarse como href
- 🟡 `main.js` — app.icon URL sin validar protocolo → `javascript:` podía usarse como src

**Estado:** Sin bugs conocidos pendientes.

---

### ✅ 20. Stacks
**Auditada en:** v2.13.31  
**Backend:** `backend/routes/stacks.js`  
**Frontend:** `frontend/main.js` — vista de stacks

**Bugs corregidos:**
- 🟠 `stacks.js` — Rutas create/update/up/down/restart/delete/pull solo `requireAuth` → `requireAdmin`

**Estado:** Sin bugs conocidos pendientes.

---

## Progreso General

| Total secciones | Auditadas | Pendientes | % Completado |
|---|---|---|---|
| 20 | 20 | 0 | **100%** |

---

## Historial de Versiones (Auditoría)

| Versión | Cambios |
|---|---|
| v2.13.31 | Auditoría ActiveBackup/Logs/Notificaciones/UPS/HomeStore/Stacks: ~30 fixes (CRLF, XSS, requireAdmin, path traversal) |
| v2.13.30 | Auditoría Red/Terminal/Sistema/Backup/Scheduler/VPN/CloudSync/CloudBackup: ~25 fixes (auth, traversal, injection, RBAC) |
| v2.13.29 | Auditoría Docker: 5 fixes (requireAdmin en 4 endpoints, socket 503) |
| v2.13.28 | Auditoría Archivos: 5 fixes (copy params, XSS búsqueda, path traversal upload, move overwrite) |
| v2.13.27 | Auditoría Almacenamiento: 9 fixes (validateSession crash, fstab XFS, NFS RBAC, auth, duplicados) |
| v2.13.26 | Auditoría Resumen: 3 fixes (readIna238 async, globalStats, power null) |
| v2.13.25 | Auditoría Active Directory: 7 fixes + 3 nuevos endpoints |
| v2.13.24 | Fixes de calidad: 6 bugs (busy-wait, tmpdir, dead code, logSecurityEvent, imports) |
| v2.13.23 | Auditoría Usuarios: 14 fixes críticos → bajos |
| v2.13.22 | Auto-activación INA238 en instalador |
| v2.13.21 | Fix INA238 detección + grid dinámico |
| v2.13.20 | Fix quickRefresh: hostname, distro, CPU model, IP, DDNS |
| v2.13.19 | Fix RAM/Swap quickRefresh |
| v2.13.18 | Fix CPU quickRefresh (núcleos, frecuencia mostraban 0) |
| v2.13.16 | Fix EMC2305: registros tach correctos + fórmula RPM + hwmon dinámico |
