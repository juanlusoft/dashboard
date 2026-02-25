#!/bin/bash
# Install HomePiNAS as a systemd service
set -e

INSTALL_DIR="${1:-/opt/homepinas}"
SERVICE_FILE="$(dirname "$0")/homepinas.service"

if [ ! -f "$SERVICE_FILE" ]; then
  echo "❌ homepinas.service not found"
  exit 1
fi

# Update WorkingDirectory to match install path
sed "s|WorkingDirectory=.*|WorkingDirectory=$INSTALL_DIR|" "$SERVICE_FILE" > /etc/systemd/system/homepinas.service

systemctl daemon-reload
systemctl enable homepinas
systemctl restart homepinas

echo "✅ HomePiNAS service installed and running"
systemctl status homepinas --no-pager
