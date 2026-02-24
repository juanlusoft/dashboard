# Guía de Restauración Windows desde Backup Active Backup HomePiNAS

## Introducción

Esta guía te ayudará a restaurar tu sistema Windows desde una imagen de backup creada por Active Backup. Úsala cuando necesites:

- Recuperarte de un fallo de disco
- Restaurar en un PC nuevo
- Cambiar a un disco SSD o HDD de mayor capacidad
- Recuperarte de un desastre o infección

## Cuándo Usar Esta Guía

**Restauración completa desde booteo:**
- Tu disco actual está dañado o no arranca
- Instalas un disco nuevo
- Necesitas recuperar tu sistema completo desde una fecha específica

**Alternativa: Restauración parcial**
- Si tu sistema aún arranca, puedes restaurar directorios individuales desde el Dashboard (no requiere esta guía)

## Requisitos

- **USB bootable con Windows 11** (8 GB mínimo)
  - Puedes crear uno en otra máquina Windows usando Windows Media Creation Tool
- **Acceso a Red:** Conexión Ethernet al NAS (recomendado) o WiFi
- **IP del NAS y Credenciales:** Usuario y contraseña del acceso a backups
- **Tamaño de Disco:** El disco destino debe tener al menos el mismo tamaño que el original
- **BIOS/UEFI Accesible:** Capacidad de bootear desde USB

## Preparación

### 1. Obtener la URL de la Imagen de Backup

1. En el **Dashboard del NAS**, ve a **Active Backup** → **Historial**
2. Selecciona tu equipo y elige la copia a restaurar (por defecto, la más reciente)
3. Busca la ruta de la imagen. Ejemplo:
   ```
   \\192.168.1.100\backup-share\ImageBackup\PC-JUAN-W11\2026-02-24_030000\disk.wim
   ```
4. Anota esta ruta (necesitarás el nombre de equipo, fecha y ruta de compartición)

### 2. Crear USB Bootable (si no la tienes)

En una máquina Windows funcional:
1. Descarga **Windows 11 Media Creation Tool** de microsoft.com
2. Conecta un USB (8 GB+)
3. En Media Creation Tool: selecciona "Crear medio de instalación"
4. Elige USB y espera a que se complete

## Proceso de Restauración

### Paso 1: Boot desde USB

1. Apaga el equipo completamente
2. Instala el nuevo disco (si es necesario)
3. Conecta el USB bootable
4. Enciende el equipo
5. Entra en BIOS/UEFI presionando (generalmente):
   - **F2**, **F10**, **Del**, **Esc** durante el arranque (depende del fabricante)
6. En BIOS, busca **Boot Order** o **Dispositivo de Arranque**
7. Selecciona el USB como primera opción
8. Guarda y sal (generalmente **F10**)

El equipo debería bootear desde el USB.

**Captura conceptual:**
```
┌────────────────────────────────────┐
│ BIOS Setup - Boot Order             │
├────────────────────────────────────┤
│                                    │
│ 1. USB: SanDisk Extreme (ACTIVE)   │
│ 2. SATA: Samsung SSD 980           │
│ 3. UEFI: Network                   │
│                                    │
│ [Save and Exit]                    │
└────────────────────────────────────┘
```

### Paso 2: Iniciar Windows Setup

1. Espera a que cargue el instalador de Windows
2. Selecciona idioma, zona horaria, formato de teclado
3. Haz clic en **Siguiente**

**Captura conceptual:**
```
┌────────────────────────────────────┐
│ Configuración de Windows            │
├────────────────────────────────────┤
│                                    │
│ Idioma: Español ▼                  │
│ Zona horaria: Madrid ▼              │
│ Formato teclado: Español ▼          │
│                                    │
│                       [Siguiente]  │
└────────────────────────────────────┘
```

### Paso 3: Acceder al Símbolo del Sistema de Recuperación

1. En la pantalla "¿Deseas instalar Windows?", haz clic en **Reparar equipo** (abajo a la izquierda)
2. Selecciona **Solucionar problemas**
3. Selecciona **Opciones avanzadas**
4. Selecciona **Símbolo del sistema**

Espera a que se inicie una ventana de PowerShell/CMD.

