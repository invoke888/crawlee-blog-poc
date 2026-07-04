// 🆕 2026-07-04 分析器:环比检测(计划书 §6)· 纯读账本 · 单测覆盖
// 原则:少而准 · is_after_reset 轮跳过环比类 · detail 必带 kind 分布(不许只说"挂了")
import { statSync, readdirSync } from 'node:fs';
import { db } from '../shared/db.js';
import { upsertAlert, resolveAlertsNotIn } from '../shared/ledger.js';
import { cfgNum } from '../shared/config.js';
import type { AlertRow } from '../shared/types.js';

interface SR {
    token_id: number; base_symbol: string; crawler: string;
    items_added: number; requests: number; failed: number;
    http_403: number; http_404: number; http_429: number; timeout: number; proxy_error: number;
    blocked_noise: number; blocked_external: number; blocked_error_page: number;
    list_candidates: number | null; feed_items: number | null;
}

function kindBreakdown(runId: string, tokenId: number): string {
    const rows = db().prepare('SELECT kind, COUNT(*) c FROM crawl_errors WHERE run_id = ? AND token_id = ? GROUP BY kind ORDER BY c DESC').all(runId, tokenId) as { kind: string; c: number }[];
    return rows.map((r) => `${r.kind}×${r.c}`).join(' + ') || '无错误明细';
}

