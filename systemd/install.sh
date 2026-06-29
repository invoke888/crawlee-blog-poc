#!/usr/bin/env bash
# 在服务器 hk-prod 跑这个脚本装 systemd unit
# 不动 blogpicker
set -euo pipefail

cd "$(dirname "$0")"
sudo cp crawlee-blog-poc.service /etc/systemd/system/crawlee-blog-poc.service
sudo cp crawlee-blog-poc.timer   /etc/systemd/system/crawlee-blog-poc.timer
sudo systemctl daemon-reload
sudo systemctl enable --now crawlee-blog-poc.timer
echo "=== timer status ==="
sudo systemctl status crawlee-blog-poc.timer --no-pager | head -10
echo "=== timer list ==="
sudo systemctl list-timers crawlee-blog-poc.timer --no-pager
