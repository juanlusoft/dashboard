# HomePiNAS v2 — Plan de Auditoría por Secciones

> Última actualización: v2.13.30  
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

### ⬜ 10. Active Backup
**Backend:** `backend/routes/active-backup.js`  
**Frontend:** `frontend/main.js` → `renderActiveBackupView()`

**Pendiente auditar:**
- Agente de backup para Windows/Mac
- Backup de imagen y de archivos
- Versionado y restauración
- Herramienta USB recovery

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

### ⬜ 14. Usuarios (Users)
**Backend:** `backend/routes/users.js`, `totp.js`, `auth.js`  
**Frontend:** `frontend/main.js` → `renderUsersView()`

**Bugs ya corregidos en sesiones anteriores (v2.13.23):** 14 fixes de auditoría completa  
**Pendiente:** verificar que los fixes funcionan correctamente en la UI

---

### ⬜ 15. Logs
**Backend:** `backend/routes/logs.js`  
**Frontend:** `frontend/main.js` → `renderLogsView()`

**Pendiente auditar:**
- Log del sistema, seguridad, aplicación
- Filtrado y búsqueda
- Exportación

---

### ⬜ 16. Notificaciones
**Backend:** `backend/routes/notifications.js`  
**Frontend:** `frontend/main.js` → `renderNotificationsSection()`

**Pendiente auditar:**
- Configuración SMTP
- Test de envío
- Alertas: UPS, temperatura, eventos de seguridad

---

### ⬜ 17. UPS
**Backend:** `backend/routes/ups.js`  
**Frontend:** parte de `renderSystemView()` o sección propia

**Pendiente auditar:**
- Detección APC UPS
- Estado: carga, autonomía, voltaje
- Acciones: shutdown seguro

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

### ⬜ 19. HomeStore
**Backend:** `backend/routes/homestore.js`  
**Frontend:** `frontend/main.js` → `renderHomeStoreView()`

**Pendiente auditar:**
- Catálogo de aplicaciones
- Instalación/desinstalación
- Estado de apps instaladas

---

### ⬜ 20. Stacks
**Backend:** `backend/routes/stacks.js`  
**Frontend:** `frontend/main.js` — vista de stacks

**Pendiente auditar:**
- Gestión de Docker Compose stacks
- Diferencia con sección Docker principal

---

## Progreso General

| Total secciones | Auditadas | Pendientes | % Completado |
|---|---|---|---|
| 20 | 13 | 7 | **65%** |

---

## Historial de Versiones (Auditoría)

| Versión | Cambios |
|---|---|
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
