// 🆕 2026-07-04 质量战役:存量 articles 清理(与收割层/pusher/聚合同一过滤语义)
// 用法:npx tsx ops/clean-articles.ts          → 只统计不删(dry-run)
//       npx tsx ops/clean-articles.ts --confirm → 真删(删除行先备份到 storage/cleaned-articles-<ts>.json)
// 顺序铁律:必须在收割过滤(run-batch)上线后执行,否则补漏扫描会把删掉的从 dataset 重新收进来
import { writeFileSync } from 'node:fs';
import { db } from '../shared/db.js';
import { isNoiseUrl, isNonArticleFile, isLandingUrl, isBlacklistedHost, isBlockedSubdomainUrl, hostOfUrl, normalizedHostOfUrl, isWhitelistedArticleUrl } from '../src/utils/article-filter.js';

const confirm = process.argv.includes('--confirm');
const d = db();

const blogHostByToken = new Map<number, string>();
for (const r of d.prepare('SELECT token_id, blog_url FROM sources').all() as { token_id: number; blog_url: string }[]) {
    blogHostByToken.set(r.token_id, hostOfUrl(r.blog_url ?? ''));
}

interface Row { url: string; token_id: number; base_symbol: string; title: string }
const rows = d.prepare('SELECT url, token_id, base_symbol, title FROM articles').all() as Row[];

// 与 filterArticlesWhitelistFirst 同语义 · 🆕 2026-07-05 host 级口径:
// 同 host 内有白名单文才独占该 host · 跨渠道(官网白名单 vs medium/子域博客)不互杀(OXT/NIL/EDEN/DCR 实锤)
const whiteByTokenHost = new Set<string>();
for (const r of rows) {
    if (isWhitelistedArticleUrl(r.url)) whiteByTokenHost.add(`${r.token_id}:${normalizedHostOfUrl(r.url)}`);
}

const reasons = new Map<string, number>();
const doomed: (Row & { reason: string })[] = [];
for (const r of rows) {
    let reason = '';
    if (isNonArticleFile(r.url)) reason = 'file';
    else if (isBlacklistedHost(r.url)) reason = 'blacklisted_host'; // 🆕 2026-07-05 补(socios/ravencoin 型拉黑域)
    else if (isNoiseUrl(r.url)) reason = 'noise';
    else if (isLandingUrl(r.url)) reason = 'landing';
    else if (isBlockedSubdomainUrl(r.url, blogHostByToken.get(r.token_id))) reason = 'blocked_subdomain';
    else if (whiteByTokenHost.has(`${r.token_id}:${normalizedHostOfUrl(r.url)}`) && !isWhitelistedArticleUrl(r.url)) reason = 'non_whitelist';
    if (reason) {
        doomed.push({ ...r, reason });
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
}

console.log(`全库 ${rows.length} 条 · 判垃圾 ${doomed.length} 条`);
console.log('分桶:', Object.fromEntries(reasons));
const bySym = new Map<string, number>();
for (const x of doomed) bySym.set(x.base_symbol, (bySym.get(x.base_symbol) ?? 0) + 1);
console.log('受影响源 TOP15:', [...bySym.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15));

if (!confirm) {
    console.log('\n(dry-run · 加 --confirm 真删 · 删除行会先备份)');
    process.exit(0);
}

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const backup = `storage/cleaned-articles-${ts}.json`;
writeFileSync(backup, JSON.stringify(doomed, null, 1));
const del = d.prepare('DELETE FROM articles WHERE url = ? AND token_id = ?');
const tx = d.transaction((items: typeof doomed) => { for (const x of items) del.run(x.url, x.token_id); });
tx(doomed);
console.log(`✅ 已删 ${doomed.length} 条 · 备份 ${backup}`);
console.log('剩余:', (d.prepare('SELECT count(*) c FROM articles').get() as { c: number }).c, '条');
