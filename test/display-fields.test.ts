// 🆕 2026-07-03 e 项单测:title/desc 智能切换(python aggregate-report.py 复刻同语义 · 语义变更两边同步)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDisplayFields } from '../src/utils/display-fields.js';

const bchLike = (i: number) => ({
    title: 'Bitcoin Cash Node',
    h1: `BCHN v29.${i}.0 版本发布公告`,
    description: 'The Bitcoin Cash Node project.',
    jsonld_description: '',
    source_url: 'https://bitcoincashnode.org/en/newsroom',
});

test('display · BCH 型群体复读:title 全同 + h1 各异 → 切 h1', () => {
    const out = computeDisplayFields([bchLike(1), bchLike(2), bchLike(3), bchLike(4)]);
    assert.equal(out[0].display_title, 'BCHN v29.1.0 版本发布公告');
    assert.equal(out[3].display_title, 'BCHN v29.4.0 版本发布公告');
});

test('display · 非复读多条:title 不动', () => {
    const arts = [
        { title: 'Post A', h1: 'A 真标题', source_url: 'https://x.com/blog' },
        { title: 'Post B', h1: 'B 真标题', source_url: 'https://x.com/blog' },
        { title: 'Post C', h1: 'C 真标题', source_url: 'https://x.com/blog' },
    ];
    const out = computeDisplayFields(arts);
    assert.equal(out[0].display_title, 'Post A');
});

test('display · title 复读但 h1 也复读 → 不切(没有更好的)', () => {
    const arts = Array.from({ length: 4 }, () => ({
        title: 'Site Name',
        h1: 'Same H1',
        source_url: 'https://y.com/blog',
    }));
    const out = computeDisplayFields(arts);
    assert.equal(out[0].display_title, 'Site Name');
});

test('display · <3 条不触发群体判定 · 但单条站名信号仍切(BCH 单条也中)', () => {
    const out = computeDisplayFields([bchLike(9)]); // title 归一 == bitcoincashnode(host 注册名)
    assert.equal(out[0].display_title, 'BCHN v29.9.0 版本发布公告');
    // 非站名的单条不切
    const out2 = computeDisplayFields([{ title: 'A Real Title', h1: 'Other', source_url: 'https://z.org/blog' }]);
    assert.equal(out2[0].display_title, 'A Real Title');
});

test('display · desc 群体复读:有合格 jsonld → 换 · 无 → 原值 + generic 标记', () => {
    const mk = (jd: string) => Array.from({ length: 3 }, (_, i) => ({
        title: `Post ${i}`,
        h1: '',
        description: 'Ripple is the leading blockchain payments company.',
        jsonld_description: jd,
        source_url: 'https://ripple.com/insights',
    }));
    const withJd = computeDisplayFields(mk('This article explains the new escrow mechanism in detail.'));
    assert.equal(withJd[0].display_desc, 'This article explains the new escrow mechanism in detail.');
    assert.equal(withJd[0].desc_generic, false);
    const noJd = computeDisplayFields(mk(''));
    assert.equal(noJd[0].display_desc, 'Ripple is the leading blockchain payments company.');
    assert.equal(noJd[0].desc_generic, true);
});