// 返回本轮新开告警数(runs.alerts_opened)
export function runDetector(runId: string): number {
    const d = db();
    const run = d.prepare('SELECT is_after_reset, status FROM runs WHERE run_id = ?').get(runId) as { is_after_reset?: number; status?: string } | undefined;

    const recentRuns = d.prepare(`SELECT run_id FROM runs WHERE batch_type = 'crawl' AND status IN ('ok','failed','timeout') AND run_id != ? ORDER BY started_at DESC LIMIT 10`).all(runId) as { run_id: string }[];
    const prevId = recentRuns[0]?.run_id ?? null;
    const cur = new Map<number, SR>((d.prepare('SELECT * FROM source_runs WHERE run_id = ?').all(runId) as SR[]).map((r) => [r.token_id, r]));
    const prev = prevId ? new Map<number, SR>((d.prepare('SELECT * FROM source_runs WHERE run_id = ?').all(prevId) as SR[]).map((r) => [r.token_id, r])) : new Map<number, SR>();

    const streak = cfgNum('error_streak_runs', 2);
    const streakRed = cfgNum('error_streak_runs_red', 4);
    const listShrinkMin = cfgNum('list_shrink_min', 5);
    const dropPct = cfgNum('pipeline_drop_pct', 70);

    const alerts: AlertRow[] = [];
    const skipComparative = !!run?.is_after_reset;

    // 近 7 天有产出的 token(source_gone 前提)
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const productive = new Set((d.prepare(`
        SELECT DISTINCT sr.token_id FROM source_runs sr JOIN runs r ON r.run_id = sr.run_id
        WHERE r.started_at > ? AND sr.items_added > 0`).all(weekAgo) as { token_id: number }[]).map((r) => r.token_id));

    // 连续 N 轮判定 helper:最近 streak 轮该 token 都满足 predicate
    const lastNRunIds = [runId, ...recentRuns.map((r) => r.run_id)];
    const streakHit = (tokenId: number, n: number, pred: (sr: SR | undefined) => boolean): boolean => {
        if (lastNRunIds.length < n) return false;
        for (const rid of lastNRunIds.slice(0, n)) {
            const sr = d.prepare('SELECT * FROM source_runs WHERE run_id = ? AND token_id = ?').get(rid, tokenId) as SR | undefined;
            if (!pred(sr)) return false;
        }
        return true;
    };

    if (!skipComparative) {
        for (const [tokenId, sr] of cur) {
            const p = prev.get(tokenId);
            const allFailed = (x: SR | undefined) => !!x && x.requests > 0 && x.failed >= x.requests;
            // source_gone:近7天有产出 + 连续 streak 轮全失败
            if (productive.has(tokenId) && streakHit(tokenId, streak, allFailed)) {
                alerts.push({ token_id: tokenId, base_symbol: sr.base_symbol, type: 'source_gone', severity: 'red',
                    detail: `近 7 天有产出 · 连续 ${streak} 轮请求全失败 — ${kindBreakdown(runId, tokenId)}` });
            }
            // http_shift:上轮 2xx 为主 → 本轮 403/404/429 为主
            if (p && p.requests > 0 && p.failed / p.requests < 0.3) {
                const bad = sr.http_403 + sr.http_404 + sr.http_429;
                if (sr.requests > 0 && bad / sr.requests > 0.6) {
                    alerts.push({ token_id: tokenId, base_symbol: sr.base_symbol, type: 'http_shift', severity: 'red',
                        detail: `上轮正常 → 本轮 ${bad}/${sr.requests} 拒绝 — ${kindBreakdown(runId, tokenId)}` });
                }
            }
            // rate_limited:429 占比 >50% 连续 2 轮
            const rl = (x: SR | undefined) => !!x && x.requests > 0 && x.http_429 / x.requests > 0.5;
            if (streakHit(tokenId, 2, rl)) {
                alerts.push({ token_id: tokenId, base_symbol: sr.base_symbol, type: 'rate_limited', severity: 'yellow',
                    detail: `429 占比连续 2 轮 >50%(本轮 ${sr.http_429}/${sr.requests})— 建议放慢该源` });
            }
            // list_shrink:候选 上轮>min → 本轮 0
            if (p?.list_candidates != null && sr.list_candidates != null && p.list_candidates > listShrinkMin && sr.list_candidates === 0) {
                alerts.push({ token_id: tokenId, base_symbol: sr.base_symbol, type: 'list_shrink', severity: 'yellow',
                    detail: `列表候选 ${p.list_candidates} → 0 — 疑似站点改版,规则可能失效` });
            }
            // feed_dead:feed 源连续 2 轮 0 item(此前正常)
            const feedZero = (x: SR | undefined) => !!x && x.feed_items === 0;
            if (sr.feed_items != null && streakHit(tokenId, 2, feedZero)) {
                const everHad = d.prepare('SELECT 1 FROM source_runs WHERE token_id = ? AND feed_items > 0 LIMIT 1').get(tokenId);
                if (everHad) {
                    alerts.push({ token_id: tokenId, base_symbol: sr.base_symbol, type: 'feed_dead', severity: 'yellow',
                        detail: `feed 连续 2 轮 0 条(此前正常)— feed 失效或搬家` });
                }
            }
            // external_surge:外链拦截占候选 >80%(此前 ~0)
            if (sr.list_candidates != null && sr.list_candidates > 0 && sr.blocked_external / Math.max(1, sr.list_candidates) > 0.8 && (p?.blocked_external ?? 0) <= 1) {
                alerts.push({ token_id: tokenId, base_symbol: sr.base_symbol, type: 'external_surge', severity: 'yellow',
                    detail: `外链拦截 ${sr.blocked_external}/${sr.list_candidates} 候选 — 门面站信号(链接指向外域)` });
            }
            // noise_surge:noise 暴增且零新增
            if (p && sr.blocked_noise > 3 * Math.max(1, p.blocked_noise) && sr.blocked_noise > 20 && sr.items_added === 0) {
                alerts.push({ token_id: tokenId, base_symbol: sr.base_symbol, type: 'noise_surge', severity: 'yellow',
                    detail: `规则拦截 ${p.blocked_noise} → ${sr.blocked_noise} 且零新增 — 疑似改版成规则拦不住的形态` });
            }
        }

        // error_kind_streak:同 (token,kind) 连续 ≥streak 轮 🟡 / ≥streakRed 轮 🔴
        const kindRows = d.prepare(`SELECT token_id, base_symbol, kind FROM crawl_errors WHERE run_id = ? AND token_id IS NOT NULL GROUP BY token_id, kind`).all(runId) as { token_id: number; base_symbol: string; kind: string }[];
        for (const kr of kindRows) {
            const hitRun = (rid: string) => !!d.prepare('SELECT 1 FROM crawl_errors WHERE run_id = ? AND token_id = ? AND kind = ? LIMIT 1').get(rid, kr.token_id, kr.kind);
            let n = 0;
            for (const rid of lastNRunIds) { if (hitRun(rid)) n += 1; else break; }
            if (n >= streak) {
                alerts.push({ token_id: kr.token_id, base_symbol: kr.base_symbol, type: 'error_kind_streak', severity: n >= streakRed ? 'red' : 'yellow',
                    detail: `${kr.kind} 连续 ${n} 轮出现 — ${kindBreakdown(runId, kr.token_id)}` });
            }
        }

        // pipeline_drop:管线级新增环比降 >dropPct% 且绝对值 >50
        if (prevId) {
            const pipe = (rid: string) => new Map((d.prepare('SELECT crawler, SUM(items_added) s FROM source_runs WHERE run_id = ? GROUP BY crawler').all(rid) as { crawler: string; s: number }[]).map((r) => [r.crawler, r.s]));
            const curP = pipe(runId); const prevP = pipe(prevId);
            for (const [cr, prevSum] of prevP) {
                const curSum = curP.get(cr) ?? 0;
                if (prevSum > 50 && curSum < prevSum * (1 - dropPct / 100)) {
                    alerts.push({ token_id: null, base_symbol: null, type: 'pipeline_drop', severity: 'red',
                        detail: `管线 ${cr} 新增 ${prevSum} → ${curSum}(降 ${Math.round((1 - curSum / prevSum) * 100)}%)` });
                }
            }
        }

        // unclassified_surge:internal 桶超阈值(分类器该扩枚举了)
        const internalN = (d.prepare(`SELECT COUNT(*) c FROM crawl_errors WHERE run_id = ? AND kind = 'internal'`).get(runId) as { c: number }).c;
        if (internalN > 10) {
            alerts.push({ token_id: null, base_symbol: null, type: 'unclassified_surge', severity: 'yellow',
                detail: `本轮 ${internalN} 条未分类错误(internal)— error-classify 可能遇到新错误模式` });
        }
    }

    // 批次级(不受 reset 跳过影响)
    if (run?.status === 'failed' || run?.status === 'timeout') {
        alerts.push({ token_id: null, base_symbol: null, type: run.status === 'timeout' ? 'run_timeout' : 'run_failed', severity: 'red',
            detail: `批次 ${runId} ${run.status}` });
    }

    // 存储膨胀(⚪ info)
    try {
        const seenPath = 'storage/key_value_stores/seen-articles';
        let seenBytes = 0;
        try { for (const f of readdirSync(seenPath)) seenBytes += statSync(`${seenPath}/${f}`).size; } catch { /* 无 */ }
        if (seenBytes > 5 * 1024 * 1024) {
            alerts.push({ token_id: null, base_symbol: null, type: 'seen_store_bloat', severity: 'info', detail: `seen-articles ${(seenBytes / 1048576).toFixed(1)}MB > 5MB(裁剪归二期)` });
        }
    } catch { /* 忽略 */ }

    // 落库(状态机)+ 自动 resolve
    let opened = 0;
    const firing: number[] = [];
    for (const a of alerts) {
        if (upsertAlert(a, runId)) opened += 1;
        const row = db().prepare(`SELECT alert_id FROM alerts WHERE type = ? AND status IN ('open','ack') AND (token_id IS ? OR token_id = ?)`).get(a.type, a.token_id, a.token_id) as { alert_id?: number } | undefined;
        if (row?.alert_id) firing.push(row.alert_id);
    }
    resolveAlertsNotIn(firing, lastNRunIds.slice(0, 2));
    return opened;
}
