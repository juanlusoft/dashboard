# Guía de Instalación del Agente Active Backup HomePiNAS

## Introducción

El agente Active Backup es un servicio de Windows que se ejecuta en segundo plano en tu PC y se comunica con tu HomePiNAS para realizar copias de imagen automáticas del sistema. Una vez instalado y aprobado, los backups se programarán automáticamente según tu calendario.

## Requisitos

- **Sistema Operativo:** Windows 10 o Windows 11
- **Acceso Administrativo:** Debes tener permisos de administrador en el equipo
- **Conectividad de Red:** Conexión estable con el NAS (misma red local o VPN)
- **Espacio en Disco del NAS:** Mínimo 50 GB libres (depende del tamaño del equipo a respaldar)
- **Acceso al Dashboard del NAS:** Para aprobar el equipo después de la instalación

## Paso 1: Descargar el Instalador

1. Abre un navegador en tu PC y accede al **Dashboard de HomePiNAS**
2. Ve a la sección **Active Backup** → **Descargas**
3. Haz clic en **Descargar Agente Windows** (versión compatible con tu arquitectura: x86 o x64)
4. El archivo se descargará como `ActiveBackupAgent-Setup.exe`

**Captura conceptual:**
```
┌─────────────────────────────────────┐
│ Dashboard HomePiNAS                 │
├─────────────────────────────────────┤
│ Active Backup > Descargas            │
│                                     │
│ ✓ Descargar Agente Windows (x64)   │
│   Tamaño: 45 MB                    │
│   Versión: 2.5.1                   │
└─────────────────────────────────────┘
```

## Paso 2: Instalación Silenciosa (Recomendado)

La instalación silenciosa no muestra interfaces gráficas y es la forma más rápida de desplegar el agente.

### Opción A: Desde PowerShell (Recomendado para Administradores)

1. Abre **PowerShell como Administrador**
2. Navega a la carpeta donde descargaste el instalador:
   ```powershell
   cd "C:\Users\tu_usuario\Downloads"
   ```
3. Ejecuta el instalador en modo silencioso:
   ```powershell
   .\ActiveBackupAgent-Setup.exe /S /D=C:\Program Files\ActiveBackupAgent
   ```
4. Espera a que se complete la instalación (aproximadamente 2-3 minutos)

### Opción B: Desde el Símbolo del Sistema

1. Abre **Símbolo del sistema (cmd) como Administrador**
2. Ejecuta:
   ```cmd
   cd C:\Users\tu_usuario\Downloads
   ActiveBackupAgent-Setup.exe /S /D=C:\Program Files\ActiveBackupAgent
   ```

### Opción C: Instalación Manual (Con Interfaz Gráfica)

1. Haz doble clic en `ActiveBackupAgent-Setup.exe`
2. Haz clic en **Siguiente** en la pantalla de bienvenida
3. Acepta los términos de licencia
4. Selecciona la carpeta de instalación (por defecto: `C:\Program Files\ActiveBackupAgent`)
5. Haz clic en **Instalar**
6. Permite que se instale el servicio de Windows
7. Haz clic en **Finalizar**

## Paso 3: Verificación de la Instalación

### En tu PC

1. Abre el **Administrador de tareas** (`Ctrl + Shift + Esc`)
2. Ve a la pestaña **Servicios**
3. Busca el servicio llamado **"ActiveBackupAgent"**
4. Verifica que su estado sea **"En ejecución"**

**Captura conceptual:**
```
┌──────────────────────────────────────┐
│ Administrador de tareas               │
├──────────────────────────────────────┤
│ Servicios                             │
│                                      │
│ Nombre              │ Estado          │
│ ─────────────────────┼─────────────── │
│ ActiveBackupAgent    │ En ejecución  │
│ AudioEndpointBuil... │ En ejecución  │
│ BFE                 │ Detenido       │
└──────────────────────────────────────┘
```

Alternativamente, desde PowerShell:
```powershell
Get-Service -Name ActiveBackupAgent | Select-Object Name, Status
```

Resultado esperado:
```
Name                 Status
─────────────────────────────
ActiveBackupAgent    Running
```

### En el Dashboard del NAS

1. Accede al **Dashboard de HomePiNAS**
2. Ve a **Active Backup** → **Equipos**
3. Deberías ver tu PC listado con estado **"Pendiente de aprobación"**

