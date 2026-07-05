// 🆕 2026-07-06 push API 连通性测试 · 真推几篇看 API 响应(不依赖 push_enabled · dryOverride:false 强制真推)
// 用法:npx tsx ops/push-test.ts [url1 url2 ...]  · 不给 url 则取最近 5 篇有正文的
import { runPusher } from './pusher.js';
import { db } from '../shared/db.js';

const args = process.argv.slice(2);
let targets = args;
if (!targets.length) {
    targets = (db().prepare(
        `SELECT url FROM articles WHERE body_excerpt != '' AND title != '' AND published_at != '' ORDER BY crawled_at DESC LIMIT 5`,
    ).all() as { url: string }[]).map((r) => r.url);
}
console.log(`🧪 测试推送 ${targets.length} 篇:`);
for (const u of targets) console.log('   ·', u);
const r = await runPusher(null, { retryUrls: targets, dryOverride: false });
console.log('\n📊 结果:', JSON.stringify(r));
console.log(r.ok > 0 && r.failed === 0 && r.rejected === 0 ? '✅ API 连通 · 全部 accepted' : '⚠️ 有失败/拒收 · 查 push_error');
