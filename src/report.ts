import { db, countSources } from './registry/db.js';

interface Row { c: number; v: string | number | null }

function group(sql: string, label: string): void {
    const rows = db().prepare(sql).all() as Row[];
    console.log(`\n=== ${label} ===`);
    const total = rows.reduce((a, r) => a + r.c, 0);
    for (const r of rows) {
        const pct = ((r.c / total) * 100).toFixed(1);
        const v = r.v === null || r.v === undefined ? '(null)' : String(r.v);
        console.log(`  ${v.padEnd(20)} ${String(r.c).padStart(5)}  ${pct}%`);
    }
}

const total = countSources();
const probed = (db().prepare('SELECT COUNT(*) as c FROM sources WHERE probed_at IS NOT NULL').get() as { c: number }).c;
console.log(`📊 Source Registry 分布报告 · 总 ${total} 条 · 已 probe ${probed} 条`);

group(`SELECT COUNT(*) as c, fetch_strategy as v FROM sources WHERE probed_at IS NOT NULL GROUP BY fetch_strategy ORDER BY c DESC`, 'fetch_strategy 抓取策略');
group(`SELECT COUNT(*) as c, og_quality as v FROM sources WHERE probed_at IS NOT NULL GROUP BY og_quality ORDER BY c DESC`, 'og_quality OG 完整度');
group(`SELECT COUNT(*) as c, host_platform as v FROM sources WHERE probed_at IS NOT NULL GROUP BY host_platform ORDER BY c DESC`, 'host_platform 托管平台');
group(`SELECT COUNT(*) as c, http_status as v FROM sources WHERE probed_at IS NOT NULL GROUP BY http_status ORDER BY c DESC`, 'http_status HTTP 状态');
group(`SELECT COUNT(*) as c, blogpicker_status as v FROM sources GROUP BY blogpicker_status ORDER BY c DESC`, 'blogpicker_status(参考)');

const hasSitemap = (db().prepare('SELECT COUNT(*) as c FROM sources WHERE probed_at IS NOT NULL AND sitemap_url IS NOT NULL').get() as { c: number }).c;
const noSitemap = probed - hasSitemap;
console.log(`\n=== sitemap 可用性 ===\n  有 sitemap          ${String(hasSitemap).padStart(5)}  ${(hasSitemap/probed*100).toFixed(1)}%\n  无 sitemap          ${String(noSitemap).padStart(5)}  ${(noSitemap/probed*100).toFixed(1)}%`);
