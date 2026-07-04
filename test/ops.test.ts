// 🆕 2026-07-04 运维台核心单测(计划书 §9 验收 · detector 规则/ledger 铁律/error-classify 枚举)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

// 隔离测试库(必须在动态 import 前设置)
process.env.OPS_DB_PATH = `storage/test-ops-${process.pid}.db`;
delete process.env.RUN_ID;

const { classifyError, classifySoftErrorPage } = await import('../shared/error-classify.js');
const { db } = await import('../shared/db.js');
const ledger = await import('../shared/ledger.js');
const { flushRun, upsertArticles, claimRunSlot, findStaleRunningRuns, upsertAlert } = ledger;
const { runDetector } = await import('../ops/detector.js');

after(() => {
    try { db().close(); } catch { /* */ }
    for (const suf of ['', '-wal', '-shm']) {
        try { rmSync(`storage/test-ops-${process.pid}.db${suf}`); } catch { /* */ }
    }
});

// ═══ error-classify:全枚举 fixture ═══
test('error-classify · 状态码优先 + Node code + message 正则 + internal 兜底', () => {
    assert.equal(classifyError({ message: 'Request blocked - received 403 status code.' }).kind, 'http_403');
    assert.equal(classifyError({ statusCode: 429, retryAfter: '60' }).retry_after_s, 60);
    assert.equal(classifyError({ statusCode: 429 }).kind, 'http_429');
    assert.equal(classifyError({ message: '404 - Not Found' }).kind, 'http_404');
    assert.equal(classifyError({ statusCode: 522 }).kind, 'http_5xx');
    assert.equal(classifyError({ statusCode: 410 }).kind, 'http_4xx');
    assert.equal(classifyError({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND x.com' }).kind, 'unreachable');
    assert.equal(classifyError({ code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' }).kind, 'timeout');
    assert.equal(classifyError({ message: 'Request timed out after 25000ms' }).kind, 'timeout');
    assert.equal(classifyError({ message: 'Proxy connection failed: SOCKS5 auth' }).kind, 'proxy_error');
    assert.equal(classifyError({ message: 'unable to verify TLS certificate chain' }).kind, 'tls_error');
    assert.equal(classifyError({ message: 'New streams cannot be created after receiving a GOAWAY' }).kind, 'unreachable');
    assert.equal(classifyError({ message: '$ is not a function' }).kind, 'parse_error');
    assert.equal(classifyError({ message: 'something totally novel' }).kind, 'internal');
    // 软错误页(HTTP 200)
    assert.equal(classifySoftErrorPage('Just a moment...'), 'cf_challenge');
    assert.equal(classifySoftErrorPage('404 | Page not found'), 'soft_404');
    assert.equal(classifySoftErrorPage('Access Denied'), 'error_page');
});

// ═══ ledger:RUN_ID 网关 + UPSERT 铁律 + 占位互斥 ═══
test('ledger · flushRun 网关:无 RUN_ID 零写入(裸跑不记账拍板)', () => {
    delete process.env.RUN_ID;
    flushRun({ sources: [{ token_id: 1, base_symbol: 'X', crawler: 'rss', counts: { items_added: 5 } }], errors: [], requestsTotal: 1, requestsFailed: 0 });
    assert.equal((db().prepare('SELECT COUNT(*) c FROM source_runs').get() as { c: number }).c, 0);
});

test('ledger · claimRunSlot 原子互斥:running 存在时抢不到', () => {
    assert.equal(claimRunSlot({ runId: 'run-t1', triggeredBy: 'scheduler', batchType: 'crawl' }), true);
    assert.equal(claimRunSlot({ runId: 'run-t2', triggeredBy: 'manual', batchType: 'crawl' }), false);
    db().prepare(`UPDATE runs SET status = 'ok', finished_at = ? WHERE run_id = 'run-t1'`).run(new Date().toISOString());
    assert.equal(claimRunSlot({ runId: 'run-t3', triggeredBy: 'scheduler', batchType: 'crawl' }), true);
    db().prepare(`UPDATE runs SET status = 'ok' WHERE run_id = 'run-t3'`).run();
});

test('ledger · articles UPSERT 铁律:push_status/first_run_id/crawled_at 不被覆盖', () => {
    upsertArticles([{ url: 'https://x.com/a', token_id: 1, base_symbol: 'X', title: 'A', crawled_at: '2026-07-01T00:00:00Z' }], 'run-t1');
    db().prepare(`UPDATE articles SET push_status = 'pushed', pushed_at = '2026-07-02T00:00:00Z' WHERE url = 'https://x.com/a'`).run();
    // reset 后重新收割同一篇(模拟) → push 状态必须保住
    upsertArticles([{ url: 'https://x.com/a', token_id: 1, base_symbol: 'X', title: 'A v2', crawled_at: '2026-07-04T00:00:00Z' }], 'run-t3');
    const row = db().prepare(`SELECT * FROM articles WHERE url = 'https://x.com/a'`).get() as Record<string, string>;
    assert.equal(row.push_status, 'pushed');       // 铁律:不被冲回 none
    assert.equal(row.first_run_id, 'run-t1');      // 首采信息不覆盖
    assert.equal(row.crawled_at, '2026-07-01T00:00:00Z');
    assert.equal(row.title, 'A');                  // 内容列非空不覆盖(空值回填语义)
});

test('ledger · findStaleRunningRuns:孤儿 running 侦测', () => {
    db().prepare(`INSERT INTO runs (run_id, started_at, status) VALUES ('run-zombie', ?, 'running')`)
        .run(new Date(Date.now() - 3 * 3600_000).toISOString());
    const stale = findStaleRunningRuns(30);
    assert.ok(stale.some((r) => r.run_id === 'run-zombie'));
    ledger.markRunCrashed('run-zombie');
    assert.equal((db().prepare(`SELECT status FROM runs WHERE run_id = 'run-zombie'`).get() as { status: string }).status, 'crashed');
});

// ═══ detector:触发/不触发/持续/恢复/reset 跳过 ═══
function seedRun(runId: string, startedAgoMin: number, stats: { token_id: number; base_symbol: string; items_added?: number; requests?: number; failed?: number; http_429?: number; list_candidates?: number | null; feed_items?: number | null }[], isAfterReset = 0): void {
    const d = db();
    d.prepare(`INSERT OR REPLACE INTO runs (run_id, started_at, finished_at, status, batch_type, is_after_reset) VALUES (?, ?, ?, 'ok', 'crawl', ?)`)
        .run(runId, new Date(Date.now() - startedAgoMin * 60000).toISOString(), new Date().toISOString(), isAfterReset);
    for (const s of stats) {
        d.prepare(`INSERT OR REPLACE INTO source_runs (run_id, token_id, base_symbol, crawler, items_added, requests, failed, http_429, list_candidates, feed_items)
                   VALUES (?, ?, ?, 'article-detail', ?, ?, ?, ?, ?, ?)`)
            .run(runId, s.token_id, s.base_symbol, s.items_added ?? 0, s.requests ?? 0, s.failed ?? 0, s.http_429 ?? 0, s.list_candidates ?? null, s.feed_items ?? null);
    }
}

test('detector · source_gone 连续 2 轮全失败才触发 · 恢复后自动 resolved', () => {
    const d = db();
    d.prepare(`DELETE FROM runs`).run(); d.prepare(`DELETE FROM source_runs`).run(); d.prepare(`DELETE FROM alerts`).run();
    // 7 天内有产出(前提)
    seedRun('run-d0', 300, [{ token_id: 9, base_symbol: 'GONE', items_added: 3, requests: 5 }]);
    // 第 1 轮全失败:不触发(连续未满 2)
    seedRun('run-d1', 120, [{ token_id: 9, base_symbol: 'GONE', requests: 4, failed: 4 }]);
    runDetector('run-d1');
    assert.equal((d.prepare(`SELECT COUNT(*) c FROM alerts WHERE type = 'source_gone' AND status = 'open'`).get() as { c: number }).c, 0);
    // 第 2 轮全失败:触发
    seedRun('run-d2', 60, [{ token_id: 9, base_symbol: 'GONE', requests: 4, failed: 4 }]);
    runDetector('run-d2');
    assert.equal((d.prepare(`SELECT COUNT(*) c FROM alerts WHERE type = 'source_gone' AND status = 'open'`).get() as { c: number }).c, 1);
    // 第 3 轮持续:不重复开(状态机更新 last_run)
    seedRun('run-d3', 30, [{ token_id: 9, base_symbol: 'GONE', requests: 4, failed: 4 }]);
    runDetector('run-d3');
    assert.equal((d.prepare(`SELECT COUNT(*) c FROM alerts WHERE type = 'source_gone'`).get() as { c: number }).c, 1);
    // 恢复两轮:自动 resolved
    seedRun('run-d4', 20, [{ token_id: 9, base_symbol: 'GONE', items_added: 2, requests: 4 }]);
    runDetector('run-d4');
    seedRun('run-d5', 10, [{ token_id: 9, base_symbol: 'GONE', items_added: 1, requests: 4 }]);
    runDetector('run-d5');
    assert.equal((d.prepare(`SELECT status FROM alerts WHERE type = 'source_gone'`).get() as { status: string }).status, 'resolved');
});

test('detector · list_shrink 触发 + is_after_reset 轮跳过环比', () => {
    const d = db();
    d.prepare(`DELETE FROM runs`).run(); d.prepare(`DELETE FROM source_runs`).run(); d.prepare(`DELETE FROM alerts`).run();
    seedRun('run-l1', 120, [{ token_id: 7, base_symbol: 'SHRK', items_added: 2, requests: 6, list_candidates: 12 }]);
    seedRun('run-l2', 60, [{ token_id: 7, base_symbol: 'SHRK', requests: 6, list_candidates: 0 }]);
    runDetector('run-l2');
    assert.equal((d.prepare(`SELECT COUNT(*) c FROM alerts WHERE type = 'list_shrink' AND status = 'open'`).get() as { c: number }).c, 1);
    // reset 轮:同样数据不触发新告警类型
    d.prepare(`DELETE FROM alerts`).run();
    seedRun('run-l3', 30, [{ token_id: 7, base_symbol: 'SHRK', requests: 6, list_candidates: 0 }], 1);
    runDetector('run-l3');
    assert.equal((d.prepare(`SELECT COUNT(*) c FROM alerts WHERE status = 'open' AND type != 'run_failed'`).get() as { c: number }).c, 0);
});

test('detector · rate_limited(429 连续 2 轮 >50%)+ detail 带原因', () => {
    const d = db();
    d.prepare(`DELETE FROM runs`).run(); d.prepare(`DELETE FROM source_runs`).run(); d.prepare(`DELETE FROM alerts`).run();
    seedRun('run-r1', 120, [{ token_id: 5, base_symbol: 'RATE', requests: 10, failed: 6, http_429: 6 }]);
    seedRun('run-r2', 60, [{ token_id: 5, base_symbol: 'RATE', requests: 10, failed: 7, http_429: 7 }]);
    runDetector('run-r2');
    const a = d.prepare(`SELECT * FROM alerts WHERE type = 'rate_limited'`).get() as { detail: string } | undefined;
    assert.ok(a, 'rate_limited 应触发');
    assert.ok(a!.detail.includes('429'), 'detail 带原因');
});

test('alerts · upsertAlert 状态机:同 token+type 更新不重复', () => {
    const d = db();
    d.prepare(`DELETE FROM alerts`).run();
    assert.equal(upsertAlert({ token_id: 3, base_symbol: 'T', type: 'feed_dead', severity: 'yellow', detail: 'v1' }, 'run-x1'), true);
    assert.equal(upsertAlert({ token_id: 3, base_symbol: 'T', type: 'feed_dead', severity: 'yellow', detail: 'v2' }, 'run-x2'), false);
    const row = d.prepare(`SELECT * FROM alerts WHERE type = 'feed_dead'`).all();
    assert.equal(row.length, 1);
    assert.equal((row[0] as { detail: string }).detail, 'v2');
});
