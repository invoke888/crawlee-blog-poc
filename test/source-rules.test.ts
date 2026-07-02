// per-source 规则单测 · 2026-07-03 17 agent 审计落地
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSourceRule, checkSourceRuleMulti } from '../src/utils/source-rules.js';

test('checkSourceRule · 高置信前缀强制(agent 审计实锤源)', () => {
    // PYTH /blog/ high(chunk7)
    assert.equal(checkSourceRule('PYTH', 'https://www.pyth.network/blog/some-post'), 'pass');
    assert.equal(checkSourceRule('PYTH', 'https://www.pyth.network/mediaroom'), 'reject');
    // 无规则源放行
    assert.equal(checkSourceRule('NOSUCHSYM', 'https://x.com/anything'), 'no-rule');
});

test('checkSourceRule · 段级前缀不误吃(STORJ /blog vs /blog-posts 教训)', () => {
    // STORJ include /blog/(chunk9 high)
    assert.equal(checkSourceRule('STORJ', 'https://www.storj.io/blog/a-post'), 'pass');
    assert.equal(checkSourceRule('STORJ', 'https://www.storj.io/blog-posts/all'), 'reject');
    assert.equal(checkSourceRule('STORJ', 'https://www.storj.io/blog'), 'pass'); // 裸列表页也算 pattern 内
});

test('checkSourceRule · exclude 语言变体先判(TAC 实锤)', () => {
    // TAC include /blog/ · exclude /es/ /ko/ /ru/ /zh/(chunk15 high)
    assert.equal(checkSourceRule('TAC', 'https://tac.build/blog/real-post'), 'pass');
    assert.equal(checkSourceRule('TAC', 'https://tac.build/es/blog/real-post'), 'reject');
});

test('checkSourceRuleMulti · 共用 sitemap 多 token(任一 pass 即放行)', () => {
    assert.equal(checkSourceRuleMulti(['PYTH', 'NOSUCHSYM'], 'https://www.pyth.network/mediaroom'), true); // NOSUCHSYM no-rule 放行
    assert.equal(checkSourceRuleMulti(['PYTH'], 'https://www.pyth.network/mediaroom'), false); // 唯一规则 reject
    assert.equal(checkSourceRuleMulti([], 'https://anything.com/x'), true); // 空 = 放行
});
