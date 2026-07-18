// 🆕 2026-07-18 推送记录查看(老板拍):真推时存该文 item JSON + 单文结果 · 补推覆盖为最新 · dry 不写
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.OPS_DB_PATH = `storage/test-push-detail-${process.pid}.db`;

const { db } = await import('../shared/db.js');
const { markByUrl, runPusher } = await import('../ops/pusher.js');

after(() => {
    try { db().close(); } catch { /* */ }
    for (const suf of ['', '-wal', '-shm']) {
        try { rmSync(`storage/test-push-detail-${process.pid}.db${suf}`); } catch { /* */ }
    }
});

function insert(url: string, status: string): void {
    db().prepare(`INSERT INTO articles (url, token_id, base_symbol, title, published_at, crawled_at, push_status)
                  VALUES (?, 1, 'T', 'title', '2026-07-18T00:00:00.000Z', '2026-07-18T01:00:00.000Z', ?)`).run(url, status);
}
function row(url: string): { push_request: string | null; push_response: string | null; push_status: string } {
    return db().prepare(`SELECT push_request, push_response, push_status FROM articles WHERE url = ?`).get(url) as never;
}

test('markByUrl · 带 detail 时存请求/返回 JSON(推送成功场景)', () => {
    insert('https://x.io/blog/a', 'none');
    markByUrl('https://x.io/blog/a', 'pushed', undefined, {
        request: '{"blogId":"https://x.io/blog/a","title":"t"}',
        response: '{"result":"accepted","batch_size":30}',
    });
    const r = row('https://x.io/blog/a');
    assert.equal(r.push_status, 'pushed');
    assert.match(r.push_request ?? '', /blogId/);
    assert.match(r.push_response ?? '', /accepted/);
});

test('markByUrl · 拒绝场景也存(失败时能看当时发了什么)· 补推覆盖为最新', () => {
    insert('https://x.io/blog/b', 'none');
    markByUrl('https://x.io/blog/b', 'failed', 'rejected:dup', { request: '{"v":1}', response: '{"result":"rejected","reason":"dup"}' });
    assert.match(row('https://x.io/blog/b').push_response ?? '', /rejected/);
    // 补推成功 → 覆盖为最新
    markByUrl('https://x.io/blog/b', 'pushed', undefined, { request: '{"v":2}', response: '{"result":"accepted"}' });
    const r = row('https://x.io/blog/b');
    assert.match(r.push_request ?? '', /"v":2/);
    assert.match(r.push_response ?? '', /accepted/);
});

test('markByUrl · 不带 detail 时不动已存记录(兼容旧调用)', () => {
    insert('https://x.io/blog/c', 'none');
    markByUrl('https://x.io/blog/c', 'pushed', undefined, { request: '{"keep":1}', response: '{"result":"accepted"}' });
    markByUrl('https://x.io/blog/c', 'failed', 'net'); // 无 detail 的调用
    assert.match(row('https://x.io/blog/c').push_request ?? '', /keep/); // 记录保留
});

test('runPusher · dry 演练不写记录', async () => {
    insert('https://x.io/blog/d', 'none');
    await runPusher(null, { retryUrls: ['https://x.io/blog/d'], dryOverride: true });
    const r = row('https://x.io/blog/d');
    assert.equal(r.push_request, null);
    assert.equal(r.push_response, null);
});
