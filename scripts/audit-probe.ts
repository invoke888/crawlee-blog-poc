// 🆕 2026-07-03 自测审计批量探针:生产同款 ImpitHttpClient Chrome 指纹 + 按 fetch_mode 选池
// (与生产采集路径一致:main→主力池 · medium→池B · direct→直连)· 供 agent 审查用 · 杜绝裸 curl
// 用法: npx tsx scripts/audit-probe.ts <input.json> <out.jsonl> [并发=3]
// 输入: [{id, url, fetch_mode: 'main'|'medium'|'direct'}]
// 输出: JSONL 每行 = 该 URL 的独立视角抽取(跟 dataset 对照 · 差异即审查信号)
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { Impit } from 'impit';
import * as cheerio from 'cheerio';

const inFile = process.argv[2];
const outFile = process.argv[3];
const CONCURRENCY = Number(process.argv[4] ?? 3);
if (!inFile || !outFile) {
    console.error('用法: npx tsx scripts/audit-probe.ts <input.json> <out.jsonl> [并发=3]');
    process.exit(1);
}

interface AuditItem { id: string; url: string; fetch_mode: 'main' | 'medium' | 'direct' }
const items: AuditItem[] = JSON.parse(readFileSync(inFile, 'utf-8'));

const PROXY_URL = process.env.PROXY_URL || undefined;
const PROXY_URL_MEDIUM = process.env.PROXY_URL_MEDIUM || PROXY_URL;
const clients = new Map<string, Impit>();
function clientFor(mode: AuditItem['fetch_mode']): Impit {
    const proxyUrl = mode === 'direct' ? undefined : mode === 'medium' ? PROXY_URL_MEDIUM : PROXY_URL;
    const key = proxyUrl ?? 'direct';
    let c = clients.get(key);
    if (!c) {
        c = new Impit({ browser: 'chrome', proxyUrl, timeout: 25000 });
        clients.set(key, c);
    }
    return c;
}

function extract(html: string): Record<string, unknown> {
    const $ = cheerio.load(html);
    // json-ld headline / datePublished(正则轻抽 · 不解析全结构)
    let jsonldHeadline = '';
    let jsonldDate = '';
    $('script[type="application/ld+json"]').each((_, el) => {
        const txt = $(el).text();
        if (!jsonldHeadline) jsonldHeadline = /"headline"\s*:\s*"([^"]{1,300})"/.exec(txt)?.[1] ?? '';
        if (!jsonldDate) jsonldDate = /"datePublished"\s*:\s*"([^"]{1,60})"/.exec(txt)?.[1] ?? '';
    });
    $('script, style, noscript, svg').remove();
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 600);
    return {
        title_tag: $('title').first().text().trim().slice(0, 300),
        og_title: $('meta[property="og:title"]').attr('content')?.trim().slice(0, 300) ?? '',
        og_desc: $('meta[property="og:description"]').attr('content')?.trim().slice(0, 400) ?? '',
        meta_desc: $('meta[name="description"]').attr('content')?.trim().slice(0, 400) ?? '',
        og_type: $('meta[property="og:type"]').attr('content')?.trim() ?? '',
        h1: $('h1').first().text().replace(/\s+/g, ' ').trim().slice(0, 300),
        published_meta:
            $('meta[property="article:published_time"]').attr('content')?.trim() ||
            $('meta[property="article:modified_time"]').attr('content')?.trim() ||
            $('meta[itemprop="datePublished"]').attr('content')?.trim() ||
            $('time[datetime]').first().attr('datetime')?.trim() || '',
        jsonld_headline: jsonldHeadline,
        jsonld_date: jsonldDate,
        body_text: bodyText,
    };
}

writeFileSync(outFile, '');
let done = 0;
const queue = [...items];
async function worker(): Promise<void> {
    while (queue.length > 0) {
        const item = queue.shift()!;
        let line: Record<string, unknown>;
        try {
            const res = await clientFor(item.fetch_mode).fetch(item.url, {
                headers: {
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                },
            });
            const html = await res.text();
            line = { id: item.id, url: item.url, fetch_mode: item.fetch_mode, http: res.status, size: html.length, ...extract(html) };
        } catch (e) {
            line = { id: item.id, url: item.url, fetch_mode: item.fetch_mode, http: -1, error: ((e as Error).message ?? String(e)).slice(0, 200) };
        }
        appendFileSync(outFile, `${JSON.stringify(line)}\n`);
        done += 1;
        if (done % 20 === 0 || done === items.length) console.log(`… ${done}/${items.length}`);
        await new Promise((r) => setTimeout(r, 300));
    }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
console.log(`✅ audit-probe 完成 ${done}/${items.length} → ${outFile}`);
process.exit(0);
