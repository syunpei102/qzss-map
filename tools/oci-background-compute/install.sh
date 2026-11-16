#!/usr/bin/env bash
set -euo pipefail
source_dir=$(cd "$(dirname "$0")" && pwd)
install -d -m 755 /opt/qzss-background-compute
install -m 755 "$source_dir/worker.py" /opt/qzss-background-compute/worker.py
install -m 644 "$source_dir/qzss-background-compute.service" /etc/systemd/system/qzss-background-compute.service
systemctl daemon-reload
systemctl enable --now qzss-background-compute.service
