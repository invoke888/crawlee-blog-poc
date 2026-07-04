// 🆕 2026-07-04 push 模块(计划书 §7 · 老板拍:push 归运维台 · 失败可面板手动重试)
// 数据源 = articles 表 push_status='none' · 铁律:①同 url 多 token 合并一条(token_id list)
// ②首次接通存量不推(skipped_backlog 回填)③回写 WHERE url=?(姊妹行一致)
import { db } from '../shared/db.js';
import { cfgBool, cfgStr, cfgNum } from '../shared/config.js';
import { isNoiseUrl, isNonArticleFile, filterArticlesWhitelistFirst } from '../src/utils/article-filter.js';

interface PendingArticle {
    url: string; token_id: number; base_symbol: string;
    title: string; description: string; published_at: string; crawled_at: string;
    push_retries: number;
}

const now = () => new Date().toISOString();

// push 开关首次打开时的一次性存量回填(push_enabled_at 记在 app_config)
export function backfillOnFirstEnable(): number {
    const d = db();
    const enabledAt = d.prepare(`SELECT value FROM app_config WHERE key = 'push_enabled_at'`).get() as { value?: string } | undefined;
    if (enabledAt?.value) return 0; // 已回填过
    const ts = now();
    d.prepare(`INSERT OR REPLACE INTO app_config (key, value, value_type, category, label, updated_at)
               VALUES ('push_enabled_at', ?, 'string', 'push', 'push 首次接通时刻(存量边界)', ?)`).run(ts, ts);
    const r = d.prepare(`UPDATE articles SET push_status = 'skipped_backlog' WHERE push_status = 'none' AND crawled_at < ?`).run(ts);
    console.log(`📦 push 首次接通:存量 ${r.changes} 篇标 skipped_backlog(铁律:不推)`);
    return r.changes;
}

function markByUrl(url: string, status: string, error?: string): void {
    db().prepare(`UPDATE articles SET push_status = ?, pushed_at = ?, push_error = ?, push_retries = push_retries + ? WHERE url = ?`)
        .run(status, status === 'pushed' ? now() : null, error ?? null, status === 'failed' ? 1 : 0, url);
}

async function pushOne(apiUrl: string, secret: string, payload: Record<string, unknown>, dry: boolean): Promise<{ ok: boolean; error?: string }> {
    if (dry) { console.log(`   [dry] token_ids=${JSON.stringify(payload.token_ids)} ${String(payload.title).slice(0, 50)}`); return { ok: true }; }
    try {
        const res = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${secret}` },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 120)}` };
        return { ok: true };
    } catch (e) {
        return { ok: false, error: ((e as Error).message ?? String(e)).slice(0, 200) };
    }
}

// runId=null 时为手动重推(面板按钮)· urls 限定范围
export async function runPusher(runId: string | null, opts?: { retryUrls?: string[]; dryOverride?: boolean }): Promise<{ pushed: number; ok: number; failed: number; skipped: number }> {
    const result = { pushed: 0, ok: 0, failed: 0, skipped: 0 };
    const enabled = cfgBool('push_enabled');
    const dry = opts?.dryOverride ?? !enabled;
    if (!enabled && !opts?.retryUrls && !opts?.dryOverride) return result; // 未接通且非手动 → 静默跳过

    if (enabled) backfillOnFirstEnable();

    const apiUrl = cfgStr('push_api_url');
    const secret = cfgStr('push_api_secret');
    if (enabled && (!apiUrl || !secret)) {
        console.warn('⚠️ push_enabled 但 URL/SECRET 未配 · 本轮跳过');
        return result;
    }

    const d = db();
    const retryMax = cfgNum('push_retry_max', 3);
    let rows: PendingArticle[];
    if (opts?.retryUrls?.length) {
        const qs = opts.retryUrls.map(() => '?').join(',');
        rows = d.prepare(`SELECT url, token_id, base_symbol, title, description, published_at, crawled_at, push_retries FROM articles WHERE url IN (${qs})`).all(...opts.retryUrls) as PendingArticle[];
    } else {
        rows = d.prepare(`SELECT url, token_id, base_symbol, title, description, published_at, crawled_at, push_retries FROM articles
                          WHERE (push_status = 'none') OR (push_status = 'failed' AND push_retries < ?)`).all(retryMax) as PendingArticle[];
    }

    // 数据级过滤(与聚合同语义):noise/文件型不推
    rows = rows.filter((r) => r.title && !isNoiseUrl(r.url) && !isNonArticleFile(r.url));
    // 白名单优先(按 token 分组语义复用)
    const byToken = new Map<number, PendingArticle[]>();
    for (const r of rows) { const a = byToken.get(r.token_id) ?? []; a.push(r); byToken.set(r.token_id, a); }
    const passed: PendingArticle[] = [];
    for (const arr of byToken.values()) passed.push(...filterArticlesWhitelistFirst(arr));

    // 🔴 合并:同 url 多 token 一条推送(token_ids list)
    const byUrl = new Map<string, PendingArticle[]>();
    for (const r of passed) { const a = byUrl.get(r.url) ?? []; a.push(r); byUrl.set(r.url, a); }

    for (const [url, group] of byUrl) {
        const first = group[0];
        result.pushed += 1;
        const { ok, error } = await pushOne(apiUrl || '(dry)', secret, {
            token_ids: group.map((g) => g.token_id),
            base_symbols: group.map((g) => g.base_symbol),
            post_url: url,
            title: first.title,
            content: first.description ?? '',
            published_at: first.published_at || undefined,
            fetched_at: first.crawled_at || now(),
        }, dry);
        if (dry) { result.skipped += 1; continue; } // dry 不回写状态
        if (ok) { result.ok += 1; markByUrl(url, 'pushed'); }
        else { result.failed += 1; markByUrl(url, 'failed', error); }
    }

    if (runId) {
        try {
            d.prepare(`INSERT OR REPLACE INTO push_runs (run_id, pushed, ok, failed, skipped, detail) VALUES (?, ?, ?, ?, ?, ?)`)
                .run(runId, result.pushed, result.ok, result.failed, result.skipped, dry ? 'dry' : '');
        } catch (e) { console.error('⚠️ push_runs 记账失败:', (e as Error).message); }
    }
    if (result.pushed > 0) console.log(`📤 push${dry ? '(dry)' : ''}:${result.pushed} 条 · ok ${result.ok} · fail ${result.failed}`);
    return result;
}
