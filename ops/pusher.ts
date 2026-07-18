// 🆕 2026-07-04 push 模块 · 2026-07-06 对接 officialblog API(HMAC 签名 · camelCase 批量 items)
// 数据源 = articles 表 push_status='none' · 铁律:①同 url 多 token 合并一条(tokenIds list)
// ②首次接通存量不推(skipped_backlog 回填)③回写 WHERE url=?(姊妹行一致)④append-only 无去重 → 严格靠 push_status 只推一次
import { createHmac, createHash, randomUUID } from 'node:crypto';
import { db } from '../shared/db.js';
import { cfgBool, cfgStr, cfgNum } from '../shared/config.js';
import { isNoiseUrl, isNonArticleFile, filterArticlesWhitelistFirst, normalizedHostOfUrl } from '../src/utils/article-filter.js';

const INGEST_PATH = '/api/officialblog/messages/ingest';

interface PendingArticle {
    url: string; token_id: number; base_symbol: string;
    title: string; description: string; body_excerpt: string; published_at: string; crawled_at: string;
    push_retries: number;
}

const now = () => new Date().toISOString();

// ── HMAC-SHA256 签名(文档 §0.2)· canonical = METHOD\nPATH\ncanonicalQuery\nsha256Hex(body)\ntimestamp\nnonce ──
export function signHeaders(
    method: string, path: string, canonicalQuery: string, bodyStr: string,
    apiKey: string, secret: string, timestamp: string, nonce: string,
): Record<string, string> {
    const bodyHash = createHash('sha256').update(bodyStr, 'utf8').digest('hex');
    const canonical = [method.toUpperCase(), path, canonicalQuery, bodyHash, timestamp, nonce].join('\n');
    const signature = createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
    return {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
        'X-Timestamp': timestamp,
        'X-Nonce': nonce,
        'X-Signature': signature,
    };
}

// articles 行 → API item(camelCase · 老板拍 username=host · 发布时间/正文空也发)
export function toIngestItem(url: string, group: PendingArticle[]): Record<string, unknown> {
    const first = group[0];
    const host = normalizedHostOfUrl(url);
    const blogId = url.length <= 256 ? url : createHash('sha1').update(url).digest('hex');
    return {
        blogId,
        username: host,                                              // 老板拍:用博客 host
        displayName: first.base_symbol || host,
        source: host,
        title: first.title,
        content: first.body_excerpt || first.description || '',      // 真正文优先 · 空也发(老板:非必须)
        url,
        tokenIds: [...new Set(group.map((g) => g.token_id))],        // 同 url 多 token 合并
        publishedAt: first.published_at || '',                       // 空也发(老板:文档标必须是错的)
        collectedAt: first.crawled_at || now(),
    };
}

interface IngestResult { accepted: number; rejected: number; rejections: { index: number; reason: string }[] }

