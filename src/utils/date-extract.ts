// 🆕 2026-07-03 article 详情页元数据抽取梯队增强
// 背景(feature-scan.json 分桶实证):
//   A 桶 23 源:HTML 有 json-ld datePublished · 现有代码只测 json-ld 存在性(article.ts hasJsonLdArticle)· 不抽值
//   D 桶 8 源:Next.js 站 · 发布时间埋在 <script id="__NEXT_DATA__"> JSON 里
// 抽成独立函数(而非塞进 article.ts 内联)· 方便 cheerio.load(fixture) 单测 · 不用起真 crawler
//
// 类型注意:不直接 `import type { CheerioAPI } from 'cheerio'` —— cheerio 包 CJS/ESM 各有一份 .d.ts
// (dual package hazard)· 项目是 ESM 但 @crawlee/cheerio 是 CJS · 两边解析出的 CheerioAPI 结构上不兼容
// (TS2345 · Tokenizer 私有属性 cbs 声明不同源)。改用 CheerioCrawlingContext['$'] 保证跟 article.ts
// 传进来的 $ 是同一次解析出来的类型 · 不会跨边界撞车。
import type { CheerioCrawlingContext } from 'crawlee';
import { createRequire } from 'node:module';
import { extractDateFromUrl } from './article-filter.js';

type CheerioAPI = CheerioCrawlingContext['$'];

// ── per-source 时间规则(2026-07-04 老板拍:站点定制根治)──
const require = createRequire(import.meta.url);
export interface DateRule {
    ban?: string[];               // 禁用层:jsonld / meta / time_tag / nextdata
    selector?: string;            // 定点 css
    attr?: string;                // datetime | content | text
    regex?: string;               // 从 text 提日期
    strategy?: 'url_date' | 'none' | 'spa_only';
}
const dateRulesCfg = require('./date-rules.json') as { rules: Record<string, DateRule> };
export function dateRuleFor(url: string): DateRule | null {
    try {
        const h = new URL(url).hostname.toLowerCase();
        for (const [host, rule] of Object.entries(dateRulesCfg.rules)) {
            if (h === host || h.endsWith(`.${host}`)) return rule;
        }
        return null;
    } catch {
        return null;
    }
}

const ARTICLE_TYPES = new Set(['blogposting', 'article', 'newsarticle']);

function isArticleTypeNode(node: Record<string, unknown>): boolean {
    const t = node['@type'];
    if (typeof t === 'string') return ARTICLE_TYPES.has(t.toLowerCase());
    if (Array.isArray(t)) return t.some((x) => typeof x === 'string' && ARTICLE_TYPES.has(x.toLowerCase()));
    return false;
}

// json-ld 顶层形态不定:单对象 / 对象数组 / 带 @graph 嵌套(WordPress Yoast 插件常见)
// 展平成候选节点列表 · 调用方再逐个找 Article 系节点
function flattenLdNodes(data: unknown): Record<string, unknown>[] {
    const nodes: Record<string, unknown>[] = [];
    const visit = (val: unknown): void => {
        if (Array.isArray(val)) {
            for (const item of val) visit(item);
            return;
        }
        if (val && typeof val === 'object') {
            const obj = val as Record<string, unknown>;
            nodes.push(obj);
            if (Array.isArray(obj['@graph'])) visit(obj['@graph']);
        }
    };
    visit(data);
    return nodes;
}

export interface JsonLdMeta {
    datePublished: string;
    dateModified: string;
    description: string;
}

// 解析页面全部 json-ld <script> · 抽第一个 BlogPosting/Article/NewsArticle 节点的
// datePublished/dateModified/description · 缺的字段允许后续 script 补上(合并 · 不覆盖已找到的)
// 坏 JSON(JSON.parse 失败)不抛错 · 跳过该 script 继续找下一个
export function extractJsonLdMeta($: CheerioAPI): JsonLdMeta {
    const result: JsonLdMeta = { datePublished: '', dateModified: '', description: '' };
    const scripts = $('script[type="application/ld+json"]');
    for (let i = 0; i < scripts.length; i++) {
        const txt = $(scripts[i]).text();
        if (!txt || !txt.trim()) continue;
        let data: unknown;
        try {
            data = JSON.parse(txt);
        } catch {
            continue;
        }
        const articleNode = flattenLdNodes(data).find(isArticleTypeNode);
        if (!articleNode) continue;
        if (!result.datePublished && typeof articleNode.datePublished === 'string') {
            result.datePublished = articleNode.datePublished.trim();
        }
        if (!result.dateModified && typeof articleNode.dateModified === 'string') {
            result.dateModified = articleNode.dateModified.trim();
        }
        if (!result.description && typeof articleNode.description === 'string') {
            result.description = articleNode.description.trim();
        }
        if (result.datePublished && result.dateModified && result.description) break;
    }
    return result;
}

