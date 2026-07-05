// push 对接单测(2026-07-06 officialblog API)· HMAC 签名 + item 字段映射
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { signHeaders, toIngestItem } from '../ops/pusher.js';

test('signHeaders · canonical 拼接与 HMAC 复算一致(文档 §0.2)', () => {
    const body = '{"items":[{"blogId":"x"}]}';
    const h = signHeaders('post', '/api/officialblog/messages/ingest', '', body, 'KEY1', 'SECRET1', '1700000000', 'nonce-abc');
    // 5 个头齐全
    assert.equal(h['X-API-Key'], 'KEY1');
    assert.equal(h['X-Timestamp'], '1700000000');
    assert.equal(h['X-Nonce'], 'nonce-abc');
    assert.equal(h['Content-Type'], 'application/json');
    // 独立复算 canonical 验证签名(METHOD 大写 · body sha256 · \n 拼接)
    const bodyHash = createHash('sha256').update(body).digest('hex');
    const canonical = ['POST', '/api/officialblog/messages/ingest', '', bodyHash, '1700000000', 'nonce-abc'].join('\n');
    const expected = createHmac('sha256', 'SECRET1').update(canonical).digest('hex');
    assert.equal(h['X-Signature'], expected);
    assert.equal(/^[0-9a-f]{64}$/.test(h['X-Signature']), true); // lowercase hex
});

test('signHeaders · body/nonce 变化签名必变(防重放)', () => {
    const base = signHeaders('POST', '/p', '', '{"a":1}', 'K', 'S', '100', 'n1');
    assert.notEqual(base['X-Signature'], signHeaders('POST', '/p', '', '{"a":2}', 'K', 'S', '100', 'n1')['X-Signature']); // body
    assert.notEqual(base['X-Signature'], signHeaders('POST', '/p', '', '{"a":1}', 'K', 'S', '100', 'n2')['X-Signature']); // nonce
    assert.notEqual(base['X-Signature'], signHeaders('POST', '/p', '', '{"a":1}', 'K', 'S2', '100', 'n1')['X-Signature']); // secret
});

test('toIngestItem · 字段映射(username=host · 多token合并 · 正文优先)', () => {
    const it = toIngestItem('https://www.example.com/blog/post-1', [
        { url: 'https://www.example.com/blog/post-1', token_id: 12345, base_symbol: 'EX', title: '标题', description: '摘要', body_excerpt: '真正文开头', published_at: '2026-06-29T10:00:00.000Z', crawled_at: '2026-06-29T10:01:30.000Z', push_retries: 0 },
        { url: 'https://www.example.com/blog/post-1', token_id: 678, base_symbol: 'EX2', title: '标题', description: '摘要', body_excerpt: '真正文开头', published_at: '2026-06-29T10:00:00.000Z', crawled_at: '2026-06-29T10:01:30.000Z', push_retries: 0 },
    ]);
    assert.equal(it.username, 'example.com'); // 老板拍:host · strip www
    assert.equal(it.source, 'example.com');
    assert.equal(it.blogId, 'https://www.example.com/blog/post-1'); // ≤256 用 url
    assert.equal(it.title, '标题');
    assert.equal(it.content, '真正文开头'); // body_excerpt 优先
    assert.deepEqual(it.tokenIds, [12345, 678]); // 多 token 合并
    assert.equal(it.publishedAt, '2026-06-29T10:00:00.000Z');
    assert.equal(it.collectedAt, '2026-06-29T10:01:30.000Z');
});

test('toIngestItem · 正文/时间空也发(老板:文档标必须是错的)', () => {
    const it = toIngestItem('https://x.io/blog/a', [
        { url: 'https://x.io/blog/a', token_id: 1, base_symbol: 'X', title: 'T', description: '', body_excerpt: '', published_at: '', crawled_at: '2026-01-01T00:00:00.000Z', push_retries: 0 },
    ]);
    assert.equal(it.content, ''); // 空正文照发
    assert.equal(it.publishedAt, ''); // 空时间照发
    assert.equal(it.displayName, 'X');
});

test('toIngestItem · 超长 URL 用 sha1 做 blogId(≤256 约束)', () => {
    const longUrl = 'https://x.io/blog/' + 'a'.repeat(300);
    const it = toIngestItem(longUrl, [{ url: longUrl, token_id: 1, base_symbol: 'X', title: 'T', description: '', body_excerpt: 'B', published_at: '', crawled_at: '2026-01-01T00:00:00.000Z', push_retries: 0 }]);
    assert.equal(/^[0-9a-f]{40}$/.test(it.blogId as string), true); // sha1 hex
});
