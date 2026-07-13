// 🆕 2026-07-13 存储根源改造(老板拍):DETAIL 去重记忆从 request_queues 文件堆迁到账本
// 背景:queue 持久 dedupe 靠几万个 JSON 文件,5 天把批次从 4.4min 拖到 15min 超时连环(逐日 +1min 实锤)
// 账本(articles 表)本就是"抓过什么"的权威记忆,SQLite 索引查询不随量变慢
// 效果:queue 每轮 drop 重建不再积累 · 删行重收不再依赖 reset(行删了自然重抓)
import { db } from '../registry/db.js';

let known: Set<string> | null = null;

// main.ts 启动时调用一次(与 queue drop 配套 · url 级=与旧 queue uniqueKey 同语义)
export function loadKnownUrls(): number {
    try {
        const rows = db().prepare('SELECT DISTINCT url FROM articles').all() as { url: string }[];
        known = new Set(rows.map((r) => r.url));
    } catch {
        known = new Set(); // 账本不可用 → 全量重抓(宁重复不漏 · upsert 幂等)
    }
    return known.size;
}

export function isKnownUrl(url: string): boolean {
    return known?.has(url) ?? false;
}
