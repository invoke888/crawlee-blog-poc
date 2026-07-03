// 🆕 2026-07-03 平台源探测:对全部非平台源试 /feed 与 /rss(生产指纹+主力池)
// 目的:找出 custom-domain 部署的 Medium/Substack/Paragraph/Ghost 源(自测战役实锤 14 例 · 全库摸底)
// 用法(服务器): npx tsx scripts/detect-feed.ts /tmp/detect-feed.jsonl
import { appendFileSync, writeFileSync } from 'node:fs';
import { Impit } from 'impit';
import { listSources } from '../src/registry/db.js';
import { isBlacklistedHost, isValidHttpUrl, isDcBannedHost, isDeadHost } from '../src/utils/article-filter.js';

const outFile = process.argv[2] ?? '/tmp/detect-feed.jsonl';
const PLATFORM_HANDLED = new Set(['medium', 'paragraph', 'substack', 'mirror']);

const sources = listSources({ limit: 5000 }).filter((s) =>
    isValidHttpUrl(s.blog_url)
    && !isBlacklistedHost(s.blog_url) && !isDcBannedHost(s.blog_url) && !isDeadHost(s.blog_url)
    && !PLATFORM_HANDLED.has(s.host_platform ?? ''),
);
const byHost = new Map<string, string[]>();
for (const s of sources) {
    try {
        const origin = new URL(s.blog_url).origin;
        const arr = byHost.get(origin) ?? [];
        arr.push(s.base_symbol);
        byHost.set(origin, arr);
    } catch { /* skip */ }
}
console.log(`待探测 ${byHost.size} unique origin(${sources.length} 源)`);

const impit = new Impit({ browser: 'chrome', proxyUrl: process.env.PROXY_URL || undefined, timeout: 15000 });

function guessPlatform(xml: string): string {
    const head = xml.slice(0, 4000);
    const gen = /<generator>([^<]{0,120})<\/generator>/i.exec(head)?.[1] ?? '';
    if (/medium/i.test(gen)) return 'medium';
    if (/substack/i.test(gen)) return 'substack';
    if (/ghost/i.test(gen)) return 'ghost';
    if (/wordpress/i.test(gen)) return 'wordpress';
    if (/paragraph/i.test(gen) || /paragraph\.(xyz|com)/i.test(head)) return 'paragraph';
    if (gen) return `other:${gen.slice(0, 40)}`;
    if (/cdn-images-1\.medium\.com|medium\.com\/feed/i.test(head)) return 'medium';
    return 'generic';
}

writeFileSync(outFile, '');
let done = 0;
const queue = Array.from(byHost.entries());
async function worker(): Promise<void> {
    while (queue.length > 0) {
        const [origin, symbols] = queue.shift()!;
        const line: Record<string, unknown> = { origin, symbols };
        for (const path of ['/feed', '/rss']) {
            try {
                const res = await impit.fetch(`${origin}${path}`, {
                    headers: { 'Accept': 'application/rss+xml,application/xml;q=0.9,*/*;q=0.8' },
                });
                const body = await res.text();
                const isFeed = res.status === 200 && /<(rss|feed)[\s>]/i.test(body.slice(0, 2000));
                if (isFeed) {
                    line.feed_path = path;
                    line.http = res.status;
                    line.is_feed = true;
                    line.platform_guess = guessPlatform(body);
                    line.item_count = (body.match(/<(item|entry)[\s>]/gi) ?? []).length;
                    break;
                }
                line.http = res.status;
                line.is_feed = false;
            } catch (e) {
                line.http = -1;
                line.error = ((e as Error).message ?? '').slice(0, 120);
            }
        }
        appendFileSync(outFile, `${JSON.stringify(line)}\n`);
        done += 1;
        if (done % 25 === 0) console.log(`… ${done}/${byHost.size}`);
        await new Promise((r) => setTimeout(r, 250));
    }
}
await Promise.all(Array.from({ length: 4 }, () => worker()));
console.log(`✅ detect-feed 完成 ${done}/${byHost.size} → ${outFile}`);
process.exit(0);
