# Backup Monitor Cron Configuration

## Setup Instructions

This script monitors HomePiNAS Active Backup status and alerts if issues are detected.

### 1. Make scripts executable

```bash
chmod +x /path/to/scripts/backup-monitor.sh
chmod +x /path/to/scripts/backup-monitor-cron.sh
```

### 2. Create log directory

```bash
mkdir -p /var/log/backup-monitor
chmod 755 /var/log/backup-monitor
```

### 3. Add to Heimdall crontab

Add this line to Heimdall's crontab (`crontab -e`):

```cron
# Backup Monitor - Every 6 hours
0 */6 * * * /opt/dashboard/scripts/backup-monitor-cron.sh >> /var/log/backup-monitor/cron.log 2>&1
```

Or with specific times (02:00, 08:00, 14:00, 20:00):

```cron
0 2,8,14,20 * * * /opt/dashboard/scripts/backup-monitor-cron.sh >> /var/log/backup-monitor/cron.log 2>&1
```

### 4. Verify setup

```bash
# Test the script manually
/opt/dashboard/scripts/backup-monitor.sh

# Check logs
tail -f /var/log/backup-monitor/alerts.log
```

## Alert Levels

- **critical**: Device offline >1h, backup failed, or disk space >90%
- **warning**: No backup for approved device >24h, disk space >80%

## API Requirements

- NAS must be accessible at `https://192.168.1.100`
- API user: `juanlu` with password set in script
- Telegram bot token must be configured in the script

## Notes

- Script uses `jq` for JSON parsing (requires installation)
- Requires `curl` and `bash`
- Self-signed certificates are accepted (`curl -sk`)
