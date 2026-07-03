// 🆕 2026-07-03 per-source 文章 URL 规则(17 agent 审计 205 嫌疑源产出)
// 语义:
//   - 只有 confidence=high 的规则强制过滤(防误杀 · mid/low 仅供报告标注)
//   - exclude_prefixes 先判(语言变体/子栏目 · 命中即拒)
//   - include_prefixes 段级前缀匹配(/blog/ 匹配 /blog/x 与 /blog · 不匹配 /blog-posts)
//   - include_regex 正则型(WordPress 日期 permalink 等)
//   - 无规则的源 → 放行(走全局 isLikelyArticleUrl)
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const data = require('./source-rules.json') as {
    rules: Record<string, {
        confidence: 'high' | 'mid' | 'low';
        include_prefixes?: string[];
        include_regex?: string;
        exclude_prefixes?: string[];
        mode?: 'sitemap-only';
        post_sitemap?: string;
    }>;
};

// 🆕 P2#3 sitemap-only 源(真假 URL 同形 · 用站方 post-sitemap.xml 白名单)
export function getSitemapOnly(sym: string): string | null {
    const r = data.rules[sym];
    return r?.mode === 'sitemap-only' && r.post_sitemap ? r.post_sitemap : null;
}

const regexCache = new Map<string, RegExp | null>();
function getRegex(pattern: string): RegExp | null {
    if (!regexCache.has(pattern)) {
        try {
            regexCache.set(pattern, new RegExp(pattern));
        } catch {
            regexCache.set(pattern, null);
        }
    }
    return regexCache.get(pattern) ?? null;
}

// 段级前缀:/blog/ 匹配 pathname /blog 或 /blog/...(不匹配 /blog-posts · STORJ 教训)
function prefixMatches(pathname: string, prefix: string): boolean {
    const p = pathname.endsWith('/') ? pathname : `${pathname}/`;
    return p === prefix || p.startsWith(prefix);
}

// 判定 URL 是否符合该源的文章规则 · 返回 'pass' | 'reject' | 'no-rule'
export function checkSourceRule(sym: string, url: string): 'pass' | 'reject' | 'no-rule' {
    const rule = data.rules[sym];
    if (!rule) return 'no-rule';
    let pathname: string;
    try {
        pathname = new URL(url).pathname.toLowerCase();
    } catch {
        return 'reject';
    }
    if (rule.exclude_prefixes?.some((ex) => prefixMatches(pathname, ex.toLowerCase()))) {
        return 'reject';
    }
    // 只有 high 强制 include 判定
    if (rule.confidence !== 'high') return 'no-rule';
    const hasPrefix = !!rule.include_prefixes?.length;
    const hasRegex = !!rule.include_regex;
    if (!hasPrefix && !hasRegex) return 'no-rule';
    if (hasPrefix && rule.include_prefixes!.some((pre) => prefixMatches(pathname, pre.toLowerCase()))) return 'pass';
    if (hasRegex) {
        const re = getRegex(rule.include_regex!);
        if (re?.test(pathname)) return 'pass';
    }
    return 'reject';
}

// 多 token 共用 URL 时:任一 token 规则 pass 即放行;全部 reject 才拒;有 no-rule 放行
export function checkSourceRuleMulti(syms: string[], url: string): boolean {
    let sawReject = false;
    for (const sym of syms) {
        const r = checkSourceRule(sym, url);
        if (r === 'pass' || r === 'no-rule') return true;
        sawReject = true;
    }
    return !sawReject;
}
