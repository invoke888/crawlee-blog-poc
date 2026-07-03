#!/usr/bin/env python3
# 🆕 2026-07-03 自测审计 · 本地合并切片:采集条目 + probe 独立视角 → N 片给 agent 审查
# 用法(本地): python3 scripts/audit-slice.py <audit-items.json> <audit-probe.jsonl> <输出目录> [片数=10]
import json
import sys
import os

items_fp, probe_fp, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]
n_slices = int(sys.argv[4]) if len(sys.argv) > 4 else 10

with open(items_fp) as f:
    items = json.load(f)
probe_by_url = {}
with open(probe_fp) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        p = json.loads(line)
        probe_by_url[p["url"]] = p

merged = []
for it in items:
    p = probe_by_url.get(it["url"], {})
    p = {k: v for k, v in p.items() if k not in ("id", "url", "fetch_mode")}
    merged.append({**it, "probe": p})

# 按 symbol 排序 · 同源相邻(1-to-N 同 URL 进同片 · agent 看得到关联)
merged.sort(key=lambda x: (x.get("base_symbol") or "", x.get("token_id") or 0))

os.makedirs(out_dir, exist_ok=True)
per = (len(merged) + n_slices - 1) // n_slices
for i in range(n_slices):
    chunk = merged[i * per:(i + 1) * per]
    with open(os.path.join(out_dir, f"slice-{i + 1:02d}.json"), "w") as f:
        json.dump(chunk, f, ensure_ascii=False, indent=1)
    print(f"slice-{i + 1:02d}.json · {len(chunk)} 条")
no_probe = sum(1 for m in merged if not m["probe"])
print(f"合计 {len(merged)} 条 · probe 缺失 {no_probe}")
