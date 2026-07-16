// 🆕 2026-07-16 已推补推回归锁(老板拍:已推标签点击→确认→补推)
// 锁死 retryUrls 通道语义:不看 push_status(pushed 行也进推送批)· 前端"已推补推"按钮依赖此行为
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

// 隔离测试库(必须在动态 import 前设置)
process.env.OPS_DB_PATH = `storage/test-pusher-retry-${process.pid}.db`;

const { db } = await import('../shared/db.js');
const { runPusher } = await import('../ops/pusher.js');

after(() => {
    try { db().close(); } catch { /* */ }
    for (const suf of ['', '-wal', '-shm']) {
        try { rmSync(`storage/test-pusher-retry-${process.pid}.db${suf}`); } catch { /* */ }
    }
});

test('补推 · retryUrls 对 pushed 行有效(进推送批 · 不被 push_status 过滤)', async () => {
    db().prepare(`INSERT INTO articles (url, token_id, base_symbol, title, published_at, crawled_at, push_status, pushed_at)
                  VALUES ('https://x.io/blog/already-pushed', 1, 'T', 'title', '2026-07-15T00:00:00.000Z', '2026-07-15T01:00:00.000Z', 'pushed', '2026-07-15T01:05:00.000Z')`).run();
    const r = await runPusher(null, { retryUrls: ['https://x.io/blog/already-pushed'], dryOverride: true });
    assert.equal(r.pushed, 1); // pushed 行被捞进推送批(dry 演练不真发不回写)
});

test('补推 · retryUrls 对发布超 7 天的 pushed 老文也有效(手动通道豁免新文守门)', async () => {
    db().prepare(`INSERT INTO articles (url, token_id, base_symbol, title, published_at, crawled_at, push_status, pushed_at)
                  VALUES ('https://x.io/blog/old-pushed', 1, 'T', 'title', '2025-01-01T00:00:00.000Z', '2026-07-10T01:00:00.000Z', 'pushed', '2026-07-10T01:05:00.000Z')`).run();
    const r = await runPusher(null, { retryUrls: ['https://x.io/blog/old-pushed'], dryOverride: true });
    assert.equal(r.pushed, 1); // 老文手动补推照样进批(守门只管自动推路径)
});
