// 🆕 2026-07-04 登录鉴权单测(方案 C 门厅):cookie HMAC 会话 / Basic 兼容 / 失败限速只计错误凭据
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuthGate } from '../ops/server/auth.js';

const req = (headers: { cookie?: string; authorization?: string }) => ({ headers });
const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;

test('auth · token 签发/校验/过期/篡改/换密码失效', () => {
    const a = createAuthGate('boss', 'pw');
    const t = a.issueToken();
    assert.equal(a.verifyToken(t), true);
    assert.equal(a.verifyToken(t + 'x'), false, '篡改签名必拒');
    assert.equal(a.verifyToken('123.abc'), false);
    assert.equal(a.verifyToken(''), false);
    assert.equal(a.verifyToken('nodot'), false);
    const expired = a.issueToken(Date.now() - 31 * 86_400_000);
    assert.equal(a.verifyToken(expired), false, '30 天过期必拒');
    const b = createAuthGate('boss', 'pw2');
    assert.equal(b.verifyToken(t), false, '改密码 = 旧会话全失效');
});

test('auth · cookie 优先 + Basic 兼容 + 无凭据请求永不累计锁', () => {
    const a = createAuthGate('boss', 'pw');
    const t = a.issueToken();
    assert.equal(a.checkRequest(req({ cookie: `ops_s=${t}` }), 'ip1'), true);
    assert.equal(a.checkRequest(req({ cookie: `x=1; ops_s=${t}; y=2` }), 'ip1'), true, '多 cookie 中取 ops_s');
    assert.equal(a.checkRequest(req({ authorization: basic('boss', 'pw') }), 'ip1'), true, 'curl/脚本 Basic 兼容');
    assert.equal(a.checkRequest(req({ cookie: 'ops_s=bad.token' }), 'ip1'), false);
    // 浏览器挑战-响应首发无凭据:100 次也不锁(修死锁的核心语义)
    for (let i = 0; i < 100; i++) assert.equal(a.checkRequest(req({}), 'ip2'), false);
    assert.equal(a.isLocked('ip2'), false, '无凭据请求不计失败');
    assert.equal(a.checkRequest(req({ authorization: basic('boss', 'pw') }), 'ip2'), true);
});

test('auth · 限速:5 次错误锁 60s · 锁到期计数清零不续命 · 正确即清', () => {
    const a = createAuthGate('boss', 'pw');
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) assert.equal(a.login('boss', 'wrong', 'ip3', t0), 'bad');
    assert.equal(a.login('boss', 'pw', 'ip3', t0 + 1), 'locked', '锁定期内对密码也拒(防爆破语义)');
    assert.equal(a.login('boss', 'pw', 'ip3', t0 + 61_000), 'ok', '锁到期 → 一次就进(死锁已修)');
    // 锁到期后计数清零:再错 1 次不应立即复锁
    for (let i = 0; i < 5; i++) a.login('boss', 'wrong', 'ip4', t0);
    assert.equal(a.isLocked('ip4', t0 + 30_000), true);
    assert.equal(a.isLocked('ip4', t0 + 61_000), false);
    a.login('boss', 'wrong', 'ip4', t0 + 62_000);
    assert.equal(a.isLocked('ip4', t0 + 62_001), false, '到期后 1 次错误 ≠ 复锁(不续命)');
    // Basic 错误凭据同样计数进锁
    const c = createAuthGate('boss', 'pw');
    for (let i = 0; i < 5; i++) c.checkRequest(req({ authorization: basic('boss', 'nope') }), 'ip5', t0);
    assert.equal(c.isLocked('ip5', t0 + 1), true);
    assert.equal(c.checkRequest(req({ authorization: basic('boss', 'pw') }), 'ip5', t0 + 2), false, '锁定期内 Basic 对密码也拒');
    // 未配凭据 = 拒绝一切(防裸奔)
    const z = createAuthGate('', '');
    assert.equal(z.login('a', 'b', 'ip6'), 'bad');
    assert.equal(z.checkRequest(req({ authorization: basic('', '') }), 'ip6'), false);
    assert.equal(z.verifyToken(z.issueToken()), true, 'token 机制本身仍自洽(但 checkRequest 挡住)');
});

test('auth · cookie 串格式', () => {
    const a = createAuthGate('boss', 'pw');
    const h = a.cookieHeader('tok');
    assert.match(h, /^ops_s=tok; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=2592000$/);
});