// __NEXT_DATA__ 里日期键名优先级(同层多个命中时按此顺序取)
const NEXT_DATA_DATE_KEYS = ['publishedAt', 'published_at', 'datePublished', 'createdAt', 'date'];
const MAX_DEPTH = 6;

// 值形似日期:Date.parse 能解 + 年份落在 2015-2030(防 1970 epoch 占位垃圾值 / 非日期字符串误命中)
function looksLikeDate(v: unknown): v is string {
    if (typeof v !== 'string' || !v.trim()) return false;
    const t = Date.parse(v);
    if (Number.isNaN(t)) return false;
    const year = new Date(t).getUTCFullYear();
    return year >= 2015 && year <= 2030;
}

function findDateInTree(node: unknown, depth: number): string {
    if (node === null || typeof node !== 'object') return '';
    if (!Array.isArray(node)) {
        for (const key of NEXT_DATA_DATE_KEYS) {
            const v = (node as Record<string, unknown>)[key];
            if (looksLikeDate(v)) return v;
        }
    }
    if (depth >= MAX_DEPTH) return ''; // 深度限 6 层 · 到顶不再往下钻
    const children = Array.isArray(node) ? node : Object.values(node as Record<string, unknown>);
    for (const child of children) {
        const found = findDateInTree(child, depth + 1);
        if (found) return found;
    }
    return '';
}

// Next.js 站 __NEXT_DATA__ JSON 里递归找发布时间(props.pageProps... 具体路径各站不同 · 按键名找更稳)
// 找到第一个"像日期"的值就停 · 无信号 / 坏 JSON 都返回空串(不抛错)
export function extractNextDataDate($: CheerioAPI): string {
    const txt = $('script#__NEXT_DATA__').first().text();
    if (!txt || !txt.trim()) return '';
    try {
        const data = JSON.parse(txt);
        return findDateInTree(data, 1);
    } catch {
        return '';
    }
}

// 🆕 2026-07-03 老板拍:og:title 站级复读误报维度(如 BCH 59 篇全叫 "Bitcoin Cash Node")
// h1 原始值单独抽出(不做任何判定/不进 title 梯队覆盖)· 聚合层用同源 title 重复度决定要不要切换用它
export function extractH1($: CheerioAPI): string {
    return $('h1').first().text().trim();
}

// 🆕 2026-07-03 自测战役 B3:正文可见日期兜底(37 源实锤:byline 日期只在正文文本 · meta/jsonld 全空)
// 复审收紧(RESOLV/USAT 误锚事件日期实锤):byline 上下文优先 · 无 byline 时仅接受"前 600 字内唯一日期"
// 格式:'May 25, 2026'(月名首字母大写 · 允许前词粘连 'TitleMay 25')/ '25 May 2026' / '2026-07-01' / 'MM/DD/YYYY'
const MONTH_NAME = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*';
const VISIBLE_DATE_RES = [
    new RegExp(`${MONTH_NAME}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+(?:19|20)\\d{2}\\b`, 'g'),
    new RegExp(`(?<![a-zA-Z0-9])\\d{1,2}(?:st|nd|rd|th)?\\.?\\s+${MONTH_NAME}\\.?,?\\s+(?:19|20)\\d{2}\\b`, 'g'),
    /(?<!\d)(?:19|20)\d{2}[-./]\d{1,2}[-./]\d{1,2}\b/g, // 允许字母粘连('Announcements2025-07-01')· 禁数字粘连
    /\b(?:0?[1-9]|1[0-2])\/(?:0?[1-9]|[12]\d|3[01])\/(?:19|20)\d{2}\b/g, // 美式 MM/DD/YYYY(复审实锤)
];
const BYLINE_RE = /(?:published|posted|updated|written|released)\b/i;

