// 🆕 2026-07-13 新文守门单测(老板拍:确保以后推的是新文 · 滚动 7 天)
// 背景:运输带切换后账本缺口老文当新文涌入(ECB 2021-2023 文 2226 条误推实锤)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

// 隔离测试库(必须在动态 import 前设置)
process.env.OPS_DB_PATH = `storage/test-pusher-fresh-${process.pid}.db`;

const { db } = await import('../shared/db.js');
const { skipStaleBeforePush, FRESH_WINDOW_DAYS } = await import('../ops/pusher.js');

after(() => {
    try { db().close(); } catch { /* */ }
    for (const suf of ['', '-wal', '-shm']) {
        try { rmSync(`storage/test-pusher-fresh-${process.pid}.db${suf}`); } catch { /* */ }
    }
});

const NOW = '2026-07-13T12:00:00.000Z';

function insertArticle(url: string, pub: string | null, status: string): void {
    db().prepare(`INSERT INTO articles (url, token_id, base_symbol, title, published_at, crawled_at, push_status)
                  VALUES (?, 1, 'T', 'title', ?, ?, ?)`).run(url, pub, NOW, status);
}

function statusOf(url: string): string {
    return (db().prepare(`SELECT push_status s FROM articles WHERE url = ?`).get(url) as { s: string }).s;
}

test('守门 · 发布超 7 天的 none 行标 skipped_backlog(迟到首采不推)', () => {
    insertArticle('https://x.io/blog/old', '2026-07-01T00:00:00.000Z', 'none');   // 12 天前
    insertArticle('https://x.io/blog/ancient', '2022-07-08T00:00:00.000Z', 'none'); // ECB 型陈年文
    const changed = skipStaleBeforePush(NOW);
    assert.equal(changed, 2);
    assert.equal(statusOf('https://x.io/blog/old'), 'skipped_backlog');
    assert.equal(statusOf('https://x.io/blog/ancient'), 'skipped_backlog');
});

test('守门 · 窗口内新文保持 none(照常推)', () => {
    insertArticle('https://x.io/blog/fresh', '2026-07-11T08:00:00.000Z', 'none'); // 2 天前
    skipStaleBeforePush(NOW);
    assert.equal(statusOf('https://x.io/blog/fresh'), 'none');
});

test('守门 · published_at 空/NULL 放行(spa 源新文无字段 · 按 crawled_at 现行为)', () => {
    insertArticle('https://x.io/blog/nopub', '', 'none');
    insertArticle('https://x.io/blog/nullpub', null, 'none');
    skipStaleBeforePush(NOW);
    assert.equal(statusOf('https://x.io/blog/nopub'), 'none');
    assert.equal(statusOf('https://x.io/blog/nullpub'), 'none');
});

test('守门 · 只动 none:failed 重试行/已推行不受影响', () => {
    insertArticle('https://x.io/blog/oldfailed', '2026-06-01T00:00:00.000Z', 'failed');
    insertArticle('https://x.io/blog/oldpushed', '2026-06-01T00:00:00.000Z', 'pushed');
    const changed = skipStaleBeforePush(NOW);
    assert.equal(changed, 0);
    assert.equal(statusOf('https://x.io/blog/oldfailed'), 'failed');
    assert.equal(statusOf('https://x.io/blog/oldpushed'), 'pushed');
});

test('守门 · date-only 格式(2026-07-01)也能判老 · 窗口边界字典序成立', () => {
    insertArticle('https://x.io/blog/dateonly-old', '2026-07-01', 'none');  // 12 天前 date-only
    insertArticle('https://x.io/blog/dateonly-new', '2026-07-12', 'none');  // 1 天前 date-only
    skipStaleBeforePush(NOW);
    assert.equal(statusOf('https://x.io/blog/dateonly-old'), 'skipped_backlog');
    assert.equal(statusOf('https://x.io/blog/dateonly-new'), 'none');
    assert.equal(FRESH_WINDOW_DAYS, 7); // 老板拍的窗口值锁死
});

test('runPusher 集成 · 自动推路径先守门(陈年老文进不了推送批)', async () => {
    const { runPusher } = await import('../ops/pusher.js');
    insertArticle('https://y.io/blog/ancient-integ', '2020-01-01T00:00:00.000Z', 'none'); // 铁定超窗口
    insertArticle('https://y.io/blog/nopub-integ', '', 'none');                            // pub 空放行
    await runPusher(null, { dryOverride: true }); // 演练:不发真请求 · 但守门照跑
    assert.equal(statusOf('https://y.io/blog/ancient-integ'), 'skipped_backlog'); // 被守门拦下
    assert.equal(statusOf('https://y.io/blog/nopub-integ'), 'none');              // 放行(dry 不回写)
});

test('runPusher 集成 · 手动重推(retryUrls)豁免守门(老板拍:手动按钮不受影响)', async () => {
    const { runPusher } = await import('../ops/pusher.js');
    insertArticle('https://z.io/blog/manual-old', '2020-01-01T00:00:00.000Z', 'none');
    await runPusher(null, { retryUrls: ['https://z.io/blog/manual-old'], dryOverride: true });
    assert.equal(statusOf('https://z.io/blog/manual-old'), 'none'); // 守门没碰它(dry 不回写 → 仍 none 而非 skipped_backlog)
});