**Captura conceptual:**
```
┌────────────────────────────────────┐
│ Opciones de Recuperación             │
├────────────────────────────────────┤
│                                    │
│ > Restablecer este equipo          │
│ > Ver opciones avanzadas           │
│ > Restaurar del apagón accidental  │
│                                    │
└────────────────────────────────────┘

        ↓ (después de varias pantallas)

┌────────────────────────────────────┐
│ Símbolo del sistema                │
│ C:\>_                              │
└────────────────────────────────────┘
```

### Paso 4: Configurar Red (si es necesario)

Si tu red NO usa DHCP, o no se configura automáticamente:

```cmd
netsh interface ip show config
```

Si no hay IP asignada, configura manualmente:

```cmd
netsh interface ip set address "Ethernet" static 192.168.1.50 255.255.255.0 192.168.1.1
netsh interface ip set dnsservers "Ethernet" static 192.168.1.1
```

**Reemplaza:**
- `192.168.1.50`: Una IP libre en tu red local
- `255.255.255.0`: Tu máscara de subred
- `192.168.1.1`: Tu puerta de enlace/router

Verifica conectividad:
```cmd
ping 192.168.1.100
```

Deberías recibir respuestas del NAS.

### Paso 5: Particionar el Disco Destino

Usa `diskpart` para preparar el disco. Este es un paso crítico.

```cmd
diskpart
```

Dentro de diskpart:

```cmd
list disk
```

Identifica tu disco destino. Ejemplo: si ves "Disk 0" con 500 GB, es probable que sea el tuyo.

**Importante:** Asegúrate de seleccionar el disco correcto, ya que el siguiente paso lo borrará.

```cmd
select disk 0
```

Limpia el disco:
```cmd
clean
convert gpt
```

Crea las particiones requeridas para UEFI:

```cmd
create partition efi size=100
format quick fs=fat32 label="System"
assign letter=S

create partition msr size=16

create partition primary
format quick fs=ntfs label="Windows"
assign letter=W

exit
```

**Captura conceptual:**
```
Disco después de particionar (UEFI):
┌─────────────────────────────────────┐
│ Partición EFI    │ 100 MB (FAT32)   │ S:
├─────────────────────────────────────┤
│ Partición MSR    │ 16 MB            │
├─────────────────────────────────────┤
│ Partición Windows │ ~465 GB (NTFS)  │ W:
└─────────────────────────────────────┘
```

### Paso 6: Montar la Compartición de Backups del NAS

```cmd
net use Z: \\192.168.1.100\backup-share /user:admin contraseña
```

**Reemplaza:**
- `192.168.1.100`: IP de tu NAS
- `admin`: Usuario de acceso
- `contraseña`: Tu contraseña

Si la conexión es exitosa, verás:
```
El comando se completó correctamente.
```

Verifica que puedas ver los backups:
```cmd
dir Z:\ImageBackup\
```

Deberías ver directorios con nombres de máquinas.

### Paso 7: Aplicar la Imagen de Backup

Ahora aplicamos la imagen WIM al disco particionado.

```cmd
wimapply Z:\ImageBackup\PC-JUAN-W11\2026-02-24_030000\disk.wim 1 W:
```

**Reemplaza:**
- `PC-JUAN-W11`: Nombre de tu equipo
- `2026-02-24_030000`: Fecha y hora del backup que deseas restaurar
- `1`: Índice de la imagen (casi siempre 1)
- `W:`: Letra de unidad de la partición Windows (que creaste en Paso 5)

La aplicación de la imagen puede tomar **30-120 minutos** dependiendo del tamaño.

**Salida esperada al inicio:**
```
Creando proceso: wimapply.exe Z:\ImageBackup\PC-JUAN-W11\2026-02-24_030000\disk.wim 1 W:
Procesando 0%...
Procesando 10%...
Procesando 25%...
...
Operación completada correctamente.
```

### Paso 8: Reparar el Bootloader UEFI

Una vez aplicada la imagen, debes reparar el bootloader:

```cmd
bcdboot W:\Windows /s S: /f UEFI
```

**Explicación:**
- `W:\Windows`: Ubicación del sistema Windows restaurado
- `S:`: Partición EFI (que creaste en Paso 5)
- `UEFI`: Formato de bootloader

Salida esperada:
```
Administrador de arranque actualizado correctamente.
Entrada de arranque de Windows agregada correctamente.
```

### Paso 9: Desmontar y Verificar

Desmonta la compartición del NAS:
```cmd
net use Z: /delete
```

Verifica que las letras de unidad estén correctas:
```cmd
diskpart
list volume
exit
```

