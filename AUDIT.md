# HomePiNAS v2 — Plan de Auditoría por Secciones

> Última actualización: v2.13.26  
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

### ⬜ 3. Almacenamiento (Storage)
**Backend:** `backend/routes/storage/` (disks, pool, snapraid, badblocks, smart, cache, config, wizard, nfs)  
**Frontend:** `frontend/main.js` → `renderStorageDashboard()`

**Pendiente auditar:**
- Pool mergerfs: creación, montaje, estado
- SnapRAID: sync, scrub, historial, estado de paridad
- Discos: detección, temperatura SMART, uso
- Badblocks: tests de superficie, progreso
- Cache y configuración avanzada

---

### ⬜ 4. Docker
**Backend:** `backend/routes/docker.js`  
**Frontend:** `frontend/main.js` → `renderDockerManager()`

**Pendiente auditar:**
- Lista de contenedores: estado, puertos, imagen
- Acciones: start/stop/restart/logs
- Compose: despliegue y parada de stacks
- Permisos RBAC (ya verificado en auditoría anterior que es requireAdmin)

---

### ⬜ 5. Red (Network)
**Backend:** `backend/routes/network.js`, `ddns.js`, `samba.js`, `nfs.js`  
**Frontend:** `frontend/main.js` → `renderNetworkManager()`, `renderSambaSection()`

**Pendiente auditar:**
- Monitor de interfaces (tráfico, IPs)
- DDNS: múltiples proveedores, actualización
- Samba: comparticiones, permisos por usuario
- NFS: exports

---

### ⬜ 6. Gestor de Archivos (Files)
**Backend:** `backend/routes/files.js`  
**Frontend:** `frontend/main.js` → `renderFilesView()`

**Pendiente auditar:**
- Navegación de directorios
- Upload/download/drag&drop
- Preview de archivos
- Copiar/pegar/mover/eliminar
- Permisos de acceso por rol

---

### ⬜ 7. Terminal
**Backend:** `backend/routes/terminal.js` (WebSocket + node-pty)  
**Frontend:** `frontend/main.js` → `renderTerminalView()`

**Pendiente auditar:**
- Sesión PTY: creación, redimensionado, cierre
- Seguridad: acceso restringido por rol
- Manejo de desconexiones

---

### ⬜ 8. Sistema (System)
**Backend:** `backend/routes/system.js` (parcialmente auditado en Resumen)  
**Frontend:** `frontend/main.js` → `renderSystemView()`

**Pendiente auditar:**
- Info detallada del sistema (más allá del resumen)
- Gestión de actualizaciones OTA
- Configuración de ventiladores (modos PWM)
- Logs del sistema desde esta vista

---

### ⬜ 9. Backup
**Backend:** `backend/routes/backup.js`  
**Frontend:** `frontend/main.js` → `renderBackupView()`

**Bugs conocidos ya corregidos:** dead `args.unshift()` (v2.13.24)  
**Pendiente auditar:**
- Creación de backup: destino, compresión, retención
- Listado y restauración de backups
- Scheduler de backups

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

### ⬜ 11. VPN (WireGuard)
**Backend:** `backend/routes/vpn.js`  
**Frontend:** `frontend/main.js` → `renderVPNView()`

**Pendiente auditar:**
- Instalación con barra de progreso asíncrona
- Creación/revocación de clientes + QR codes
- Estado de peers en tiempo real
- Hot-reload sin desconectar peers

---

### ⬜ 12. Cloud Sync (Syncthing)
**Backend:** `backend/routes/cloud-sync.js`  
**Frontend:** `frontend/main.js` → `renderCloudSyncView()`

**Pendiente auditar:**
- Detección automática de Syncthing
- Gestión de carpetas de sync
- Estado de conexión y peers

---

### ⬜ 13. Cloud Backup
**Backend:** `backend/routes/cloud-backup.js`  
**Frontend:** `frontend/main.js` → `renderCloudBackupView()`

**Pendiente auditar:**
- Proveedores soportados
- Programación de backups
- Estado y logs

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

### ⬜ 18. Scheduler (Tareas)
**Backend:** `backend/routes/scheduler.js`  
**Frontend:** parte del sistema

**Bugs ya corregidos:** temp file path (v2.13.24)  
**Pendiente auditar:**
- CRUD de tareas cron
- Ejecución y logs de tareas
- Validación de expresiones cron

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
| 20 | 2 | 18 | **10%** |

---

## Historial de Versiones (Auditoría)

| Versión | Cambios |
|---|---|
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
