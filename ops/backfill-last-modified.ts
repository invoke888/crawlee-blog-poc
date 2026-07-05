// 🆕 2026-07-05 老板拍:HTTP Last-Modified 作为发布时间的最后兜底(billions.network 实锤)
// 存量空 published_at 行 → HEAD 探测协议头 → 防线(动态now/未来)→ 补空落库(只 UPDATE 空行 · 非空永不覆盖)
// 用法:npx tsx ops/backfill-last-modified.ts           → dry-run(探测+统计 · 不写库)
//       npx tsx ops/backfill-last-modified.ts --confirm → 落库(先备份受影响行)
// 已知精度边界(老板知情拍板):Webflow 类站重新发布会刷新老文协议头 → 兜底值≈"站点最近一次含该文的发布日" · 宁可粗有不可全无
import { writeFileSync } from 'node:fs';
import { db } from '../shared/db.js';
import { normalizeHeaderLastModified } from '../src/utils/normalize-date.js';
import { isDeadHost, isDcBannedHost, isBlacklistedHost } from '../src/utils/article-filter.js';
import { rulesFor } from '../src/utils/date-extract.js';

const confirm = process.argv.includes('--confirm');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const CONCURRENCY = 4;

const d = db();
interface Row { url: string; base_symbol: string }
const rows = d.prepare(`
    SELECT url, MIN(base_symbol) AS base_symbol FROM articles
    WHERE published_at IS NULL OR published_at = '' GROUP BY url
`).all() as Row[];

const skipped: Record<string, number> = {};
const targets = rows.filter((r) => {
    if (isDeadHost(r.url) || isDcBannedHost(r.url) || isBlacklistedHost(r.url)) { skipped.banned = (skipped.banned ?? 0) + 1; return false; }
    if (rulesFor(r.url)?.date?.ban?.includes('last_modified')) { skipped.rule_ban = (skipped.rule_ban ?? 0) + 1; return false; }
    return true;
});
console.log(`空 pub 去重 URL:${rows.length} · 探测目标:${targets.length} · 跳过:${JSON.stringify(skipped)}`);

async function probe(url: string): Promise<string> {
    for (const method of ['HEAD', 'GET'] as const) {
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 15_000);
            const res = await fetch(url, { method, headers: { 'user-agent': UA, accept: 'text/html' }, redirect: 'follow', signal: ctrl.signal });
            clearTimeout(timer);
            if (method === 'GET') void res.body?.cancel();
            if (res.status === 405 && method === 'HEAD') continue; // 站点不支持 HEAD → 换 GET 只读头
            return res.headers.get('last-modified') ?? '';
        } catch { if (method === 'GET') return ''; }
    }
    return '';
}

const results: { url: string; base_symbol: string; lm: string; iso: string }[] = [];
let done = 0;
async function worker(queue: Row[]): Promise<void> {
    for (;;) {
        const r = queue.shift();
        if (!r) return;
        const lm = await probe(r.url);
        const iso = normalizeHeaderLastModified(lm, Date.now());
        results.push({ url: r.url, base_symbol: r.base_symbol, lm, iso });
        done += 1;
        if (done % 50 === 0) console.log(`… ${done}/${targets.length}`);
    }
}
const queue = [...targets];
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));

const withLm = results.filter((r) => r.lm);
const usable = results.filter((r) => r.iso);
const bySym = new Map<string, number>();
for (const r of usable) bySym.set(r.base_symbol, (bySym.get(r.base_symbol) ?? 0) + 1);
console.log(`\n探测完成:${results.length} URL · 带 last-modified:${withLm.length} · 过防线可用:${usable.length}(丢弃 ${withLm.length - usable.length}:动态now/未来)`);
console.log('可救回按源:', [...bySym.entries()].sort((a, b) => b[1] - a[1]));

if (!confirm) { console.log('\n(dry-run · 加 --confirm 落库 · 只补空行不覆盖非空)'); process.exit(0); }

const ts = new Date().toISOString().replace(/[:.]/g, '-');
writeFileSync(`storage/backfill-lm-${ts}.json`, JSON.stringify(usable, null, 1));
const upd = d.prepare(`UPDATE articles SET published_at = ? WHERE url = ? AND (published_at IS NULL OR published_at = '')`);
let updated = 0;
const tx = d.transaction((items: typeof usable) => { for (const r of items) updated += upd.run(r.iso, r.url).changes; });
tx(usable);
console.log(`✅ 落库:${updated} 行补上发布时间 · 备份 storage/backfill-lm-${ts}.json`);
