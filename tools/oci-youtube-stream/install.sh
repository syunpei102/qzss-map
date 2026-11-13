#!/usr/bin/env bash
set -Eeuo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run with sudo bash install.sh'; exit 1; }
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
id ubuntu >/dev/null
for program in Xvfb xdotool google-chrome ffmpeg; do
  command -v "$program" >/dev/null || { echo "Missing: $program"; exit 1; }
done
install -d -m 755 /opt/qzss-stream
install -m 755 "$source_dir/run.sh" /opt/qzss-stream/run.sh
install -m 755 "$source_dir/event_clips.py" /opt/qzss-stream/event_clips.py
install -m 755 "$source_dir/browser_guard.py" /opt/qzss-stream/browser_guard.py
install -m 755 "$source_dir/version_watch.py" /opt/qzss-stream/version_watch.py
install -m 644 "$source_dir/qzss-version-watch.service" /etc/systemd/system/qzss-version-watch.service
python3 - <<'PY'
import json,pathlib
path=pathlib.Path('/etc/opt/chrome/policies/managed/qzss-stream.json')
path.parent.mkdir(parents=True,exist_ok=True)
data=json.loads(path.read_text()) if path.exists() else {}
data['TranslateEnabled']=False
path.write_text(json.dumps(data)+'\n')
path.chmod(0o644)
PY
if [[ ! -e /etc/qzss-stream.env ]]; then
  install -m 600 /dev/null /etc/qzss-stream.env
fi
cat > /etc/systemd/system/qzss-stream.service <<'UNIT'
[Unit]
Description=QZSS browser and optional YouTube stream
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=ubuntu
Environment=HOME=/home/ubuntu
EnvironmentFile=/etc/qzss-stream.env
ExecStart=/opt/qzss-stream/run.sh
Restart=always
RestartSec=20
KillMode=control-group
OOMPolicy=stop
TimeoutStopSec=15
UMask=0077
StandardOutput=journal
StandardError=null

[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/qzss-clips.service <<'UNIT'
[Unit]
Description=QZSS event recording and YouTube upload queue
Wants=network-online.target qzss-stream.service
After=network-online.target qzss-stream.service
StartLimitIntervalSec=0

[Service]
Type=simple
User=ubuntu
Environment=HOME=/home/ubuntu
Environment=TZ=Asia/Tokyo
ExecStart=/usr/bin/python3 /opt/qzss-stream/event_clips.py daemon
Restart=always
RestartSec=20
Nice=10
UMask=0077
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
UNIT
timedatectl set-timezone Asia/Tokyo
timedatectl set-ntp true
install -d -m 755 /etc/systemd/timesyncd.conf.d
cat > /etc/systemd/timesyncd.conf.d/qzss.conf <<'NTP'
[Time]
NTP=169.254.169.254
PollIntervalMinSec=32
PollIntervalMaxSec=300
NTP
systemctl daemon-reload
systemctl restart systemd-timesyncd
echo 'Installed．After stopping the previous manual Chrome/Xvfb, run:'
echo 'sudo systemctl enable --now qzss-stream'
echo 'sudo systemctl enable --now qzss-clips'

echo 'sudo systemctl enable --now qzss-version-watch'
