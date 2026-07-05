// 🆕 2026-07-04 配置中心读取(计划书 §0 配置拍板):优先级 = 显式 env > app_config(DB · 面板写)> 代码默认
// 采集器每批次是新 spawn 进程 → 启动时读 DB → 面板改动下批次必然生效(物理上无"没同步")
import { db } from './db.js';

// A 类默认值(与现有代码硬编码值一一对应 · 首次启动 seed 入库供面板展示)
export const CONFIG_DEFAULTS: Record<string, { value: string; type: 'number' | 'bool' | 'string' | 'secret'; category: string; label: string }> = {
    // schedule
    crawl_interval_min: { value: '60', type: 'number', category: 'schedule', label: '采集间隔(分钟)' },
    batch_timeout_min: { value: '30', type: 'number', category: 'schedule', label: '批次超时(分钟)' },
    // concurrency(5 处硬编码点 · 审计 A1-P1-9)
    general_rpm: { value: '600', type: 'number', category: 'concurrency', label: '主力池 RPM(有代理)' },
    general_cc: { value: '20', type: 'number', category: 'concurrency', label: '主力池并发(有代理)' },
    medium_rpm: { value: '150', type: 'number', category: 'concurrency', label: 'medium 池 RPM(有代理)' },
    medium_cc: { value: '5', type: 'number', category: 'concurrency', label: 'medium 池并发(有代理)' },
    slow_rpm: { value: '60', type: 'number', category: 'concurrency', label: 'slow 池 RPM' },
    slow_cc: { value: '3', type: 'number', category: 'concurrency', label: 'slow 池并发' },
    mirror_rpm: { value: '60', type: 'number', category: 'concurrency', label: 'mirror RPM(独立键 · 不与 slow 共用)' },
    mirror_cc: { value: '3', type: 'number', category: 'concurrency', label: 'mirror 并发' },
    rss_cc: { value: '6', type: 'number', category: 'concurrency', label: 'RSS 直拉并发(worker-pool)' },
    rss_timeout_ms: { value: '25000', type: 'number', category: 'concurrency', label: 'RSS 直拉超时 ms' },
    // crawl 深度/开关
    sitemap_urls_per_source: { value: '10', type: 'number', category: 'crawl', label: '每源 sitemap 取 N 条' },
    list_enqueue_limit: { value: '30', type: 'number', category: 'crawl', label: 'LIST 每页候选上限' },
    run_mirror: { value: '0', type: 'bool', category: 'crawl', label: 'mirror 流开关' },
    skip_medium: { value: '0', type: 'bool', category: 'crawl', label: '跳过 medium 流' },
    // alerts 阈值
    error_streak_runs: { value: '2', type: 'number', category: 'alerts', label: '连续出错升告警轮数' },
    error_streak_runs_red: { value: '4', type: 'number', category: 'alerts', label: '连续出错升红色轮数' },
    list_shrink_min: { value: '5', type: 'number', category: 'alerts', label: 'list_shrink 原候选下限' },
    pipeline_drop_pct: { value: '70', type: 'number', category: 'alerts', label: '管线跌幅告警 %' },
    // push(officialblog API · HMAC 签名 · 2026-07-06 对接)
    push_enabled: { value: '0', type: 'bool', category: 'push', label: 'push 开关' },
    push_api_url: { value: '', type: 'secret', category: 'push', label: 'PUSH_API base host(如 http://124.222.33.143:9900)' },
    push_api_key: { value: '', type: 'secret', category: 'push', label: 'PUSH_API X-API-Key' },
    push_api_secret: { value: '', type: 'secret', category: 'push', label: 'PUSH_API clientSecret(HMAC 签名)' },
    push_retry_max: { value: '3', type: 'number', category: 'push', label: 'push 自动重试上限' },
    push_batch_size: { value: '200', type: 'number', category: 'push', label: 'push 每批条数(≤200)' },
};

function readDb(key: string): string | null {
    try {
        const row = db().prepare('SELECT value FROM app_config WHERE key = ?').get(key) as { value?: string } | undefined;
        return row?.value ?? null;
    } catch {
        return null; // 表未建/db 异常 → 回落(配置读取绝不拖垮调用方)
    }
}

// env 显式覆盖用大写 key(调试用 · 例:GENERAL_RPM=100)
export function cfgStr(key: string, fallback?: string): string {
    const env = process.env[key.toUpperCase()];
    if (env !== undefined && env !== '') return env;
    const dbv = readDb(key);
    if (dbv !== null && dbv !== '') return dbv;
    return fallback ?? CONFIG_DEFAULTS[key]?.value ?? '';
}

export function cfgNum(key: string, fallback?: number): number {
    const v = Number(cfgStr(key, fallback !== undefined ? String(fallback) : undefined));
    return Number.isFinite(v) ? v : (fallback ?? Number(CONFIG_DEFAULTS[key]?.value ?? 0));
}

export function cfgBool(key: string): boolean {
    return cfgStr(key) === '1' || cfgStr(key).toLowerCase() === 'true';
}

// 首次启动 seed:默认值(env 有值优先)写入 app_config 缺失行 · 面板即有完整清单
export function seedDefaults(): void {
    const now = new Date().toISOString();
    const ins = db().prepare(
        'INSERT OR IGNORE INTO app_config (key, value, value_type, category, label, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const [key, def] of Object.entries(CONFIG_DEFAULTS)) {
        const env = process.env[key.toUpperCase()];
        ins.run(key, env !== undefined && env !== '' ? env : def.value, def.type, def.category, def.label, now);
    }
}
