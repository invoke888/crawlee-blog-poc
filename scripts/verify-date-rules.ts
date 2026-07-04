// 🆕 2026-07-04 per-source 时间规则批量验证(fixture 驱动 · 不打真站)
// 用法:npx tsx scripts/verify-date-rules.ts <fixture目录>   (目录含 manifest.json + *.html)
// 对每源每份存档 HTML 跑 extractPublishedAt(带该 host 规则)· 输出抽取值与规则产出对照
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as cheerio from 'cheerio';
import { extractPublishedAt } from '../src/utils/date-extract.js';
import { normalizePublishedAt } from '../src/utils/normalize-date.js';

const dir = process.argv[2] || '/tmp/date-rule-html';
interface Art { url: string; db_pub: string; html_file: string }
interface Src { token_id: number; symbol: string; blog_url: string; problem: string; articles: Art[] }
const manifest = JSON.parse(readFileSync(resolve(dir, 'manifest.json'), 'utf-8')) as Src[];

type $T = Parameters<typeof extractPublishedAt>[0];
let okN = 0, emptyN = 0, files = 0;
const bySrc: { symbol: string; problem: string; got: string[] }[] = [];
for (const s of manifest) {
    const got: string[] = [];
    for (const a of s.articles) {
        const fp = resolve(dir, a.html_file);
        if (!existsSync(fp)) continue;
        files += 1;
        const $ = cheerio.load(readFileSync(fp, 'utf-8')) as unknown as $T;
        const raw = extractPublishedAt($, a.url);
        const norm = normalizePublishedAt(raw);
        got.push(norm || '(空)');
        if (norm) okN += 1; else emptyN += 1;
    }
    bySrc.push({ symbol: s.symbol, problem: s.problem, got });
}
console.log(`fixture ${files} 份 · 抽到时间 ${okN} · 空 ${emptyN}(空=strategy none/spa_only 或规则未覆盖)`);
// 同源产出全相同(且非空)= 模板污染未根治的信号
const suspicious = bySrc.filter((r) => r.got.length >= 2 && r.got[0] !== '(空)' && r.got.every((g) => g === r.got[0]));
console.log(`⚠️ 同源多篇抽出完全相同时间(需人工看):${suspicious.length} 源`, suspicious.slice(0, 10).map((r) => r.symbol));
for (const r of bySrc) console.log(`  ${r.symbol.padEnd(10)} [${r.problem}] ${r.got.join(' | ')}`);
