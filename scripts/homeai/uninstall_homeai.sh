#!/bin/bash
################################################################################
# uninstall_homeai.sh - Desinstalador de HomeAI para HomePiNAS
#
# Descripción: Script de desinstalación limpia de Ollama + modelos de HomeAI
#              Restaura el sistema a su estado previo a la instalación
#
# Uso: ./uninstall_homeai.sh [NVME_PATH]
#      Ejemplo: ./uninstall_homeai.sh /mnt/nvme0
#
# IMPORTANTE: Este script debe hacerse ejecutable con:
#             chmod +x /dashboard/scripts/homeai/uninstall_homeai.sh
################################################################################

set -euo pipefail

# =============================================================================
# VARIABLES DE ENTORNO
# =============================================================================
NVME_PATH="${1:-/mnt/nvme0}"
OLLAMA_DATA_DIR="$NVME_PATH/homenasos_ai"

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
# DETENER SERVICIO OLLAMA
# =============================================================================
echo "[PROGRESS] 10% - Deteniendo servicio Ollama..."

systemctl stop ollama || true

# =============================================================================
# DESHABILITAR SERVICIO SYSTEMD
# =============================================================================
echo "[PROGRESS] 30% - Deshabilitando servicio systemd..."

systemctl disable ollama || true

# =============================================================================
# ELIMINAR OVERRIDE DE SYSTEMD
# =============================================================================
echo "[PROGRESS] 50% - Eliminando override de systemd..."

rm -rf /etc/systemd/system/ollama.service.d/

# =============================================================================
# ELIMINAR BINARIOS DE OLLAMA
# =============================================================================
echo "[PROGRESS] 65% - Eliminando binarios de Ollama..."

rm -f /usr/local/bin/ollama

# Eliminar usuario de sistema 'ollama' si existe
userdel ollama 2>/dev/null || true

# Eliminar servicio systemd de Ollama si existe
rm -f /etc/systemd/system/ollama.service

# =============================================================================
# ELIMINAR MODELOS DEL NVME (CON PROTECCIÓN CRÍTICA)
# =============================================================================
echo "[PROGRESS] 80% - Eliminando modelos del NVMe..."

# ADVERTENCIA CRÍTICA: Verificar que $OLLAMA_DATA_DIR no es "/" ni está vacío
if [[ -z "$OLLAMA_DATA_DIR" || "$OLLAMA_DATA_DIR" == "/" ]]; then
    echo "[ERROR] Ruta de modelos inválida o peligrosa: $OLLAMA_DATA_DIR. Abortando eliminación para proteger datos."
    exit 1
fi

# Verificar que el directorio existe antes de eliminar
if [[ -d "$OLLAMA_DATA_DIR" ]]; then
    rm -rf "$OLLAMA_DATA_DIR"
    echo "[INFO] Directorio de modelos eliminado: $OLLAMA_DATA_DIR"
fi

# =============================================================================
# RECARGAR CONFIGURACIÓN SYSTEMD
# =============================================================================
echo "[PROGRESS] 95% - Recargando configuración systemd..."

systemctl daemon-reload

# =============================================================================
# FINALIZACIÓN
# =============================================================================
echo "[PROGRESS] 100% - Desinstalación completada"
echo "[DONE] HomeAI desinstalado correctamente"

exit 0
