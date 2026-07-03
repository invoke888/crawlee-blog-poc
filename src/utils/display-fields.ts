// 🆕 2026-07-03 e 项(老板拍):聚合/推送层 title/desc 智能切换 · 单一语义源
// 问题(自测战役实锤):article-detail 源 og:title 站级复读(BCH 59 篇全叫 "Bitcoin Cash Node")·
// og:description 站级 slogan(~17 源如 Ripple/SCRT)— 真标题在 h1 · 真摘要在 jsonld_description(抓取层已双存)
// 语义(python scripts/aggregate-report.py 复刻同逻辑 · 改这里必同步那边):
//   title:①同源 ≥3 条且众数 title 占比 ≥80% 且 h1 有值且 h1 不复读 → 用 h1
//         ②单条/少条:title 归一后与 host 注册名归一相等(bitcoincashnode.org ↔ "Bitcoin Cash Node")→ 用 h1
//   desc:同源 ≥3 条且众数 desc(前 100 字)占比 ≥80% → 用 jsonld_description(≥30 字且 ≠title)· 无则原值 + generic 标记
// 原始字段永远保留在 dataset · 本切换只作用展示/推送层

export interface DisplayFieldItem {
    title?: string;
    h1?: string;
    description?: string;
    jsonld_description?: string;
    source_url?: string;
}

export interface DisplayFields {
    display_title: string;
    display_desc: string;
    desc_generic: boolean;
}

const REPEAT_RATIO = 0.8;
const MIN_GROUP = 3;

function norm(s: string | undefined): string {
    return (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// host 注册名:去 www/blog/news/info 前缀 · 取主域名部分(bitcoincashnode.org → bitcoincashnode)
function hostName(url: string | undefined): string {
    try {
        const h = new URL(url ?? '').hostname.toLowerCase().replace(/^(www|blog|news|info)\./, '');
        return h.split('.')[0] ?? '';
    } catch {
        return '';
    }
}

function modeRatio(values: string[]): { value: string; ratio: number } {
    const counts = new Map<string, number>();
    for (const v of values) {
        if (!v) continue;
        counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    let best = '';
    let bestN = 0;
    for (const [v, n] of counts) {
        if (n > bestN) {
            best = v;
            bestN = n;
        }
    }
    return { value: best, ratio: values.length ? bestN / values.length : 0 };
}

export function computeDisplayFields<T extends DisplayFieldItem>(articles: T[]): (T & DisplayFields)[] {
    const n = articles.length;
    const titleMode = modeRatio(articles.map((a) => norm(a.title)));
    const titleRepeats = n >= MIN_GROUP && titleMode.ratio >= REPEAT_RATIO && !!titleMode.value;
    const h1Mode = modeRatio(articles.map((a) => norm(a.h1)));
    const h1AlsoRepeats = n >= MIN_GROUP && h1Mode.ratio >= REPEAT_RATIO && !!h1Mode.value;
    const descMode = modeRatio(articles.map((a) => norm(a.description).slice(0, 100)));
    const descRepeats = n >= MIN_GROUP && descMode.ratio >= REPEAT_RATIO && !!descMode.value;

    return articles.map((a) => {
        const tNorm = norm(a.title);
        const h1Ok = !!a.h1?.trim() && norm(a.h1) !== tNorm;
        // title 切换:群体复读 or 单条站名信号(title 归一 == host 注册名)
        const isSiteName = !!tNorm && tNorm === norm(hostName(a.source_url));
        const groupHit = titleRepeats && tNorm === titleMode.value && !h1AlsoRepeats;
        const display_title = (groupHit || isSiteName) && h1Ok ? a.h1!.trim() : (a.title ?? '');

        // desc 切换:群体复读 → jsonld(合格)· 无 → 原值 + generic 标记
        let display_desc = a.description ?? '';
        let desc_generic = false;
        if (descRepeats && norm(a.description).slice(0, 100) === descMode.value) {
            const jd = (a.jsonld_description ?? '').trim();
            if (jd && jd.length >= 30 && norm(jd) !== tNorm && norm(jd).slice(0, 100) !== descMode.value) {
                display_desc = jd;
            } else {
                desc_generic = true;
            }
        }
        return { ...a, display_title, display_desc, desc_generic };
    });
}
