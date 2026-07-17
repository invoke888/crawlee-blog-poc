// 🆕 2026-07-17 TWT 日期规则修复(老板拍 A):spa_only 误判解除 · 站方改版后 meta/jsonld 双层有真发布日
// 背景:07-05 判 spa_only(显式放弃)→ pub 永远空 → 守门 pub 空放行 → 站方 07-17 刷新 643 条老文 lastmod
// → 58 条 2024 老文当新文推送实锤。实测两篇(2024老文/2026新文)meta article:published_time 与 jsonld
// datePublished 一致且互异 = 真字段非构建戳 → 删 date 规则走默认梯队即根治
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { extractPublishedAt, rulesFor } from '../src/utils/date-extract.js';

type FixtureCheerioAPI = Parameters<typeof extractPublishedAt>[0];
const load = (html: string): FixtureCheerioAPI => cheerio.load(html) as unknown as FixtureCheerioAPI;

// 真页面结构还原(2026-07-17 curl trust-wallet-launchpool-faq 实测):meta 层与 jsonld 层同值
const TWT_2024_OLD_ARTICLE = `<html><head>
  <meta property="article:published_time" content="Oct 12, 2024"/>
  <meta property="article:modified_time" content="Jul 17, 2026"/>
  <script type="application/ld+json">{"@type":"BlogPosting","datePublished":"2024-10-12T10:38:32.650Z","dateModified":"2026-07-17T14:32:45.019Z"}</script>
  </head><body></body></html>`;

test('TWT · 规则库不再 spa_only(spa_only 会让 pub 永远空 · 守门盲区根因)', () => {
    const r = rulesFor('https://trustwallet.com/blog/company/trust-wallet-launchpool-faq');
    assert.notEqual(r?.date?.strategy, 'spa_only'); // 防未来把 spa_only 加回去
});

test('TWT · 默认梯队从真页面结构抽出 2024 发布日(守门由此拦住迟到首采老文)', () => {
    const r = rulesFor('https://trustwallet.com/blog/company/trust-wallet-launchpool-faq');
    const v = extractPublishedAt(load(TWT_2024_OLD_ARTICLE), 'https://trustwallet.com/blog/company/trust-wallet-launchpool-faq', r?.date ?? null);
    assert.match(v, /Oct 12, 2024|2024-10-12/); // meta 层先命中英文格式或 jsonld ISO 均可 · normalize 后同日
});