**Captura conceptual:**
```
┌───────────────────────────────────────────┐
│ Dashboard HomePiNAS                       │
├───────────────────────────────────────────┤
│ Active Backup > Equipos                   │
│                                          │
│ PC-JUAN-W11          | Pendiente ⏳      │
│ (UUID: abc123...)    | Conectado ✓       │
│                                          │
│ [Aprobar]  [Rechazar]  [Editar]         │
└───────────────────────────────────────────┘
```

## Paso 4: Aprobación del Equipo en el NAS

1. En el Dashboard del NAS, ve a **Active Backup** → **Equipos**
2. Busca tu PC en la lista (aparecerá con el nombre de tu máquina)
3. Haz clic en **[Aprobar]**
4. Opcionalmente, personaliza:
   - **Nombre amigable:** (ej: "PC Oficina")
   - **Descripción:** (ej: "Windows 11 - Trabajo")
   - **Frecuencia de backup:** Diaria, semanal, mensual
   - **Hora de ejecución:** (Por defecto: 03:00 UTC)
5. Haz clic en **Guardar**

**Captura conceptual:**
```
┌───────────────────────────────────────────┐
│ Aprobar Equipo para Active Backup         │
├───────────────────────────────────────────┤
│                                          │
│ Nombre Amigable:                         │
│ [PC Oficina          ]                   │
│                                          │
│ Descripción:                             │
│ [Windows 11 - Trabajo]                   │
│                                          │
│ Frecuencia:  [Diaria ▼]                  │
│ Hora:        [03:00 ▼]                   │
│                                          │
│              [Guardar]  [Cancelar]       │
└───────────────────────────────────────────┘
```

## Paso 5: Primer Backup Automático

Una vez aprobado, el agente esperará a la hora programada para ejecutar el primer backup. 

- **Primer backup:** Se ejecutará automáticamente a la hora especificada en el paso anterior (por defecto: 03:00)
- **Duración:** Depende del tamaño de tu disco. Un equipo típico tarda 30-90 minutos
- **Monitoreo:** Puedes ver el progreso en el Dashboard del NAS bajo **Active Backup** → **Historial**

**Captura conceptual:**
```
┌───────────────────────────────────────────┐
│ Historial de Backups                      │
├───────────────────────────────────────────┤
│ Equipo: PC Oficina                       │
│                                          │
│ Fecha        │ Hora  │ Estado    │ Tiempo │
│ ─────────────┼───────┼────────────┼────── │
│ 2026-02-24   │ 03:00 │ ✓ Éxito   │ 1h12m  │
│ 2026-02-23   │ 03:00 │ ✓ Éxito   │ 1h05m  │
└───────────────────────────────────────────┘
```

## Solución de Problemas

### El servicio no aparece en ejecutándose

**Problema:** El servicio ActiveBackupAgent no está en ejecución
- Abre PowerShell como Administrador
- Ejecuta: `Start-Service -Name ActiveBackupAgent`
- Verifica el estado: `Get-Service -Name ActiveBackupAgent`

### El equipo no aparece en el Dashboard

**Problema:** El PC no aparece en la lista de equipos pendientes
- Verifica que el servicio esté en ejecución (ver arriba)
- Comprueba la conectividad: `ping 192.168.1.100` (IP del NAS)
- Reinicia el servicio:
  ```powershell
  Restart-Service -Name ActiveBackupAgent
  ```
- Espera 30 segundos y recarga el Dashboard

### Error de conectividad de red

**Problema:** El agente no puede comunicarse con el NAS
- Verifica que ambos dispositivos estén en la misma red
- Comprueba el firewall del PC: permite conexión a puerto 873 (rsync)
- En Windows Defender Firewall:
  1. Ve a **Configuración de Seguridad de Windows** → **Firewall y protección de red**
  2. Haz clic en **Permitir una aplicación**
  3. Busca **ActiveBackupAgent** y marca ambas casillas (privada y pública)

### Instalación sin permisos de administrador

**Problema:** Recibiste error "Acceso denegado"
- La instalación requiere permisos administrativos
- Haz clic derecho en `ActiveBackupAgent-Setup.exe` → **Ejecutar como administrador**

## Próximos Pasos

✓ Instalación completada  
✓ Equipo aprobado en el NAS  
→ Configurar calendarios personalizados (opcional)  
→ Leer guía de restauración para estar preparado ante desastres  
→ Verificar primera copia de seguridad en el Historial

## Soporte

Para reportar problemas, contacta al administrador del NAS o consulta la sección **Active Backup** → **Registros** en el Dashboard para ver detalles técnicos.
