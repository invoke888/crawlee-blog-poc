// 🆕 2026-07-04 代理池配置(计划书 §5.5):DB 优先 · env 兜底(向后兼容 · 裸跑不受影响)
// 消费点 3 处(main.ts / run-mirror.ts / handlers/medium.ts)全部经这里 · 漏改即"面板改了某管线没变"
import { createHash } from 'node:crypto';
import { db } from './db.js';

export type ProxyPool = 'main' | 'medium' | 'slow';
const ENV_KEY: Record<ProxyPool, string> = { main: 'PROXY_URL', medium: 'PROXY_URL_MEDIUM', slow: 'PROXY_URL_SLOW' };

export function getProxyUrl(pool: ProxyPool): string {
    try {
        const row = db().prepare('SELECT value FROM proxy_config WHERE pool = ?').get(pool) as { value?: string } | undefined;
        if (row?.value) return row.value;
    } catch { /* 表未建 → env 兜底 */ }
    return process.env[ENV_KEY[pool]] ?? '';
}

// socks5://user:pass@host:port → socks5://user:•••@host:port(GET 响应永不吐明文)
export function maskProxyUrl(url: string): string {
    return url.replace(/:\/\/([^:@/]+):([^@]+)@/, '://$1:•••@');
}

// sha256 前 12 位 · runs 表归因指纹(config_audit 哈希可 = 关联)
export function hashProxy(url: string): string {
    if (!url) return '';
    return createHash('sha256').update(url).digest('hex').slice(0, 12);
}

// 一次性 seed:.env.local 现值迁入 proxy_config(上线当天三池不显示为空 · 老板零手输)
export function seedProxyFromEnv(): void {
    const now = new Date().toISOString();
    const ins = db().prepare('INSERT OR IGNORE INTO proxy_config (pool, value, updated_at) VALUES (?, ?, ?)');
    for (const pool of ['main', 'medium', 'slow'] as ProxyPool[]) {
        const v = process.env[ENV_KEY[pool]];
        if (v) ins.run(pool, v, now);
    }
}
