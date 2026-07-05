// 🆕 2026-07-04 账本读写(计划书 §3/§4)
// 铁律:①flushRun 是采集器唯一落库入口(RUN_ID 网关统一 · 防散落 if 漏改)
//      ②全部写入 try/catch 失败隔离 · 绝不上抛 — 记账故障不许拖垮采集(审计 A1-P0-4)
//      ③articles UPSERT 禁整行覆盖(COALESCE 教训):first_run_id/crawled_at/push_* 不进 SET
import { db, type SourceRow } from './db.js';
import type { SourceStat } from './run-stats.js';
import type { CrawlErrorRow, AlertRow, RunStatus } from './types.js';

const now = () => new Date().toISOString();

// ───────── 采集器侧唯一入口 ─────────

export function flushRun(snapshot: { sources: SourceStat[]; errors: CrawlErrorRow[]; requestsTotal: number; requestsFailed: number }): void {
    const runId = process.env.RUN_ID;
    if (!runId) return; // 裸跑不记账(拍板行为 · 网关唯一判断点)
    try {
        const d = db();
        const insStat = d.prepare(`
            INSERT INTO source_runs (run_id, token_id, base_symbol, crawler, items_added, requests, failed,
                http_403, http_404, http_429, timeout, proxy_error,
                blocked_noise, blocked_external, blocked_error_page, list_candidates, feed_items)
            VALUES (@run_id, @token_id, @base_symbol, @crawler, @items_added, @requests, @failed,
                @http_403, @http_404, @http_429, @timeout, @proxy_error,
                @blocked_noise, @blocked_external, @blocked_error_page, @list_candidates, @feed_items)
            ON CONFLICT(run_id, token_id) DO UPDATE SET
                items_added = excluded.items_added, requests = excluded.requests, failed = excluded.failed,
                http_403 = excluded.http_403, http_404 = excluded.http_404, http_429 = excluded.http_429,
                timeout = excluded.timeout, proxy_error = excluded.proxy_error,
                blocked_noise = excluded.blocked_noise, blocked_external = excluded.blocked_external,
                blocked_error_page = excluded.blocked_error_page,
                list_candidates = excluded.list_candidates, feed_items = excluded.feed_items
        `);
        const insErr = d.prepare(`
            INSERT INTO crawl_errors (run_id, token_id, base_symbol, url, kind, http_status, retry_after_s, error_code, message, retries, at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const tx = d.transaction(() => {
            for (const s of snapshot.sources) {
                insStat.run({
                    run_id: runId, token_id: s.token_id, base_symbol: s.base_symbol, crawler: s.crawler,
                    items_added: s.counts.items_added ?? 0, requests: s.counts.requests ?? 0, failed: s.counts.failed ?? 0,
                    http_403: s.counts.http_403 ?? 0, http_404: s.counts.http_404 ?? 0, http_429: s.counts.http_429 ?? 0,
                    timeout: s.counts.timeout ?? 0, proxy_error: s.counts.proxy_error ?? 0,
                    blocked_noise: s.counts.blocked_noise ?? 0, blocked_external: s.counts.blocked_external ?? 0,
                    blocked_error_page: s.counts.blocked_error_page ?? 0,
                    list_candidates: s.counts.list_candidates ?? null, feed_items: s.counts.feed_items ?? null,
                });
            }
            for (const e of snapshot.errors) {
                insErr.run(runId, e.token_id ?? null, e.base_symbol ?? null, e.url ?? null, e.kind,
                    e.http_status ?? null, e.retry_after_s ?? null, e.error_code ?? null,
                    (e.message ?? '').slice(0, 300), e.retries ?? null, e.at);
            }
            d.prepare('UPDATE runs SET requests_total = ?, requests_failed = ? WHERE run_id = ?')
                .run(snapshot.requestsTotal, snapshot.requestsFailed, runId);
        });
        tx();
    } catch (e) {
        console.error('⚠️ 账本写入失败(不影响本轮采集产出):', (e as Error).message);
    }
}

// ───────── 批次生命周期(run-batch 侧)─────────

// SQLite 原子占位替代 flock(计划书 §5.1 · 同时防双实例)
export function claimRunSlot(opts: { runId: string; triggeredBy: string; batchType: string; scope?: string; extra?: Record<string, unknown> }): boolean {
    const d = db();
    const r = d.prepare(`
        INSERT INTO runs (run_id, started_at, status, triggered_by, batch_type, scope, is_after_reset, git_commit,
                          proxy_main_hash, proxy_medium_hash, proxy_slow_hash, log_path)
        SELECT @run_id, @started_at, 'running', @triggered_by, @batch_type, @scope, @is_after_reset, @git_commit,
               @proxy_main_hash, @proxy_medium_hash, @proxy_slow_hash, @log_path
        WHERE NOT EXISTS (SELECT 1 FROM runs WHERE status IN ('running', 'queued'))
    `).run({
        run_id: opts.runId, started_at: now(), triggered_by: opts.triggeredBy, batch_type: opts.batchType,
        scope: opts.scope ?? null,
        is_after_reset: (opts.extra?.is_after_reset as number) ?? 0,
        git_commit: (opts.extra?.git_commit as string) ?? null,
        proxy_main_hash: (opts.extra?.proxy_main_hash as string) ?? null,
        proxy_medium_hash: (opts.extra?.proxy_medium_hash as string) ?? null,
        proxy_slow_hash: (opts.extra?.proxy_slow_hash as string) ?? null,
        log_path: (opts.extra?.log_path as string) ?? null,
    });
    return r.changes === 1;
}

export function recordSkippedOverlap(runId: string, triggeredBy: string): void {
    try {
        db().prepare(`INSERT INTO runs (run_id, started_at, finished_at, status, triggered_by) VALUES (?, ?, ?, 'skipped_overlap', ?)`)
            .run(runId, now(), now(), triggeredBy);
    } catch (e) { console.error('⚠️ overlap 记录失败:', (e as Error).message); }
}

export function finishRun(runId: string, r: { status: RunStatus; exitCode?: number | null; exitSignal?: string | null; datasetAdded?: number; sourcesWithNew?: number; alertsOpened?: number; notes?: string }): void {
    try {
        const d = db();
        const run = d.prepare('SELECT started_at FROM runs WHERE run_id = ?').get(runId) as { started_at?: string } | undefined;
        const dur = run?.started_at ? (Date.now() - Date.parse(run.started_at)) / 1000 : null;
        const reqs = d.prepare('SELECT requests_total FROM runs WHERE run_id = ?').get(runId) as { requests_total?: number } | undefined;
        const rpm = dur && reqs?.requests_total ? Math.round((reqs.requests_total / dur) * 60) : null;
        d.prepare(`
            UPDATE runs SET finished_at = ?, duration_s = ?, status = ?, exit_code = ?, exit_signal = ?,
                dataset_added = COALESCE(?, dataset_added), sources_with_new = COALESCE(?, sources_with_new),
                alerts_opened = COALESCE(?, alerts_opened), rpm_actual = COALESCE(?, rpm_actual),
                notes = COALESCE(?, notes)
            WHERE run_id = ?
        `).run(now(), dur, r.status, r.exitCode ?? null, r.exitSignal ?? null,
            r.datasetAdded ?? null, r.sourcesWithNew ?? null, r.alertsOpened ?? null, rpm,
            r.notes ?? null, runId);
    } catch (e) { console.error('⚠️ finishRun 失败:', (e as Error).message); }
}

// 崩溃恢复:status=running 且超过 2×超时的孤儿(审计 A4-P0-4)
export function findStaleRunningRuns(timeoutMin: number): { run_id: string; started_at: string }[] {
    return db().prepare(`SELECT run_id, started_at FROM runs WHERE status = 'running' AND started_at < ?`)
        .all(new Date(Date.now() - 2 * timeoutMin * 60_000).toISOString()) as { run_id: string; started_at: string }[];
}

export function markRunCrashed(runId: string): void {
    db().prepare(`UPDATE runs SET status = 'crashed', finished_at = ?, notes = COALESCE(notes,'') || ' [启动时侦测:进程异常终止]' WHERE run_id = ?`)
        .run(now(), runId);
}

// ───────── 调度状态(schedule_state · 重启不失忆)─────────

export function ensureScheduleState(name: string, intervalMs: number): void {
    db().prepare(`INSERT OR IGNORE INTO schedule_state (schedule_name, interval_ms, next_run_at, updated_at) VALUES (?, ?, ?, ?)`)
        .run(name, intervalMs, now(), now());
    // interval 配置变了 → 同步(next_run_at 不动 · 下次 advance 用新值)
    db().prepare(`UPDATE schedule_state SET interval_ms = ? WHERE schedule_name = ?`).run(intervalMs, name);
}

export function getScheduleState(name: string): { schedule_name: string; interval_ms: number; next_run_at: string; paused: number; paused_at: string | null; last_tick_at: string | null; last_triggered_run_id: string | null } | undefined {
    return db().prepare('SELECT * FROM schedule_state WHERE schedule_name = ?').get(name) as ReturnType<typeof getScheduleState>;
}

export function touchScheduleTick(name: string): void {
    try { db().prepare('UPDATE schedule_state SET last_tick_at = ?, updated_at = ? WHERE schedule_name = ?').run(now(), now(), name); } catch { /* 心跳失败不致命 */ }
}

export function advanceNextRun(name: string, runId: string): void {
    const st = getScheduleState(name);
    const next = new Date(Date.now() + (st?.interval_ms ?? 3_600_000)).toISOString();
    db().prepare('UPDATE schedule_state SET next_run_at = ?, last_triggered_run_id = ?, updated_at = ? WHERE schedule_name = ?')
        .run(next, runId, now(), name);
}

export function setPaused(name: string, paused: boolean): void {
    db().prepare('UPDATE schedule_state SET paused = ?, paused_at = ?, updated_at = ? WHERE schedule_name = ?')
        .run(paused ? 1 : 0, paused ? now() : null, now(), name);
}

// ───────── 告警状态机 ─────────

// 同 (token_id,type) 已有 open/ack → 只更新 last_run/detail(不重复轰炸);否则新建。返回是否新开
export function upsertAlert(a: AlertRow, runId: string): boolean {
    const d = db();
    const existing = d.prepare(`SELECT alert_id FROM alerts WHERE type = ? AND status IN ('open','ack') AND (token_id IS ? OR token_id = ?)`)
        .get(a.type, a.token_id, a.token_id) as { alert_id?: number } | undefined;
    if (existing?.alert_id) {
        d.prepare('UPDATE alerts SET last_run_id = ?, detail = ?, severity = ? WHERE alert_id = ?')
            .run(runId, a.detail, a.severity, existing.alert_id);
        return false;
    }
    d.prepare(`INSERT INTO alerts (token_id, base_symbol, type, severity, status, first_run_id, last_run_id, detail, created_at)
               VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)`)
        .run(a.token_id, a.base_symbol, a.type, a.severity, runId, runId, a.detail, now());
    return true;
}

// 条件连续 2 轮不满足自动 resolved:detector 每轮把"本轮仍触发"的 alert_id 传进来,其余 open 的关掉
export function resolveAlertsNotIn(stillFiring: number[], lastTwoRunIds: string[]): number {
    const d = db();
    const open = d.prepare(`SELECT alert_id, last_run_id FROM alerts WHERE status IN ('open','ack') AND type NOT IN ('seen_store_bloat','dataset_bloat')`).all() as { alert_id: number; last_run_id: string }[];
    let n = 0;
    for (const a of open) {
        if (stillFiring.includes(a.alert_id)) continue;
        if (!lastTwoRunIds.includes(a.last_run_id)) { // 最近两轮都没再触发
            d.prepare(`UPDATE alerts SET status = 'resolved', resolved_at = ? WHERE alert_id = ?`).run(now(), a.alert_id);
            n += 1;
        }
    }
    return n;
}

// ───────── articles(运维台收割 · UPSERT 铁律)─────────

export interface ArticleInput {
    url: string; token_id: number; base_symbol?: string;
    title?: string; h1?: string; description?: string; jsonld_description?: string; body_excerpt?: string;
    published_at?: string; crawler?: string; crawled_at?: string;
    header_last_modified?: string; // 🆕 2026-07-05 Last-Modified 兜底事实字段(收割层 fresh 行决策用 · 不入库)
}

export function upsertArticles(items: ArticleInput[], runId: string | null): number {
    if (items.length === 0) return 0;
    const d = db();
    const stmt = d.prepare(`
        INSERT INTO articles (url, token_id, base_symbol, title, h1, description, jsonld_description, body_excerpt,
                              published_at, crawler, first_run_id, crawled_at, last_seen_at)
        VALUES (@url, @token_id, @base_symbol, @title, @h1, @description, @jsonld_description, @body_excerpt,
                @published_at, @crawler, @first_run_id, @crawled_at, @last_seen_at)
        ON CONFLICT(url, token_id) DO UPDATE SET
            -- 内容列仅空值回填 · first_run_id/crawled_at/push_* 永不覆盖(铁律)
            title = COALESCE(NULLIF(articles.title,''), excluded.title),
            h1 = COALESCE(NULLIF(articles.h1,''), excluded.h1),
            description = COALESCE(NULLIF(articles.description,''), excluded.description),
            jsonld_description = COALESCE(NULLIF(articles.jsonld_description,''), excluded.jsonld_description),
            body_excerpt = COALESCE(NULLIF(articles.body_excerpt,''), excluded.body_excerpt),
            published_at = COALESCE(NULLIF(articles.published_at,''), excluded.published_at),
            last_seen_at = excluded.last_seen_at
    `);
    let n = 0;
    const tx = d.transaction(() => {
        for (const it of items) {
            stmt.run({
                url: it.url, token_id: it.token_id, base_symbol: it.base_symbol ?? '',
                title: it.title ?? '', h1: it.h1 ?? '', description: it.description ?? '',
                jsonld_description: it.jsonld_description ?? '', body_excerpt: it.body_excerpt ?? '',
                published_at: it.published_at ?? '', crawler: it.crawler ?? '',
                first_run_id: runId, crawled_at: it.crawled_at ?? now(), last_seen_at: now(),
            });
            n += 1;
        }
    });
    tx();
    return n;
}

export function knownArticleKeys(): Set<string> {
    const rows = db().prepare('SELECT url, token_id FROM articles').all() as { url: string; token_id: number }[];
    return new Set(rows.map((r) => `${r.token_id}|${r.url}`));
}

// 批末物化 sources.last_article_at(/api/sources 不实时扫 articles)
export function refreshLastArticleAt(): void {
    db().exec(`
        UPDATE sources SET last_article_at = (
            SELECT MAX(COALESCE(NULLIF(a.published_at,''), a.crawled_at)) FROM articles a WHERE a.token_id = sources.token_id
        )
    `);
}

export function cleanupOldErrors(days = 30): void {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    db().prepare(`DELETE FROM crawl_errors WHERE at < ?`).run(cutoff);
}

export { type SourceRow };