function parseVisibleDate(raw: string): number {
    const cleaned = raw.replace(/(\d)(?:st|nd|rd|th)/i, '$1');
    // 无时区的裸日期按 UTC 解(否则服务器 UTC+8 下 toISOString 回退一天)
    const ymd = /^((?:19|20)\d{2})[-./](\d{1,2})[-./](\d{1,2})$/.exec(cleaned);
    if (ymd) {
        const mo = Number(ymd[2]);
        const day = Number(ymd[3]);
        if (mo < 1 || mo > 12 || day < 1 || day > 31) return NaN;
        return Date.UTC(Number(ymd[1]), mo - 1, day);
    }
    const mdy = /^(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/((?:19|20)\d{2})$/.exec(cleaned);
    if (mdy) return Date.UTC(Number(mdy[3]), Number(mdy[1]) - 1, Number(mdy[2]));
    return Date.parse(`${cleaned} 00:00:00 UTC`);
}

export function extractVisibleDate($: CheerioAPI): string {
    // 不用 .text():cheerio 块级元素间文本粘连(<h1>T</h1><span>May…</span> → 'TMay…')破坏词边界
    // 改剥标签为空格 · 先剥 script/style(内嵌 JSON 的时间戳会污染)
    const container = ['article', 'main', 'body']
        .map((sel) => $(sel).first())
        .find((el) => el.length > 0 && (el.html() ?? '').trim().length > 0);
    const rawHtml = (container?.html() ?? '').slice(0, 12000);
    const text = rawHtml
        .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .slice(0, 2000);
    // 收集全部候选(位置 + 解析值)
    const found: { iso: string; idx: number; day: string }[] = [];
    for (const re of VISIBLE_DATE_RES) {
        re.lastIndex = 0;
        for (let m = re.exec(text); m; m = re.exec(text)) {
            const t = parseVisibleDate(m[0]);
            if (!Number.isNaN(t)) {
                const year = new Date(t).getUTCFullYear();
                if (year >= 2015 && year <= 2030) {
                    const iso = new Date(t).toISOString();
                    found.push({ iso, idx: m.index, day: iso.slice(0, 10) });
                }
            }
        }
    }
    if (found.length === 0) return '';
    found.sort((a, b) => a.idx - b.idx);
    // 1. byline 上下文优先:日期前 40 字符窗口含 published/posted/updated 等词
    for (const f of found) {
        if (BYLINE_RE.test(text.slice(Math.max(0, f.idx - 40), f.idx))) return f.iso;
    }
    // 2. 无 byline:前 600 字内且全文只有一个"天"(多个不同日期 = 歧义 · 宁缺勿错)
    const uniqueDays = new Set(found.map((f) => f.day));
    if (uniqueDays.size === 1 && found[0].idx < 600) return found[0].iso;
    return '';
}

// ── 发布时间抽取主入口(2026-07-04 老板拍:通用梯队 + per-source 规则)──
// 从 article.ts 内联梯队搬入 · 保持原层序:meta → time 标签 → jsonld → __NEXT_DATA__ → itemprop 元素 → 可见日期 → URL 日期
export function extractPublishedAt($: CheerioAPI, url: string, ruleOverride?: DateRule | null): string {
    const rule = ruleOverride !== undefined ? ruleOverride : dateRuleFor(url);
    if (rule?.strategy === 'none' || rule?.strategy === 'spa_only') return ''; // 显式放弃 · 不瞎抽(spa_only 等 P3 Playwright)
    if (rule?.strategy === 'url_date') return extractDateFromUrl(url);
    if (rule?.selector) {
        const el = $(rule.selector).first();
        let v = rule.attr && rule.attr !== 'text' ? (el.attr(rule.attr)?.trim() ?? '') : el.text().trim();
        if (v && rule.regex) {
            const m = new RegExp(rule.regex, 'i').exec(v);
            v = m ? (m[1] ?? m[0]) : '';
        }
        if (v) return v;
        // selector 落空(改版等)→ 走下方通用梯队(仍受 ban 约束)
    }
    const ban = new Set(rule?.ban ?? []);
    if (!ban.has('meta')) {
        const v = $('meta[property="article:published_time"]').attr('content')?.trim()
            || $('meta[property="article:modified_time"]').attr('content')?.trim()
            || $('meta[itemprop="datePublished"]').attr('content')?.trim()
            || $('meta[itemprop="dateModified"]').attr('content')?.trim();
        if (v) return v;
    }
    if (!ban.has('time_tag')) {
        const v = $('time[datetime]').first().attr('datetime')?.trim()
            || $('time[datepublished]').first().attr('datepublished')?.trim()
            || $('time[pubdate]').first().attr('datetime')?.trim();
        if (v) return v;
    }
    if (!ban.has('meta')) {
        const v = $('meta[name="date"]').attr('content')?.trim()
            || $('meta[name="publish_date"]').attr('content')?.trim()
            || $('meta[name="pubdate"]').attr('content')?.trim();
        if (v) return v;
    }
    if (!ban.has('jsonld')) {
        const v = extractJsonLdMeta($).datePublished;
        if (v) return v;
    }
    if (!ban.has('nextdata')) {
        const v = extractNextDataDate($);
        if (v) return v;
    }
    const ip = $('[itemprop="datePublished"]').first();
    const ipv = ip.attr('datetime')?.trim() || ip.attr('content')?.trim() || ip.text().trim();
    if (ipv) return ipv;
    return extractVisibleDate($) || extractDateFromUrl(url) || '';
}
