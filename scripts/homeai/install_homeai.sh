#!/bin/bash
################################################################################
# install_homeai.sh - Instalador de HomeAI para HomePiNAS
#
# Descripción: Script de instalación de Ollama + modelo qwen2.5-coder:3b
#              con configuración optimizada para Raspberry Pi CM5 (ARM64/aarch64)
#
# Uso: ./install_homeai.sh [NVME_PATH]
#      Ejemplo: ./install_homeai.sh /mnt/nvme0
#
# IMPORTANTE: Este script debe hacerse ejecutable con:
#             chmod +x /dashboard/scripts/homeai/install_homeai.sh
################################################################################

set -euo pipefail

# =============================================================================
# VARIABLES DE ENTORNO
# =============================================================================
NVME_PATH="${1:-/mnt/nvme0}"
OLLAMA_DATA_DIR="$NVME_PATH/homenasos_ai"
OLLAMA_MODEL="qwen2.5-coder:3b"
HOMEAI_NAME="HomeAI"
MODELFILE_TMP="/tmp/HomeAI_Modelfile"

# =============================================================================
# MANEJO DE ERRORES
# =============================================================================
trap 'on_error $? $LINENO' ERR
on_error() {
    local exit_code=$1
    local line_number=$2
    echo "[ERROR] Error en línea $line_number (código: $exit_code)"
    exit 1
}

# =============================================================================
# VERIFICACIONES PREVIAS (PRE-CHECKS)
# =============================================================================
echo "[PROGRESS] 5% - Verificando prerrequisitos del sistema..."

# Verificar que $NVME_PATH existe como directorio
if [[ ! -d "$NVME_PATH" ]]; then
    echo "[ERROR] No se encontró directorio NVMe en $NVME_PATH. Abortando para proteger la eMMC."
    exit 1
fi

# Verificar que hay al menos 8GB libres en $NVME_PATH
AVAILABLE_SPACE=$(df -BG "$NVME_PATH" | tail -1 | awk '{print $4}' | sed 's/G//')
if (( AVAILABLE_SPACE < 8 )); then
    echo "[ERROR] Espacio insuficiente en $NVME_PATH. Se requieren al menos 8GB, disponibles: ${AVAILABLE_SPACE}GB"
    exit 1
fi

# Verificar conexión a internet
if ! curl -s --max-time 5 https://ollama.com > /dev/null 2>&1; then
    echo "[ERROR] Sin conexión a internet o servidor ollama.com no accesible"
    exit 1
fi

# =============================================================================
# INSTALACIÓN DE OLLAMA NATIVA (ARM64)
# =============================================================================
echo "[PROGRESS] 15% - Instalando Ollama para ARM64..."
if command -v ollama &> /dev/null; then
    echo "[INFO] Ollama ya está instalado, saltando instalación"
else
    curl -fsSL https://ollama.com/install.sh | sh
fi

# =============================================================================
# CREAR DIRECTORIO DE MODELOS Y ASIGNAR PERMISOS
# =============================================================================
echo "[PROGRESS] 25% - Creando directorio de modelos en $OLLAMA_DATA_DIR..."

mkdir -p "$OLLAMA_DATA_DIR"
chown ollama:ollama "$OLLAMA_DATA_DIR"
chmod 755 "$OLLAMA_DATA_DIR"

# =============================================================================
# CONFIGURAR SYSTEMD OVERRIDE PARA OLLAMA
# =============================================================================
echo "[PROGRESS] 30% - Configurando servicio systemd..."

mkdir -p /etc/systemd/system/ollama.service.d/

# Crear archivo override.conf con las variables de entorno
cat > /etc/systemd/system/ollama.service.d/override.conf << EOF
[Service]
Environment="OLLAMA_HOST=127.0.0.1:11434"
Environment="OLLAMA_MODELS=$OLLAMA_DATA_DIR"
EOF

# =============================================================================
# REINICIAR SYSTEMD Y LEVANTAR OLLAMA
# =============================================================================
echo "[PROGRESS] 40% - Reiniciando servicios..."

systemctl daemon-reload
systemctl enable ollama
systemctl restart ollama
sleep 5

# =============================================================================
# VERIFICAR QUE OLLAMA RESPONDE
# =============================================================================
echo "[INFO] Verificando que Ollama está listo..."
RETRY_COUNT=0
MAX_RETRIES=6
RETRY_DELAY=5

while (( RETRY_COUNT < MAX_RETRIES )); do
    if curl -s --max-time 30 http://127.0.0.1:11434 > /dev/null 2>&1; then
        echo "[INFO] Ollama respondiendo correctamente"
        break
    fi
    RETRY_COUNT=$((RETRY_COUNT + 1))
    if (( RETRY_COUNT < MAX_RETRIES )); then
        echo "[INFO] Reintentando... ($RETRY_COUNT/$MAX_RETRIES)"
        sleep $RETRY_DELAY
    fi
done

if (( RETRY_COUNT >= MAX_RETRIES )); then
    echo "[ERROR] Ollama no responde después de $MAX_RETRIES intentos"
    exit 1
fi

# =============================================================================
# DESCARGAR EL MODELO
# =============================================================================
echo "[PROGRESS] 50% - Iniciando descarga del modelo qwen2.5-coder:3b (puede tardar varios minutos)..."

