#!/usr/bin/env python3
# 聚合 dataset + sources.db → 报告 JSON(服务器跑)
# 用法: cd ~/crawlee-blog-poc && python3 scripts/aggregate-report.py [输出路径 · 默认 /tmp/poc-report.json]
#
# 过滤规则唯一真源: src/utils/filter-config.json(跟 TS 层 article-filter.ts 同一份)
# 语义(老板 2026-07-01 拍):
#   1. 文件型 URL(.xml/.rss/...)直接丢(修 MINIMAX sitemap.xml bug)
#   2. 该 token 有白名单 article(/blog/ /post/ 等)→ 只留白名单 · dataset_count 同步变
#   3. published_at 统一 ISO-8601(RFC-2822 / 带时区 都转 UTC Z)
# 输出 meta.filter_config → HTML 客户端从 data 读清单 · 不再硬编码
import json, glob, sqlite3, os, re, sys
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import urlparse

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/poc-report.json'

with open(os.path.join(REPO, 'src/utils/filter-config.json')) as f:
    FC = json.load(f)
WHITELIST = set(FC['whitelist_segments'])
LANDING = set(FC['landing_segments'])
BAD_EXT = re.compile(r'\.(' + '|'.join(FC['file_extensions']) + r')$', re.I)


def path_segs(url):
    try:
        return [s for s in urlparse(url).path.lower().split('/') if s]
    except Exception:
        return None


def is_white(url):
    segs = path_segs(url or '')
    return bool(segs) and any(s in WHITELIST for s in segs)


def is_non_article(url):
    if not url:
        return False
    try:
        return bool(BAD_EXT.search(urlparse(url).path))
    except Exception:
        return False


def normalize_pub(raw):
    if not raw:
        return ''
    s = str(raw).strip()
    if not s:
        return ''
    try:
        dt = datetime.fromisoformat(s.replace('Z', '+00:00'))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')
    except (ValueError, TypeError):
        pass
    try:
        dt = parsedate_to_datetime(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')
    except (TypeError, ValueError, IndexError):
        pass
    return s  # 不能解 → 透传 · 报告里能看到异常格式


con = sqlite3.connect(os.path.join(REPO, 'storage/sources.db'))
con.row_factory = sqlite3.Row
sources = [dict(r) for r in con.execute(
    "SELECT token_id, base_symbol, blog_url, host_platform, og_quality, "
    "fetch_strategy, sitemap_url, sitemap_count, http_status, blogpicker_status "
    "FROM sources ORDER BY token_id").fetchall()]
con.close()

by_token = {}
for f in glob.glob(os.path.join(REPO, 'storage/datasets/default/*.json')):
    try:
        with open(f) as fh:
            d = json.load(fh)
        tk = d.get('token_id')
        if tk is None:
            continue
        e = by_token.setdefault(tk, {'count': 0, 'crawlers': set(), 'articles': []})
        e['count'] += 1
        e['crawlers'].add(d.get('crawler') or 'unknown')
        raw_desc = d.get('description') or ''
        e['articles'].append({
            'title': (d.get('title') or '')[:160],
            'url': d.get('url') or '',
            'pub': normalize_pub(d.get('published_at') or d.get('publishedTime') or ''),
            'crawler': d.get('crawler') or '',
            'desc': re.sub(r'\s+', ' ', raw_desc).strip()[:200],
        })
    except Exception:
        pass

dropped_file = 0
dropped_non_white = 0
white_hit_sources = 0
for tk, e in by_token.items():
    arts = e['articles']
    arts.sort(key=lambda a: (1 if a['title'] else 0, a['pub']), reverse=True)
    real = [a for a in arts if not is_non_article(a.get('url', ''))]
    dropped_file += len(arts) - len(real)
    white = [a for a in real if is_white(a.get('url', ''))]
    if white:
        e['articles'] = white
        e['count'] = len(white)
        white_hit_sources += 1
        dropped_non_white += len(real) - len(white)
    else:
        e['articles'] = real
        e['count'] = len(real)
    e['crawlers'] = sorted(e['crawlers'])

for s in sources:
    e = by_token.get(s['token_id'])
    if e:
        s['dataset_count'] = e['count']
        s['crawlers'] = e['crawlers']
        s['articles'] = e['articles']
    else:
        s['dataset_count'] = 0
        s['crawlers'] = []
        s['articles'] = []

summary = {
    'total': len(sources),
    'have_data': sum(1 for s in sources if s['dataset_count'] > 0),
    'dataset_total': sum(s['dataset_count'] for s in sources),
}
out = {
    'sources': sources,
    'summary': summary,
    'meta': {
        'filter_config': FC,
        'dropped_file_urls': dropped_file,
        'dropped_non_whitelist': dropped_non_white,
        'whitelist_hit_sources': white_hit_sources,
    },
}
with open(OUT, 'w') as fh:
    json.dump(out, fh, ensure_ascii=False)
print(f'✅ {OUT} · {os.path.getsize(OUT)} bytes')
print(f'   summary: {summary}')
print(f'   文件型 URL 丢弃 {dropped_file} · 白名单命中 {white_hit_sources} 源 · 丢非白名单 {dropped_non_white}')
