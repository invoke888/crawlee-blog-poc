#!/usr/bin/env python3
# 🆕 2026-07-03 自测审计 · 服务器聚合:dataset → 审查条目(token 级)+ audit-probe 输入(unique URL 级)
# 用法(服务器): python3 scripts/audit-collect.py
# 输出: /tmp/audit-items.json(全部条目 · 含采集字段)+ /tmp/audit-probe-input.json(unique URL + fetch_mode)
import json
import glob
from urllib.parse import urlparse

FILTER_CONFIG = "src/utils/filter-config.json"
with open(FILTER_CONFIG) as f:
    fc = json.load(f)
MEDIUM_DOMAINS = fc.get("throttled_domains", {}).get("medium", [])
DIRECT_HOSTS = fc.get("direct_hosts", [])


def host_of(url: str) -> str:
    try:
        return (urlparse(url).hostname or "").lower().removeprefix("www.")
    except Exception:
        return ""


def host_match(host: str, domains: list) -> bool:
    return any(host == d or host.endswith("." + d) for d in domains)


def fetch_mode(crawler: str, url: str) -> str:
    if crawler == "substack":
        return "direct"  # 生产走 node:fetch 直连(impit TLS 被 cf 拉黑)
    if crawler in ("medium", "paragraph"):
        return "medium"  # 生产走池 B
    h = host_of(url)
    if host_match(h, MEDIUM_DOMAINS):
        return "medium"
    if host_match(h, DIRECT_HOSTS):
        return "direct"  # 生产 newUrlFunction 返 null 跳过代理
    return "main"


items = []
for fp in sorted(glob.glob("storage/datasets/default/*.json")):
    with open(fp) as f:
        it = json.load(f)
    url = it.get("url") or ""
    crawler = it.get("crawler") or ""
    items.append({
        "token_id": it.get("token_id"),
        "base_symbol": it.get("base_symbol"),
        "blog_url": it.get("source_url"),
        "crawler": crawler,
        "url": url,
        "title": (it.get("title") or "")[:300],
        "h1": (it.get("h1") or "")[:300],
        "description": (it.get("description") or "")[:500],
        "published_at": it.get("published_at") or it.get("publishedTime") or (it.get("og") or {}).get("publishedTime") or "",
        "fetch_mode": fetch_mode(crawler, url),
    })

# unique URL 级 probe 输入(1-to-N 共享 URL 只探一次)
seen = {}
for it in items:
    if it["url"] and it["url"] not in seen:
        seen[it["url"]] = {"id": it["url"], "url": it["url"], "fetch_mode": it["fetch_mode"]}

with open("/tmp/audit-items.json", "w") as f:
    json.dump(items, f, ensure_ascii=False)
with open("/tmp/audit-probe-input.json", "w") as f:
    json.dump(list(seen.values()), f, ensure_ascii=False)

by_crawler = {}
for it in items:
    by_crawler[it["crawler"]] = by_crawler.get(it["crawler"], 0) + 1
tokens = {it["token_id"] for it in items}
multi = [t for t in tokens if sum(1 for i in items if i["token_id"] == t) > 1]
print(f"条目 {len(items)} · unique token {len(tokens)} · unique URL {len(seen)}")
print(f"按 crawler: {json.dumps(by_crawler, ensure_ascii=False)}")
if multi:
    print(f"⚠️ 每源>1 条的 token(cap 应保证为 0): {multi[:20]}")
else:
    print("✅ 每 token ≤1 条(cap 生效)")
