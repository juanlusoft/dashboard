#!/bin/bash
# backup-monitor.sh - Monitorización de backups en HomePiNAS

set -euo pipefail

# Configuration
NAS_API="https://192.168.1.100/api"
NAS_USER="juanlu"
NAS_PASS="mimora"
TELEGRAM_GROUP="-1003677994786"
ALERTS_TEMP="/tmp/backup_alerts.jsonl"
CURRENT_TIME=$(date +%s)

# Colors
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Clear previous alerts
> "$ALERTS_TEMP"

# Function to log alert
log_alert() {
    local level=$1
    local device=$2
    local message=$3
    echo "{\"level\":\"$level\",\"device\":\"$device\",\"message\":\"$message\"}" | tee -a "$ALERTS_TEMP"
}

# Function to send to Telegram
send_alert_telegram() {
    local level=$1
    local device=$2
    local message=$3
    
    local emoji="⚠️"
    [ "$level" = "critical" ] && emoji="🚨"
    
    local text="$emoji *Backup Alert* ($level)%0A"
    text="${text}Device: \`$device\`%0A"
    text="${text}Message: $message"
    
    curl -s -X POST "https://api.telegram.org/botXXXBOT_TOKENXX/sendMessage" \
        -d "chat_id=$TELEGRAM_GROUP" \
        -d "text=$text" \
        -d "parse_mode=Markdown" >/dev/null 2>&1 || true
}

# Step 1: Login to NAS
echo "[*] Logging into NAS API..." >&2
SESSION_RESPONSE=$(curl -sk -X POST "$NAS_API/login" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"$NAS_USER\",\"password\":\"$NAS_PASS\"}")

SESSION_ID=$(echo "$SESSION_RESPONSE" | grep -o '"sessionId":"[^"]*' | cut -d'"' -f4)

if [ -z "$SESSION_ID" ]; then
    echo "ERROR: Failed to authenticate with NAS" >&2
    exit 1
fi

echo "[+] Authenticated with sessionId: ${SESSION_ID:0:10}..." >&2

# Step 2: Get device list
echo "[*] Fetching device list..." >&2
DEVICES_RESPONSE=$(curl -sk -X GET "$NAS_API/active-backup/devices" \
    -H "X-Session-Id: $SESSION_ID")

# Check if devices response is valid
if ! echo "$DEVICES_RESPONSE" | grep -q "lastSeen"; then
    echo "ERROR: Invalid devices response" >&2
    echo "Response: $DEVICES_RESPONSE" >&2
    exit 1
fi

echo "[+] Device list retrieved" >&2

# Step 3: Parse devices and check conditions
echo "$DEVICES_RESPONSE" | jq -r '.devices[] | @json' | while read -r device_json; do
    device=$(echo "$device_json" | jq -r '.name // "Unknown"')
    lastSeen=$(echo "$device_json" | jq -r '.lastSeen // 0')
    lastResult=$(echo "$device_json" | jq -r '.lastResult // "unknown"')
    lastBackup=$(echo "$device_json" | jq -r '.lastBackup // 0')
    totalSize=$(echo "$device_json" | jq -r '.totalSize // 0')
    isApproved=$(echo "$device_json" | jq -r '.isApproved // false')
    
    echo "[*] Checking device: $device" >&2
    
    # Calculate time differences in seconds
    lastSeen_diff=$((CURRENT_TIME - lastSeen))
    lastBackup_diff=$((CURRENT_TIME - lastBackup))
    
    # Check 1: Device is offline (>1 hour)
    if [ "$lastSeen_diff" -gt 3600 ]; then
        msg="Device offline for $(($lastSeen_diff / 3600))h (last seen: $(date -d @$lastSeen 2>/dev/null || echo 'unknown'))"
        log_alert "critical" "$device" "$msg"
        send_alert_telegram "critical" "$device" "$msg" &
    fi
    
    # Check 2: Last backup failed
    if [ "$lastResult" != "success" ] && [ "$lastResult" != "unknown" ]; then
        msg="Last backup failed (status: $lastResult at $(date -d @$lastBackup 2>/dev/null || echo 'unknown'))"
        log_alert "critical" "$device" "$msg"
        send_alert_telegram "critical" "$device" "$msg" &
    fi
    
    # Check 3: Approved device hasn't had successful backup in >24h
    if [ "$isApproved" = "true" ] && [ "$lastBackup_diff" -gt 86400 ]; then
        msg="No successful backup in $(($lastBackup_diff / 3600))h (last: $(date -d @$lastBackup 2>/dev/null || echo 'never'))"
        log_alert "warning" "$device" "$msg"
        send_alert_telegram "warning" "$device" "$msg" &
    fi
done

# Step 4: Check NAS disk space
echo "[*] Checking NAS disk space..." >&2
DISK_RESPONSE=$(curl -sk -X GET "$NAS_API/system/storage" \
    -H "X-Session-Id: $SESSION_ID" 2>/dev/null || echo '{}')

DISK_USED=$(echo "$DISK_RESPONSE" | jq -r '.used // 0')
DISK_TOTAL=$(echo "$DISK_RESPONSE" | jq -r '.total // 1')

if [ "$DISK_TOTAL" -gt 0 ]; then
    DISK_PERCENT=$((DISK_USED * 100 / DISK_TOTAL))
    if [ "$DISK_PERCENT" -gt 90 ]; then
        msg="NAS disk space critical: ${DISK_PERCENT}% used"
        log_alert "critical" "NAS-Storage" "$msg"
        send_alert_telegram "critical" "NAS-Storage" "$msg" &
    elif [ "$DISK_PERCENT" -gt 80 ]; then
        msg="NAS disk space warning: ${DISK_PERCENT}% used"
        log_alert "warning" "NAS-Storage" "$msg"
        send_alert_telegram "warning" "NAS-Storage" "$msg" &
    fi
fi

# Wait for background telegram jobs
wait

# Step 5: Output alerts
if [ -s "$ALERTS_TEMP" ]; then
    echo "[!] ALERTS GENERATED:" >&2
    cat "$ALERTS_TEMP"
    exit 0
else
    echo "[+] All systems OK" >&2
    exit 0
fi
