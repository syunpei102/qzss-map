#!/usr/bin/env bash
set -euo pipefail
role=${1:?server or stream}
[[ "$role" == server || "$role" == stream ]] || exit 2
source_dir=$(cd "$(dirname "$0")" && pwd)
install -d -m 700 /etc/qzss-ops /opt/qzss-ops
install -m 755 "$source_dir/maintenance.py" "$source_dir/upload_backup.py" /opt/qzss-ops/
if [[ "$role" == server ]]; then
  inputs='/etc/qzss-server /var/lib/qzss-server /etc/qzss-ops/ops.env /home/ubuntu/apps/qzss-proxy/Caddyfile /var/lib/qzss-ops/youtube.json /etc/qzss-metrics.env'
else
  inputs='/etc/qzss-stream.env /home/ubuntu/qzss-stream/youtube-oauth.json /home/ubuntu/qzss-stream/live-description-state.json /home/ubuntu/qzss-stream/clip-seen.json /home/ubuntu/qzss-stream/recording-index'
fi
cat > /etc/systemd/system/qzss-private-backup.service <<EOF
[Unit]
Description=Encrypted private QZSS backup
OnFailure=qzss-maintenance-alert.service
After=network-online.target
[Service]
Type=oneshot
EnvironmentFile=/etc/qzss-ops/ops.env
Environment=GOOGLE_APPLICATION_CREDENTIALS=/etc/qzss-ops/uploader.json
ExecStart=/usr/bin/python3 /opt/qzss-ops/maintenance.py backup --cert /etc/qzss-ops/qzss-backup.crt --destination gs://qzss-501907-private-backups/$role $inputs
Nice=19
TimeoutStartSec=360
EOF
cat > /etc/systemd/system/qzss-private-backup.timer <<'EOF'
[Unit]
Description=Daily encrypted QZSS backup
[Timer]
OnCalendar=*-*-* 04:00:00 Asia/Tokyo
Persistent=true
RandomizedDelaySec=600
[Install]
WantedBy=timers.target
EOF
if [[ "$role" == stream ]]; then
cat > /etc/systemd/system/qzss-recording-maintenance.service <<'EOF'
[Unit]
Description=QZSS clip audit thumbnails and retention
OnFailure=qzss-maintenance-alert.service
After=qzss-clips.service
[Service]
Type=oneshot
EnvironmentFile=/etc/qzss-ops/ops.env
ExecStart=/usr/bin/python3 /opt/qzss-ops/maintenance.py clips
Nice=19
TimeoutStartSec=600
EOF
cat > /etc/systemd/system/qzss-recording-maintenance.timer <<'EOF'
[Unit]
Description=QZSS recording maintenance interval
[Timer]
OnBootSec=5min
OnUnitActiveSec=1h
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now qzss-recording-maintenance.timer
fi
cat > /etc/systemd/system/qzss-maintenance-alert.service <<'EOF'
[Unit]
Description=QZSS maintenance failure notification
[Service]
Type=oneshot
EnvironmentFile=/etc/qzss-ops/ops.env
WorkingDirectory=/opt/qzss-ops
ExecStart=/usr/bin/python3 -c "import maintenance; maintenance.alert('QZSSのバックアップまたは検査に失敗しました．VMのサービスログを確認してください．', None)"
EOF
systemctl daemon-reload
systemctl enable --now qzss-private-backup.timer
