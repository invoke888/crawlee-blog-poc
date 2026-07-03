#!/bin/bash
# P2#6 存储巡检(服务器跑)· 用法: bash scripts/storage-report.sh
# 阈值告警:raw-html >2GB · seen-store >5MB · dataset 文件数 >20000
cd "$(dirname "$0")/.."
echo "=== 存储巡检 $(date '+%F %T') ==="
du -sh storage/key_value_stores/raw-html 2>/dev/null || echo "raw-html: 无"
du -sh storage/datasets/default 2>/dev/null || echo "dataset: 无"
ls storage/datasets/default 2>/dev/null | wc -l | xargs echo "dataset 文件数:"
du -sh storage/key_value_stores/seen-articles 2>/dev/null || echo "seen: 无"
du -sh storage/request_queues 2>/dev/null || echo "queues: 无"
df -h / | tail -1 | awk '{print "磁盘: 用 "$3" / 总 "$2" ("$5")"}'

RAW_KB=$(du -sk storage/key_value_stores/raw-html 2>/dev/null | cut -f1 || echo 0)
SEEN_KB=$(du -sk storage/key_value_stores/seen-articles 2>/dev/null | cut -f1 || echo 0)
DS_N=$(ls storage/datasets/default 2>/dev/null | wc -l || echo 0)
[ "${RAW_KB:-0}" -gt 2097152 ] && echo "🔴 raw-html 超 2GB · 建议清最老 token 的备份"
[ "${SEEN_KB:-0}" -gt 5120 ] && echo "🔴 seen-store 超 5MB · 建议按 crawledAt 裁剪"
[ "${DS_N:-0}" -gt 20000 ] && echo "🔴 dataset 文件数超 2 万 · 确认 push 后归档"
echo "=== 巡检完 ==="
