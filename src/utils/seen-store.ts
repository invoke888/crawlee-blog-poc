// 🆕 2026-07-03 RSS 流 article 级 dedupe(老板拍 a)
// 问题:RSS/substack/paragraph 每轮全量重 push · dataset 同文章每轮多一份(实测一轮翻倍)
// 方案:seen key = `${token_id}:${url}`(保 1-to-N 语义 · 同 item 多 token 各算一份)
// 单例内存 Set + KV 持久化 · 并行 crawler 同进程共享无 race · 结束时 persistSeen() 落盘
// article-detail 不用这个(RequestQueue URL 级 dedupe 已挡)
import { KeyValueStore } from 'crawlee';

const KV_KEY = 'seen-article-keys';
let seen: Set<string> | null = null;

export async function loadSeen(): Promise<void> {
    if (seen) return;
    const kv = await KeyValueStore.open('seen-articles');
    const arr = (await kv.getValue<string[]>(KV_KEY)) ?? [];
    seen = new Set(arr);
    console.log(`📦 seen-store 加载 ${seen.size} 条已见 article`);
}

export function isSeen(tokenId: number, url: string): boolean {
    return seen?.has(`${tokenId}:${url}`) ?? false;
}

export function markSeen(tokenId: number, url: string): void {
    seen?.add(`${tokenId}:${url}`);
}

export async function persistSeen(): Promise<void> {
    if (!seen) return;
    const kv = await KeyValueStore.open('seen-articles');
    await kv.setValue(KV_KEY, Array.from(seen));
    console.log(`📦 seen-store 落盘 ${seen.size} 条`);
}
