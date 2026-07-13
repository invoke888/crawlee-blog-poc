// 🆕 2026-07-04 reset 固化脚本(计划书 §2 · 审计 A1/A2 P0:禁止现场自由解读"清 storage"手打 rm)
// 精确范围 = 三个子目录 · 绝不碰 storage/sources.db(registry+账本+articles 不可重建)
// 用法: npx tsx ops/reset.ts --confirm
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { db } from '../shared/db.js';

const REPO = resolve(import.meta.dirname, '..');
const TARGETS = ['storage/datasets', 'storage/request_queues', 'storage/key_value_stores'];

if (process.argv[2] !== '--confirm') {
    console.log('reset 范围(仅此三项 · sources.db 不动):');
    for (const t of TARGETS) console.log(`  - ${t}`);
    console.log('确认执行:npx tsx ops/reset.ts --confirm');
    process.exit(0);
}

for (const t of TARGETS) {
    rmSync(resolve(REPO, t), { recursive: true, force: true });
    console.log(`🗑️ 已清 ${t}`);
}
// 下一轮批次标记 is_after_reset(detector 跳过环比误报)
db().prepare(`INSERT OR REPLACE INTO app_config (key, value, value_type, category, label, updated_at)
              VALUES ('pending_reset_flag', '1', 'bool', 'schedule', '下一批次标 is_after_reset', ?)`).run(new Date().toISOString());
// 🆕 2026-07-13:清回填高水位 → reset 后首轮必跑全量回填(规则升级补旧行的主场景)
db().prepare(`DELETE FROM app_config WHERE key = 'last_backfill_at'`).run();
console.log('✅ reset 完成 · sources.db(账本/articles)保留 · 下一批次将标 is_after_reset');
process.exit(0);