async function ingestBatch(baseUrl: string, apiKey: string, secret: string, items: Record<string, unknown>[], dry: boolean): Promise<IngestResult> {
    const bodyStr = JSON.stringify({ items });
    if (dry) {
        console.log(`   [dry] batch ${items.length} 条 · 首条 tokenIds=${JSON.stringify(items[0]?.tokenIds)} "${String(items[0]?.title).slice(0, 50)}"`);
        return { accepted: items.length, rejected: 0, rejections: [] };
    }
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = randomUUID();
    const headers = signHeaders('POST', INGEST_PATH, '', bodyStr, apiKey, secret, ts, nonce);
    const res = await fetch(baseUrl.replace(/\/$/, '') + INGEST_PATH, {
        method: 'POST', headers, body: bodyStr, signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    const json = JSON.parse(text) as { code: number; message?: string; data?: IngestResult };
    if (json.code !== 0) throw new Error(`API code=${json.code}: ${json.message ?? ''}`);
    return json.data ?? { accepted: 0, rejected: 0, rejections: [] };
}

// detail:真推时的该文 item JSON + 单文结果(2026-07-18 老板拍 · 面板弹窗查看)· 无 detail 的调用不动已存记录
export function markByUrl(url: string, status: string, error?: string, detail?: { request: string; response: string }): void {
    db().prepare(`UPDATE articles SET push_status = ?, pushed_at = ?, push_error = ?, push_retries = push_retries + ?,
                  push_request = COALESCE(?, push_request), push_response = COALESCE(?, push_response) WHERE url = ?`)
        .run(status, status === 'pushed' ? now() : null, error ?? null, status === 'failed' ? 1 : 0,
            detail?.request ?? null, detail?.response ?? null, url);
}

// push 开关首次打开时的一次性存量回填(push_enabled_at 记在 app_config)
export function backfillOnFirstEnable(): number {
    const d = db();
    const enabledAt = d.prepare(`SELECT value FROM app_config WHERE key = 'push_enabled_at'`).get() as { value?: string } | undefined;
    if (enabledAt?.value) return 0;
    const ts = now();
    d.prepare(`INSERT OR REPLACE INTO app_config (key, value, value_type, category, label, updated_at)
               VALUES ('push_enabled_at', ?, 'string', 'push', 'push 首次接通时刻(存量边界)', ?)`).run(ts, ts);
    const r = d.prepare(`UPDATE articles SET push_status = 'skipped_backlog' WHERE push_status = 'none' AND crawled_at < ?`).run(ts);
    console.log(`📦 push 首次接通:存量 ${r.changes} 篇标 skipped_backlog(铁律:不推)`);
    return r.changes;
}

// 🆕 2026-07-13 新文守门(老板拍:确保以后推的是新文 · 滚动 7 天)
// 背景:运输带切换后旧 queue"发现过但未入库"记忆蒸发 → 老文当新文涌入(crawled_at 全新)骗过 backlog 边界 → ECB 2021-2023 文误推实锤
// 语义:发布超窗口的迟到首采,推送出口标 skipped_backlog(入库照常 · 库保持全量 · 面板手动推按钮不受影响)
// pub 空的放行(spa 源新文无字段 · 按 crawled_at 现行为);只动 none(failed 重试/已推不碰)
export const FRESH_WINDOW_DAYS = 7;

export function skipStaleBeforePush(nowIso?: string): number {
    const cutoff = new Date(new Date(nowIso ?? now()).getTime() - FRESH_WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
    const r = db().prepare(`UPDATE articles SET push_status = 'skipped_backlog'
                            WHERE push_status = 'none' AND published_at IS NOT NULL AND published_at != '' AND published_at < ?`).run(cutoff);
    return r.changes;
}

// runId=null 时为手动重推(面板按钮)· opts.retryUrls 限定范围 · opts.limit 测试推 N 篇 · dryOverride 强制演练
export async function runPusher(runId: string | null, opts?: { retryUrls?: string[]; dryOverride?: boolean; limit?: number }): Promise<{ pushed: number; ok: number; failed: number; skipped: number; rejected: number }> {
    const result = { pushed: 0, ok: 0, failed: 0, skipped: 0, rejected: 0 };
    const enabled = cfgBool('push_enabled');
    const dry = opts?.dryOverride ?? !enabled;
    if (!enabled && !opts?.retryUrls && !opts?.dryOverride) return result; // 未接通且非手动 → 静默跳过

    if (enabled && !opts?.retryUrls) backfillOnFirstEnable();
    if (!opts?.retryUrls) skipStaleBeforePush(); // 新文守门:自动推路径先拦超窗口老文(手动重推豁免)

    const baseUrl = cfgStr('push_api_url');
    const apiKey = cfgStr('push_api_key');
    const secret = cfgStr('push_api_secret');
    if (!dry && (!baseUrl || !apiKey || !secret)) {
        console.warn('⚠️ push_enabled 但 URL/KEY/SECRET 未配齐 · 本轮跳过');
        return result;
    }

    const d = db();
    const retryMax = cfgNum('push_retry_max', 3);
    let rows: PendingArticle[];
    if (opts?.retryUrls?.length) {
        const qs = opts.retryUrls.map(() => '?').join(',');
        rows = d.prepare(`SELECT url, token_id, base_symbol, title, description, body_excerpt, published_at, crawled_at, push_retries FROM articles WHERE url IN (${qs})`).all(...opts.retryUrls) as PendingArticle[];
    } else {
        rows = d.prepare(`SELECT url, token_id, base_symbol, title, description, body_excerpt, published_at, crawled_at, push_retries FROM articles
                          WHERE (push_status = 'none') OR (push_status = 'failed' AND push_retries < ?)`).all(retryMax) as PendingArticle[];
    }

    // 数据级过滤(与聚合/收割同语义):noise/文件型不推 · title 必须(API 必填)
    rows = rows.filter((r) => r.title && !isNoiseUrl(r.url) && !isNonArticleFile(r.url));
    // 白名单优先(host 级口径复用)
    rows = filterArticlesWhitelistFirst(rows);

    // 🔴 合并:同 url 多 token 一条 item(tokenIds list)
    const byUrl = new Map<string, PendingArticle[]>();
    for (const r of rows) { const a = byUrl.get(r.url) ?? []; a.push(r); byUrl.set(r.url, a); }
    let entries = [...byUrl.entries()];
    if (opts?.limit && opts.limit > 0) entries = entries.slice(0, opts.limit); // 测试:只推前 N 条

    // 分批(≤200)· item index → url 映射用于回写
    const batchSize = Math.min(cfgNum('push_batch_size', 200), 200);
    for (let i = 0; i < entries.length; i += batchSize) {
        const slice = entries.slice(i, i + batchSize);
        const items = slice.map(([url, group]) => toIngestItem(url, group));
        result.pushed += slice.length;
        try {
            const r = await ingestBatch(baseUrl || '(dry)', apiKey, secret, items, dry);
            if (dry) { result.skipped += slice.length; continue; }
            const rejectedIdx = new Map(r.rejections.map((x) => [x.index, x.reason]));
            slice.forEach(([url], idx) => {
                const detail = (res: object) => ({ request: JSON.stringify(items[idx]), response: JSON.stringify({ ...res, batch_size: slice.length, at: now() }) });
                if (rejectedIdx.has(idx)) { result.rejected += 1; markByUrl(url, 'failed', `rejected:${rejectedIdx.get(idx)}`, detail({ result: 'rejected', reason: rejectedIdx.get(idx) })); }
                else { result.ok += 1; markByUrl(url, 'pushed', undefined, detail({ result: 'accepted' })); }
            });
        } catch (e) {
            const err = ((e as Error).message ?? String(e)).slice(0, 200);
            if (!dry) {
                result.failed += slice.length;
                slice.forEach(([url], idx) => markByUrl(url, 'failed', err,
                    { request: JSON.stringify(items[idx]), response: JSON.stringify({ result: 'error', error: err, batch_size: slice.length, at: now() }) }));
            }
            console.error(`⚠️ push batch 失败(${i}~):${err}`);
        }
    }

    if (runId) {
        try {
            d.prepare(`INSERT OR REPLACE INTO push_runs (run_id, pushed, ok, failed, skipped, detail) VALUES (?, ?, ?, ?, ?, ?)`)
                .run(runId, result.pushed, result.ok, result.failed + result.rejected, result.skipped, dry ? 'dry' : '');
        } catch (e) { console.error('⚠️ push_runs 记账失败:', (e as Error).message); }
    }
    if (result.pushed > 0) console.log(`📤 push${dry ? '(dry)' : ''}:${result.pushed} 条 · ok ${result.ok} · 拒 ${result.rejected} · 失败 ${result.failed}`);
    return result;
}
