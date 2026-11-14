#!/usr/bin/env bash
set -euo pipefail
role=${1:?server stream or pi}
[[ "$role" == server || "$role" == stream || "$role" == pi ]] || exit 2
# Prepare /etc/qzss-metrics.env privately before enabling．Contains role URL and scoped token．
test -f /etc/qzss-metrics.env
install -d -m 755 /opt/qzss-metrics
install -m 755 "$(dirname "$0")/metrics-agent.py" /opt/qzss-metrics/metrics-agent.py
user=ubuntu
[[ "$role" == pi ]] && user=qzss01
cat > /etc/systemd/system/qzss-metrics.service <<UNIT
[Unit]
Description=Read-only QZSS host metrics
After=network-online.target
Wants=network-online.target
[Service]
User=$user
EnvironmentFile=/etc/qzss-metrics.env
ExecStart=/usr/bin/python3 /opt/qzss-metrics/metrics-agent.py
Restart=always
RestartSec=15
Nice=15
MemoryMax=64M
CPUQuota=5%
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now qzss-metrics.service
