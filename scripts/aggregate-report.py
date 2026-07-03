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
from datetime import datetime, timezone, timedelta
from email.utils import parsedate_to_datetime
from urllib.parse import urlparse, parse_qs

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/poc-report.json'

with open(os.path.join(REPO, 'src/utils/filter-config.json')) as f:
    FC = json.load(f)
with open(os.path.join(REPO, 'src/utils/source-rules.json')) as f:
    SOURCE_RULES = json.load(f).get('rules', {})
WHITELIST = set(FC['whitelist_segments'])
LANDING = set(FC['landing_segments'])
BAD_EXT = re.compile(r'\.(' + '|'.join(FC['file_extensions']) + r')$', re.I)
# 🆕 2026-07-03 自测战役:noise 段(列表/系统页 · 与 TS isNoiseUrl 同语义)
NOISE = set(FC.get('noise_segments', []))
NOISE_LAST = set(FC.get('noise_last_segments', []))
PAGINATION_LAST = re.compile(r'^(?:\d{1,3}|(?:19|20)\d{2}|(?:blog|news|posts?|articles?)-(?:all|\d{1,3}))$')


def host_in(url, domains):
    try:
        h = (urlparse(url).hostname or '').lower()
        return any(h == d or h.endswith('.' + d) for d in domains)
    except Exception:
        return False


# 🆕 P2#2+7 per-source 规则命中(体检尺子升级 + pattern 腐烂监控)
def rule_hit(sym, url):
    """返回 'pass'/'reject'/'no-rule' · 与 TS 端 checkSourceRule 同语义"""
    rule = SOURCE_RULES.get(sym)
    if not rule:
        return 'no-rule'
    try:
        path = urlparse(url).path.lower()
    except Exception:
        return 'reject'
    p = path if path.endswith('/') else path + '/'
    for ex in rule.get('exclude_prefixes') or []:
        if p == ex or p.startswith(ex):
            return 'reject'
    if rule.get('confidence') != 'high':
        return 'no-rule'
    incs = rule.get('include_prefixes') or []
    rx = rule.get('include_regex')
    if not incs and not rx:
        return 'no-rule'
    for inc in incs:
        if p == inc or p.startswith(inc):
            return 'pass'
    if rx:
        try:
            if re.search(rx, path):
                return 'pass'
        except re.error:
            pass
    return 'reject'


# 处置状态(2026-07-03 老板要求:挂起/放弃必须在报告源表行级可见)
def disposition(blog_url):
    if host_in(blog_url, FC.get('host_blacklist', [])):
        return 'blacklist', '误判非博客(gitbook/github 类)'
    if host_in(blog_url, FC.get('dc_banned_hosts', [])):
        return 'suspended', '挂起:反爬双路403/JS壳 · Playwright/住宅代理后恢复'
    if host_in(blog_url, FC.get('dead_hosts', [])):
        return 'dead', '永久放弃:站上无博客/域名死/账号封/停更多年(agent 实测)'
    if host_in(blog_url, FC.get('direct_hosts', [])):
        return 'direct', '直连采集(代理被该站单独挑战)'
    return 'active', ''


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


# 🆕 2026-07-03 自测战役:列表/系统页 URL(followers/tag/分页/年份归档/语言码末段/collection_home_page)
# 与 TS isNoiseUrl(article-filter.ts)同语义 · 修 medium custom-domain 源白名单不触发时系统页全放行
def is_noise(url):
    if not url:
        return False
    try:
        u = urlparse(url)
        segs = [s for s in u.path.lower().split('/') if s]
        if any(s in NOISE for s in segs):
            return True
        # 末段剥 .html/.php 类后缀再匹配(steemit login.html 实锤)· 与 TS isNoiseUrl 同语义
        last = re.sub(r'\.(html?|php|aspx?)$', '', segs[-1]) if segs else ''
        if last and (PAGINATION_LAST.match(last) or last in NOISE_LAST or last.startswith('sitemap')):
            return True
        if last and last in LANDING and not any(s in WHITELIST for s in segs):
            return True
        q = parse_qs(u.query)
        if 'collection_home_page' in (q.get('source', [''])[0] or ''):
            return True
        if 'orderBy' in q:
            return True
        return False
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
    return ''  # 🆕 2026-07-03 B1 行为变更(老板拍):不能解 → 置空(BABY 'Insert Publish Date' 占位符实锤)


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
    real = [a for a in arts if not is_non_article(a.get('url', '')) and not is_noise(a.get('url', ''))]
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
    d, reason = disposition(s['blog_url'])
    s['disposition'] = d
    s['disposition_reason'] = reason
    # 🆕 P2#2+7 规则命中率(有 high 规则的源)· 腐烂监控数据源
    sym = s['base_symbol']
    if sym in SOURCE_RULES and s['articles']:
        hits = [rule_hit(sym, a['url']) for a in s['articles'] if a.get('url')]
        n_judged = sum(1 for h in hits if h != 'no-rule')
        if n_judged:
            s['pattern_hit_ratio'] = round(sum(1 for h in hits if h == 'pass') / n_judged, 2)

summary = {
    'total': len(sources),
    'have_data': sum(1 for s in sources if s['dataset_count'] > 0),
    'dataset_total': sum(s['dataset_count'] for s in sources),
}
# 🆕 一致性自检:probe 状态 vs 采集事实矛盾(有数据但 probe=-1)· 提醒 probe 快照过时 · 别拿它说事
stale_probe = sum(1 for s in sources if s['dataset_count'] > 0 and s.get('http_status') == -1)
if stale_probe:
    print(f'⚠️ {stale_probe} 源 probe 状态(-1)与采集事实(有数据)矛盾 · probe 是历史快照 · 报告状态列已改以采集为准')

# 🆕 P2#7 pattern 腐烂告警:有规则源命中率 <50% = 站可能改版 · 规则失效
pattern_alerts = [
    {'sym': s['base_symbol'], 'hit_ratio': s['pattern_hit_ratio'], 'blog_url': s['blog_url']}
    for s in sources
    if s.get('pattern_hit_ratio') is not None and s['pattern_hit_ratio'] < 0.5 and s['dataset_count'] > 0
]
if pattern_alerts:
    print(f'🔴 pattern 腐烂告警 {len(pattern_alerts)} 源(规则命中 <50% · 站可能改版):'
          + ', '.join(f"{a['sym']}({a['hit_ratio']})" for a in pattern_alerts[:10]))
out = {
    'sources': sources,
    'summary': summary,
    'meta': {
        'filter_config': FC,
        'dropped_file_urls': dropped_file,
        'dropped_non_whitelist': dropped_non_white,
        'whitelist_hit_sources': white_hit_sources,
        # 生成时间(北京)· HTML 标题/落款动态渲染用 · 修"报告日期不同步"问题
        'generated_at': datetime.now(timezone(timedelta(hours=8))).strftime('%Y-%m-%d %H:%M'),
        # P2#7 pattern 腐烂告警(规则命中 <50% 的有数据源)
        'pattern_alerts': pattern_alerts,
    },
}
with open(OUT, 'w') as fh:
    json.dump(out, fh, ensure_ascii=False)
print(f'✅ {OUT} · {os.path.getsize(OUT)} bytes')
print(f'   summary: {summary}')
print(f'   文件型 URL 丢弃 {dropped_file} · 白名单命中 {white_hit_sources} 源 · 丢非白名单 {dropped_non_white}')
