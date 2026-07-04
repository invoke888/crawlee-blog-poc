// 🆕 2026-07-04 采集器埋点 counter(计划书 §4):进程内累计 · 轮末经 ledger.flushRun 落库
// 本模块只做内存计数,零 IO 零依赖 — 裸跑也可无条件运行(落不落库由 flushRun 的 RUN_ID 网关决定)
import type { CrawlErrorRow } from './types.js';

export type StatKey =
    | 'items_added' | 'requests' | 'failed'
    | 'http_403' | 'http_404' | 'http_429' | 'timeout' | 'proxy_error'
    | 'blocked_noise' | 'blocked_external' | 'blocked_error_page'
    | 'list_candidates' | 'feed_items';

export interface SourceStat {
    token_id: number;
    base_symbol: string;
    crawler: string;
    counts: Partial<Record<StatKey, number>>;
}

const bySource = new Map<number, SourceStat>();
const errors: CrawlErrorRow[] = [];
let requestsTotal = 0;
let requestsFailed = 0;

export function statCount(tokenId: number | undefined, symbol: string | undefined, crawler: string, key: StatKey, n = 1): void {
    if (tokenId == null) return;
    let s = bySource.get(tokenId);
    if (!s) {
        s = { token_id: tokenId, base_symbol: symbol ?? '', crawler, counts: {} };
        bySource.set(tokenId, s);
    }
    if (!s.crawler && crawler) s.crawler = crawler;
    s.counts[key] = (s.counts[key] ?? 0) + n;
}

export function statSet(tokenId: number | undefined, symbol: string | undefined, crawler: string, key: StatKey, v: number): void {
    if (tokenId == null) return;
    let s = bySource.get(tokenId);
    if (!s) {
        s = { token_id: tokenId, base_symbol: symbol ?? '', crawler, counts: {} };
        bySource.set(tokenId, s);
    }
    s.counts[key] = v;
}

export function statRequest(failed: boolean): void {
    requestsTotal += 1;
    if (failed) requestsFailed += 1;
}

export function recordError(e: CrawlErrorRow): void {
    errors.push(e);
}

export function snapshotStats(): { sources: SourceStat[]; errors: CrawlErrorRow[]; requestsTotal: number; requestsFailed: number } {
    return { sources: [...bySource.values()], errors: [...errors], requestsTotal, requestsFailed };
}
