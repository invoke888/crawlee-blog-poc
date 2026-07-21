// 🆕 2026-07-21 告警清理战役规则锁(老板令:检查处理目前的告警错误)
// ME/ORBS/BANANA 固定噪音 URL exclude · RUNE AGENTS.md 文件型拦截 · 24h 空刷 ~3200 次的根治
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNonArticleFile } from '../src/utils/article-filter.js';
import { checkSourceRule } from '../src/utils/source-rules.js';

test('RUNE · .md 文件型拦截(AGENTS.md 被当文章抓 internal ×88/天 · 全库 .md 误伤=0)', () => {
    assert.equal(isNonArticleFile('https://blog.thorchain.org/AGENTS.md'), true);
    assert.equal(isNonArticleFile('https://blog.thorchain.org/real-article'), false); // 真文不误伤
});

test('ME/BANANA/ORBS · 固定噪音 URL exclude 强制生效(exclude 不看 confidence)', () => {
    assert.equal(checkSourceRule('ME', 'https://blog.mefoundation.com/showcase/'), 'reject');
    assert.equal(checkSourceRule('ME', 'https://blog.mefoundation.com/changelog/'), 'reject');
    assert.equal(checkSourceRule('BANANA', 'https://blog.bananagun.io/old-home'), 'reject');
    assert.equal(checkSourceRule('ORBS', 'https://www.orbs.com/blog/orbsftx'), 'reject');
    assert.equal(checkSourceRule('ORBS', 'https://www.orbs.com/blog/getting-ready-for-round-7-of-orbs-rewards-distribution'), 'reject');
    // 真文不误伤
    assert.notEqual(checkSourceRule('BANANA', 'https://blog.bananagun.io/blog/robinhood-chain-weekly-volume'), 'reject');
});