ollama pull "$OLLAMA_MODEL"

# =============================================================================
# CREAR MODELFILE CON SYSTEM PROMPT DE HOMEAI
# =============================================================================
echo "[PROGRESS] 85% - Compilando agente HomeAI..."

cat > "$MODELFILE_TMP" << 'MODELFILE_EOF'
# Modelo base (ligero y rápido, ideal para ARM64)
FROM qwen2.5-coder:3b
# Temperatura muy baja para respuestas técnicas
PARAMETER temperature 0.1
SYSTEM """
Eres "HomeAI", el asistente de Inteligencia Artificial local y SysAdmin avanzado, integrado de forma nativa en "HomeNasOS" (v2.13+), el sistema operativo exclusivo de la placa "HomePiNAS".
### CONTEXTO DEL HARDWARE (CRÍTICO):
- CPU/Placa: Raspberry Pi Compute Module 5 (CM5). Arquitectura ARM64 / aarch64.
- Almacenamiento: Switch PCIe Gen3 x1 con 6 puertos SATA III y 2 ranuras M.2 NVMe.
- Sensores y control: Sensor de consumo INA238 (vatios/voltios/amperios) y controlador de ventiladores EMC2305 (I2C/PWM dinámico).
### REGLA DE ORO INQUEBRANTABLE: "GUI FIRST" (EL DASHBOARD MANDA)
El usuario interactúa con HomeNasOS a través de un Dashboard web avanzado (PWA). NUNCA proporciones comandos de terminal (Bash) ni tutoriales manuales para las tareas que el Dashboard ya soporta nativamente. Si el usuario te pide ayuda sobre algo de la siguiente lista, TU ÚNICA RESPUESTA debe ser indicarle amablemente la sección correspondiente del Dashboard:
--- CAPACIDADES DEL DASHBOARD (REDIRECCIONAR SIEMPRE A LA UI): ---
1. Monitor del Sistema: Ver uso de CPU, RAM, Swap, red en vivo, uptime, y consumo eléctrico/temperatura vía INA238.
2. Almacenamiento: Gestión del pool de MergerFS, tareas de SnapRAID (sync/scrub/historial), tests de Badblocks en vivo, y montaje de discos independientes.
3. Ventiladores (EMC2305): Lectura de RPM y cambio de modos PWM (Silencioso, Equilibrado, Rendimiento, Manual).
4. Docker: Gestión de contenedores (start/stop/logs) y despliegue/parada de stacks completos con Docker Compose.
5. Red y VPN: Monitor de red, DDNS, DHCP, e instalación/gestión de clientes WireGuard (con generación de QR y estado de peers en tiempo real).
6. Sincronización y Backups: Syncthing para sync P2P, y la potente suite "Active Backup".
7. Usuarios y Seguridad: Roles RBAC, 2FA TOTP, creación automática de usuarios Samba vinculados a la cuenta web, y logs de seguridad.
8. Automatización y Sistema: Tareas cron (Scheduler), backups tar, notificaciones, monitor de UPS APC, actualizaciones OTA, y uso de la Terminal Web.
### TU ROL EXCLUSIVO (Soporte Nivel 3 y Arquitecto Docker):
Tu trabajo empieza EXCLUSIVAMENTE cuando el usuario quiere hacer algo personalizado que sobrepasa el Dashboard o cuando hay que depurar errores técnicos. Eres el experto para:
1. Diseñador Docker Compose: Si el usuario quiere instalar un servicio nuevo, genérale el archivo docker-compose.yml a medida. REGLA: Asegúrate SIEMPRE de que las imágenes sugeridas soporten arquitectura arm64.
2. Depuración Profunda (Troubleshooting): Proporciona comandos de diagnóstico precisos (journalctl, dmesg, smartctl, i2cdetect -y 1). Indícale al usuario que puede ejecutarlos desde la "Terminal Web" del Dashboard.
3. I/O Inteligente (Hardware-Aware): Los volúmenes pesados de Docker, bases de datos y modelos de IA deben guardarse en los discos M.2 NVMe. Los 6 puertos SATA son exclusivamente para el pool masivo de MergerFS.
4. Scripts Personalizados: Crea scripts complejos en Bash/Python para automatizar vía el módulo "Scheduler" del Dashboard.
### REGLAS DE SEGURIDAD (ZERO DATA LOSS):
- Si debes sugerir un comando destructivo (mkfs, fdisk, rm -rf), incluye SIEMPRE una advertencia crítica instando al usuario a verificar las rutas con lsblk.
- Tono: Sé conciso, técnico y directo. Evita saludos redundantes.
"""
MODELFILE_EOF

# Compilar el agente HomeAI
ollama create "$HOMEAI_NAME" -f "$MODELFILE_TMP"

# =============================================================================
# LIMPIAR ARCHIVOS TEMPORALES
# =============================================================================
echo "[PROGRESS] 95% - Limpiando archivos temporales..."

rm -f "$MODELFILE_TMP"

# =============================================================================
# FINALIZACIÓN
# =============================================================================
echo "[PROGRESS] 100% - Instalación completada"
echo "[DONE] HomeAI instalado y activo"

exit 0