Deberías ver:
- Una partición EFI (S:) de ~100 MB
- Una partición Windows (W:) con el resto del espacio

### Paso 10: Reiniciar el Sistema

```cmd
exit
```

Saca el USB bootable y reinicia:
```cmd
shutdown /r /t 0
```

O simplemente escribe `exit` y reinicia manualmente.

**Captura conceptual:**
```
┌────────────────────────────────────┐
│ Bootloader reparado ✓              │
│ Imagen restaurada ✓                 │
│                                    │
│ Reiniciando...                      │
└────────────────────────────────────┘

        ↓ (después de reiniciar)

┌────────────────────────────────────┐
│ Windows 11 Pro                      │
│ Iniciando Windows...                │
│ ███████░░░░░░░░░░░░░░ 35%          │
└────────────────────────────────────┘
```

## Después de la Restauración

1. **Primer Arranque:** Windows ejecutará actualizaciones y reconocerá nuevo hardware (puede tomar 5-15 minutos)
2. **Drivers:** Algunos drivers pueden necesitar actualizarse (p. ej., chipset, GPU)
3. **Activación de Windows:** Si cambiaste hardware, es posible que requiera reactivación
4. **Backups Futuros:** El equipo restaurado continuará haciendo backups automáticos con el agente

## Troubleshooting

### Error: "No se puede montar la compartición del NAS"

**Problema:** `net use` retorna "Acceso denegado"
- Verifica que la IP del NAS es correcta: `ping 192.168.1.100`
- Verifica credenciales (usuario/contraseña)
- Asegúrate de que el servicio de compartición está activo en el NAS
- Intenta con ruta UNC: `\\192.168.1.100\backup-share`

### Error: "wimapply: error al aplicar la imagen"

**Problema:** La imagen .wim no se aplica correctamente
- Verifica que la ruta es correcta: `dir Z:\ImageBackup\...`
- Asegúrate de que tienes permisos de lectura en el NAS
- Verifica que la partición destino (W:) existe y está formateada
- Intenta desconectar el USB por si hay conflictos

### El disco no bootea después de restauración

**Problema:** El bootloader UEFI no se reparó correctamente
- Vuelve al Símbolo del sistema de recuperación (Paso 3)
- Ejecuta `bcdboot` nuevamente (Paso 8)
- Verifica que S: es la partición EFI: `diskpart` → `list partition`

### Windows no reconoce el nuevo hardware

**Problema:** Pantalla azul o dispositivos desconocidos después de arrancar
- Este comportamiento es normal después de restaurar en hardware diferente
- Permite que Windows descargue drivers automáticamente (puede tomar 10-30 minutos)
- Entra en **Administrador de dispositivos** y busca "Dispositivos desconocidos"
- Instala drivers manualmente si es necesario (chipset, RAID, GPU)

### Error de verificación de licencia de Windows

**Problema:** "Windows no está activado correctamente"
- Si restauraste en diferente hardware, es posible que necesites reactivación
- Abre **Configuración** → **Sistema** → **Información**
- Busca **Activación de Windows**
- Si hay problema, intenta activar por teléfono o con una clave de licencia válida

## Validación Post-Restauración

Una vez que Windows arranque correctamente:

1. **Verifica datos:**
   - Abre el Explorador de archivos
   - Verifica que tus archivos estén presentes en las carpetas esperadas
   - Comprueba carpetas críticas (/Users, /Program Files, etc.)

2. **Prueba aplicaciones:**
   - Abre aplicaciones importantes (navegador, office, etc.)
   - Verifica que funcionan correctamente

3. **Comprueba conectividad:**
   - Conéctate a internet
   - Prueba acceso a recursos de red

4. **Registra el éxito:**
   - En el Dashboard del NAS, bajo **Active Backup** → **Historial**, anota que la restauración fue exitosa
   - Opcionalmente, comenta detalles para futura referencia

## Próximos Pasos

✓ Restauración completada  
→ Reconfigura credenciales si es necesario  
→ Reactiva Windows si fue necesario  
→ Verifica que el agente de backup aún está activo  
→ Configura nuevamente aplicaciones personalizadas si las hay  

## Soporte de Emergencia

Si experimentas problemas durante la restauración:
- Mantén el símbolo del sistema abierto
- Captura los mensajes de error (screenshot con teléfono si es necesario)
- Contacta al administrador del NAS con:
  - IP del NAS
  - Nombre del equipo a restaurar
  - Fecha del backup
  - Mensaje de error exacto
