#!/usr/bin/env bash
set -euo pipefail
source_dir=$(cd "$(dirname "$0")" && pwd)
if [[ ! -f /opt/qzss-stream/event_clips.py.before-youtube-manager ]]; then cp -p /opt/qzss-stream/event_clips.py /opt/qzss-stream/event_clips.py.before-youtube-manager; fi
install -m 755 "$source_dir/youtube_manager.py" "$source_dir/event_clips.py" /opt/qzss-stream/
cat > /etc/systemd/system/qzss-youtube-manager.service <<'UNIT'
[Unit]
Description=YouTube live metadata and explicitly requested description edits
After=network-online.target
Wants=network-online.target
[Service]
User=ubuntu
EnvironmentFile=/etc/qzss-metrics.env
ExecStart=/usr/bin/python3 /opt/qzss-stream/youtube_manager.py
Restart=always
RestartSec=30
Nice=15
CPUQuota=5%
MemoryMax=96M
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/home/ubuntu/qzss-stream
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now qzss-youtube-manager.service
