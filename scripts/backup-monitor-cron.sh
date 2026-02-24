#!/bin/bash
# Cron job wrapper for backup-monitor.sh
# This script runs the backup monitor and handles alerts

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_MONITOR="$SCRIPT_DIR/backup-monitor.sh"
LOG_DIR="/var/log/backup-monitor"
LOG_FILE="$LOG_DIR/backup-monitor.log"
ALERT_LOG="$LOG_DIR/alerts.log"

# Create log directory if it doesn't exist
mkdir -p "$LOG_DIR"

# Run the backup monitor
OUTPUT=$("$BACKUP_MONITOR" 2>&1)
EXIT_CODE=$?

# Log execution
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Backup monitor executed (exit code: $EXIT_CODE)" >> "$LOG_FILE"

# If there are alerts, log them
if [ -n "$OUTPUT" ] && echo "$OUTPUT" | grep -q "level"; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ALERTS DETECTED:" >> "$ALERT_LOG"
    echo "$OUTPUT" | sed 's/^/  /' >> "$ALERT_LOG"
fi

exit $EXIT_CODE
