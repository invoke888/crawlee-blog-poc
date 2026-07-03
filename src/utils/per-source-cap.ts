// 🆕 2026-07-03 自测模式:每源(token)最多入库 N 条 · MAX_ARTICLES_PER_SOURCE env 控制
// 语义:push 侧计数(入口仍多取候选 · 防第 1 条被 DETAIL 双保险拦掉后源挂零)
// 不设 / 设 0 = 不限(生产默认行为不变)
const MAX = Number(process.env.MAX_ARTICLES_PER_SOURCE ?? 0);
const counts = new Map<number, number>();

export function underSourceCap(tokenId: number | undefined): boolean {
    if (!MAX || tokenId == null) return true;
    return (counts.get(tokenId) ?? 0) < MAX;
}

export function countSourcePush(tokenId: number | undefined): void {
    if (!MAX || tokenId == null) return;
    counts.set(tokenId, (counts.get(tokenId) ?? 0) + 1);
}
