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
