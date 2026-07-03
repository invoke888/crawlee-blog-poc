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

type CheerioAPI = CheerioCrawlingContext['$'];

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
// 只在整个 published 梯队全空时触发 · 只扫正文容器前 2000 字(页脚版权年在尾部不会命中)
// 'May 25, 2026' / 'May 25th, 2026' / '25 May 2026' / '2026-07-01' / '2026.10.28' 等
const MONTH_NAME = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*';
const VISIBLE_DATE_RES = [
    new RegExp(`\\b${MONTH_NAME}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+(?:19|20)\\d{2}\\b`, 'i'),
    new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\.?\\s+${MONTH_NAME}\\.?,?\\s+(?:19|20)\\d{2}\\b`, 'i'),
    /\b(?:19|20)\d{2}[-./]\d{1,2}[-./]\d{1,2}\b/,
];

export function extractVisibleDate($: CheerioAPI): string {
    // 不用 .text():cheerio 块级元素间文本粘连(<h1>T</h1><span>May…</span> → 'TMay…')破坏 \b 边界
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
    for (const re of VISIBLE_DATE_RES) {
        const m = re.exec(text);
        if (!m) continue;
        const cleaned = m[0].replace(/(\d)(?:st|nd|rd|th)/i, '$1');
        // 无时区的裸日期按 UTC 解(否则服务器 UTC+8 下 toISOString 回退一天)
        const numeric = /^((?:19|20)\d{2})[-./](\d{1,2})[-./](\d{1,2})$/.exec(cleaned);
        if (numeric) {
            const mo = Number(numeric[2]);
            const day = Number(numeric[3]);
            if (mo < 1 || mo > 12 || day < 1 || day > 31) continue;
        }
        const t = numeric
            ? Date.UTC(Number(numeric[1]), Number(numeric[2]) - 1, Number(numeric[3]))
            : Date.parse(`${cleaned} 00:00:00 UTC`);
        if (Number.isNaN(t)) continue;
        const year = new Date(t).getUTCFullYear();
        if (year >= 2015 && year <= 2030) return new Date(t).toISOString();
    }
    return '';
}
