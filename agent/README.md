# HomePiNAS Backup Agent v2

Agente de backup para Windows - **Pure Node.js, SIN Electron, SIN UI**

Todo el control se realiza desde el dashboard del NAS. El agente es invisible para el usuario.

## Características

- ✅ **Node.js puro** - Sin Electron, sin interfaz gráfica
- ✅ **Servicio Windows** - Se ejecuta como servicio del sistema (nssm)
- ✅ **Instalación silenciosa** - MSI/PowerShell sin interacción del usuario
- ✅ **Auto-descubrimiento** - Encuentra el NAS via mDNS o subnet scan
- ✅ **Control remoto** - Todo se configura desde el dashboard del NAS
- ✅ **Backup por VSS** - Imágenes completas del sistema con Volume Shadow Copy
- ✅ **Worker separado** - El backup corre como proceso PowerShell independiente

## Arquitectura

```
┌─────────────────────────────────────────────────────────────┐
│                     Dashboard del NAS                        │
│              (http://192.168.1.97:3000)                      │
└─────────────────────┬───────────────────────────────────────┘
                      │ HTTP Polling (cada 60s)
                      ▼
┌─────────────────────────────────────────────────────────────┐
│              HomePiNAS Backup Agent (Windows Service)        │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  agent-service.js                                      │  │
│  │  - Lee config de %PROGRAMDATA%/HomePiNAS/config.json  │  │
│  │  - Poll al NAS cada 60s                               │  │
│  │  - Reporta estado y resultados                        │  │
│  └───────────────────────────────────────────────────────┘  │
│                          │                                   │
│                          │ spawn (backup trigger)            │
│                          ▼                                   │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  workers/backup-worker.ps1                             │  │
│  │  - Proceso PowerShell separado                         │  │
│  │  - Escribe estado a JSON file                          │  │
│  │  - Ejecuta VSS + wimlib                                │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Instalación

### Opción 1: Desde el Dashboard del NAS (Recomendado)

1. En el dashboard del NAS, ve a **Dispositivos → Agregar PC**
2. Descarga el instalador generado
3. Ejecuta como Administrador en el PC Windows:
   ```powershell
   .\install.ps1
   ```

### Opción 2: Instalación Manual

```powershell
# Descargar el agente
git clone http://192.168.1.97:3000/juanlu/dashboard.git
cd dashboard\agent

# Instalar dependencias
npm install

# Ejecutar instalador (como Administrador)
powershell -ExecutionPolicy Bypass -File install.ps1 -NASAddress 192.168.1.97 -NASPort 3000
```

### Opción 3: Instalación Silenciosa (Deploy masivo)

```powershell
# Para deploy en múltiples PCs (GPO, SCCM, etc.)
powershell -ExecutionPolicy Bypass -File install.ps1 -NASAddress 192.168.1.97 -NASPort 3000 -NoRestart
```

## Estructura de Archivos

```
agent/
├── agent-service.js      # Servicio principal Node.js
├── workers/
│   └── backup-worker.ps1 # Worker de backup (PowerShell)
├── src/                  # Módulos compartidos (backup, api, etc.)
├── install.ps1           # Script de instalación
├── package.json
└── README.md
```

## Configuración

El agente lee su configuración de:
```
%PROGRAMDATA%\HomePiNAS\config.json
```

Ejemplo:
```json
{
  "nasAddress": "192.168.1.97",
  "nasPort": 3000,
  "agentId": "agent-abc123",
  "agentToken": "token-xyz789",
  "status": "approved",
  "backupType": "image",
  "backupPaths": ["C:\\Users", "C:\\Data"],
  "schedule": "0 3 * * *",
  "sambaShare": "active-backup",
  "sambaUser": "backup",
  "sambaPass": "secret"
}
```

**Nota:** La configuración se gestiona desde el dashboard del NAS. No edites este archivo manualmente.

## Flujo de Operación

### 1. Inicio del Agente

```
1. Leer config.json
2. Si no hay config → Auto-discovery (mDNS + subnet scan)
3. Registrarse con el NAS
4. Iniciar polling (cada 60s)
```

### 2. Polling al NAS

Cada 60 segundos:
```
GET /api/active-backup/agent/poll
Headers: X-Agent-Token: <token>

Respuesta:
{
  "status": "approved",
  "action": "backup",  // opcional, si el NAS triggera backup manual
  "config": { ... }    // configuración actualizada
}
```

### 3. Ejecución de Backup

Cuando el NAS ordena un backup:

```
1. Agente spawn PowerShell worker
2. Worker escribe estado a status.json cada 5s
3. Agente monitorea status.json y reporta progreso al NAS
4. Worker completa → Agente reporta resultado final
```

### 4. Backup con VSS (Image Backup)

El worker PowerShell ejecuta:

```powershell
# 1. Conectar al share del NAS
net use \\NAS\share /user:user pass

# 2. Crear VSS shadow copy
$vss = (Get-WmiObject -List Win32_ShadowCopy).Create("C:\", "ClientAccessible")

# 3. Capturar con wimlib
wimlib-imagex.exe capture <shadow_device> <dest>\disk.wim

# 4. Borrar VSS
$sc.Delete()

# 5. Desconectar share
net use \\NAS\share /delete
```

## API del NAS

### Registro
```
POST /api/active-backup/agent/register
Body: { hostname, ip, os, mac }
Respuesta: { agentId, agentToken, status }
```

### Poll
```
GET /api/active-backup/agent/poll
Headers: X-Agent-Token: <token>
Respuesta: { status, action?, config? }
```

### Reporte
```
POST /api/active-backup/agent/report
Headers: X-Agent-Token: <token>
Body: { status, duration, error?, details? }
```

## Logs

- **Agente:** `%PROGRAMDATA%\HomePiNAS\agent.log`
- **Worker:** `%PROGRAMDATA%\HomePiNAS\backup-worker.log`
- **Servicio stdout:** `%PROGRAMDATA%\HomePiNAS\service.log`
- **Servicio stderr:** `%PROGRAMDATA%\HomePiNAS\service-error.log`

## Troubleshooting

### El agente no encuentra el NAS

1. Verificar que el NAS está encendido y accesible
2. Verificar firewall (puerto 3000 o 443)
3. Forzar dirección manual en config.json

### El backup falla con error VSS

1. Ejecutar como Administrador (requerido para VSS)
2. Verificar que el servicio Volume Shadow Copy está running
3. Verificar espacio libre en disco

### El servicio no arranca

```powershell
# Verificar estado
Get-Service HomePiNASBackup

# Ver logs
Get-Content "$env:PROGRAMDATA\HomePiNAS\service-error.log"

# Reinstalar servicio
.\install.ps1
```

## Desinstalación

```powershell
# Detener servicio
net stop HomePiNASBackup

# Eliminar servicio
sc delete HomePiNASBackup

# Eliminar archivos
rmdir /s /q "%PROGRAMFILES%\HomePiNAS"
rmdir /s /q "%PROGRAMDATA%\HomePiNAS"
```

O ejecutar:
```
%PROGRAMFILES%\HomePiNAS\uninstall.bat
```

## Desarrollo

### Build

```bash
cd agent
npm install
```

### Test

```bash
npm test
npm run test:watch
```

### Debug (modo consola)

```bash
# Detener servicio
net stop HomePiNASBackup

# Ejecutar en consola
node agent-service.js
```

## Versiones

- **v2.0.0** - Reescritura completa: Node.js puro, sin Electron
- **v1.x.x** - Versión anterior con Electron (deprecated)

## Licencia

MIT - HomePiNAS (homelabs.club)
