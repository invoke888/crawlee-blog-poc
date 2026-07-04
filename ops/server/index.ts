// 🆕 2026-07-04 运维台后端(计划书 §8.1):node:http 手写路由 · basic auth + 失败限速 · 只读 API + 写白名单
// 启动:npx tsx ops/server/index.ts(dotenv 自加载 .env.local · 不依赖启动脚本 source)
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { config as dotenvConfig } from 'dotenv';

const REPO = resolve(import.meta.dirname, '../..');
dotenvConfig({ path: resolve(REPO, '.env.local') }); // 审计 A3-P1-9:显式加载 · 消除"忘 source 裸跑无代理"

import { db } from '../../shared/db.js';
import { seedDefaults, cfgNum, CONFIG_DEFAULTS } from '../../shared/config.js';
import { getProxyUrl, maskProxyUrl, hashProxy, seedProxyFromEnv, type ProxyPool } from '../../shared/proxy-config.js';
import { testProxy } from '../../shared/proxy-test.js';
import { getScheduleState, setPaused } from '../../shared/ledger.js';
import { computeDisplayFields } from '../../src/utils/display-fields.js';
import { startScheduler } from '../scheduler.js';
import { runBatch, isRunActive } from '../run-batch.js';
import { runPusher } from '../pusher.js';
import { createAuthGate } from './auth.js';

const PORT = Number(process.env.DASH_PORT ?? 8787);
const USER = process.env.DASH_USER ?? '';
const PASS = process.env.DASH_PASS ?? '';
const PUBLIC_DIR = resolve(import.meta.dirname, 'public');

// ── 鉴权(2026-07-04 老板拍方案 C):cookie 会话 + Basic 兼容 · 逻辑在 ops/server/auth.ts(可单测)──
const auth = createAuthGate(USER, PASS);

function json(res: ServerResponse, code: number, data: unknown): void {
    const body = JSON.stringify(data);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { return {}; }
}

function audit(key: string, oldMasked: string, newMasked: string, oldHash: string, newHash: string, testResult: string, forced: boolean, ip: string): void {
    db().prepare(`INSERT INTO config_audit (config_key, old_value_masked, new_value_masked, old_value_hash, new_value_hash, test_result, saved_despite_test_failure, client_ip, at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(key, oldMasked, newMasked, oldHash, newHash, testResult, forced ? 1 : 0, ip, new Date().toISOString());
}

// ── display 切换(计划书 §4 UPSERT 铁律:API 层现算 · 复用 display-fields)──
interface ArtRow { url: string; token_id: number; base_symbol: string; title: string; h1: string; description: string; jsonld_description: string; body_excerpt: string; published_at: string; crawler: string; crawled_at: string; push_status: string; pushed_at: string | null; push_error: string | null; shared_count?: number; blog_url?: string }
function applyDisplay(rows: ArtRow[]): (ArtRow & { display_title: string; display_desc: string; desc_generic: boolean })[] {
    const tokens = [...new Set(rows.map((r) => r.token_id))];
    const groups = new Map<number, ArtRow[]>();
    for (const t of tokens) {
        groups.set(t, db().prepare('SELECT url, token_id, base_symbol, title, h1, description, jsonld_description, \'\' AS body_excerpt, published_at, crawler, crawled_at, push_status, pushed_at, push_error FROM articles WHERE token_id = ? LIMIT 200').all(t) as ArtRow[]);
    }
    const displayByKey = new Map<string, { display_title: string; display_desc: string; desc_generic: boolean }>();
    for (const [t, group] of groups) {
        const computed = computeDisplayFields(group.map((g) => ({
            title: g.title, h1: g.h1, description: g.description, jsonld_description: g.jsonld_description, source_url: g.url,
        })));
        group.forEach((g, i) => displayByKey.set(`${t}|${g.url}`, {
            display_title: computed[i].display_title, display_desc: computed[i].display_desc, desc_generic: computed[i].desc_generic,
        }));
    }
    return rows.map((r) => ({ ...r, ...(displayByKey.get(`${r.token_id}|${r.url}`) ?? { display_title: r.title, display_desc: r.description, desc_generic: false }) }));
}

// ── 路由 ──
async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || '';
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;

    // ── 免鉴权端点:登录 / 登录态探测 / 登录页壳静态资源(不含任何数据)──
    if (path === '/api/login' && req.method === 'POST') {
        const body = await readBody(req);
        const r = auth.login(String(body.user ?? ''), String(body.pass ?? ''), ip);
        if (r === 'ok') {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': auth.cookieHeader(auth.issueToken()) });
            res.end(JSON.stringify({ ok: true }));
        } else if (r === 'locked') json(res, 429, { error: 'locked', message: '错误次数太多 · 1 分钟后再试' });
        else json(res, 401, { error: 'bad_credentials', message: '账号或密码不对' });
        return;
    }
    if (path === '/api/me' && req.method === 'GET') {
        if (auth.checkRequest(req, ip)) json(res, 200, { ok: true, user: USER });
        else json(res, 401, { error: 'auth' });
        return;
    }
    const openStatic = req.method === 'GET' && (path === '/' || path === '/index.html' || path === '/style.css' || path === '/app.js');
    if (!openStatic && !auth.checkRequest(req, ip)) {
        json(res, 401, { error: 'auth', message: '未登录' }); // 不带 WWW-Authenticate:浏览器不弹原生窗 · UI 门厅接管
        return;
    }

    const d = db();
    const q = url.searchParams;

    try {
        // ═══ 只读 ═══
        if (path === '/api/summary' && req.method === 'GET') {
            const today = new Date().toISOString().slice(0, 10);
            const lastRun = d.prepare(`SELECT * FROM runs WHERE batch_type IN ('crawl','single') ORDER BY started_at DESC LIMIT 1`).get();
            const todayAdded = (d.prepare(`SELECT COALESCE(SUM(dataset_added),0) s FROM runs WHERE started_at LIKE ?`).get(`${today}%`) as { s: number }).s;
            const openAlerts = d.prepare(`SELECT severity, COUNT(*) c FROM alerts WHERE status = 'open' GROUP BY severity`).all() as { severity: string; c: number }[];
            const sourcesTotal = (d.prepare('SELECT COUNT(*) c FROM sources').get() as { c: number }).c;
            const withData = (d.prepare('SELECT COUNT(DISTINCT token_id) c FROM articles').get() as { c: number }).c;
            const pipeToday = d.prepare(`SELECT crawler, SUM(items_added) s FROM source_runs sr JOIN runs r ON r.run_id = sr.run_id WHERE r.started_at LIKE ? GROUP BY crawler ORDER BY s DESC`).all(`${today}%`);
            const daily = d.prepare(`SELECT substr(started_at,1,10) day, SUM(dataset_added) s FROM runs WHERE started_at > datetime('now','-7 day') GROUP BY day ORDER BY day`).all();
            json(res, 200, { lastRun, todayAdded, openAlerts, sourcesTotal, withData, pipeToday, daily });
            return;
        }
        if (path === '/api/schedule/state' && req.method === 'GET') {
            const st = getScheduleState('crawl');
            json(res, 200, { ...st, active: isRunActive() });
            return;
        }
        if (path === '/api/runs' && req.method === 'GET') {
            const limit = Math.min(200, Number(q.get('limit') ?? 50));
            json(res, 200, d.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?').all(limit));
            return;
        }
        const runMatch = /^\/api\/runs\/([^/]+)$/.exec(path);
        if (runMatch && req.method === 'GET') {
            const run = d.prepare('SELECT * FROM runs WHERE run_id = ?').get(runMatch[1]);
            const srs = d.prepare('SELECT * FROM source_runs WHERE run_id = ? ORDER BY items_added DESC LIMIT 100').all(runMatch[1]);
            const errSummary = d.prepare('SELECT kind, COUNT(*) c FROM crawl_errors WHERE run_id = ? GROUP BY kind').all(runMatch[1]);
            json(res, 200, { run, source_runs: srs, error_summary: errSummary });
            return;
        }
        if (path === '/api/alerts' && req.method === 'GET') {
            const status = q.get('status') ?? 'open';
            const rows = status === 'all'
                ? d.prepare('SELECT * FROM alerts ORDER BY alert_id DESC LIMIT 300').all()
                : d.prepare('SELECT * FROM alerts WHERE status = ? ORDER BY alert_id DESC LIMIT 300').all(status);
            json(res, 200, rows);
            return;
        }
        if (path === '/api/sources' && req.method === 'GET') {
            // 🆕 2026-07-04 老板拍:最近一条博文完整度(title/正文/pub)+ 最近发布时间 + 博文总数(窗口取每源最新一条)
            const rows = d.prepare(`
                SELECT s.token_id, s.base_symbol, s.blog_url, s.host_platform, s.last_article_at,
                       (SELECT COALESCE(SUM(sr.items_added),0) FROM source_runs sr JOIN runs r ON r.run_id = sr.run_id
                        WHERE sr.token_id = s.token_id AND r.started_at > datetime('now','-7 day')) AS added_7d,
                       (SELECT sr.failed FROM source_runs sr JOIN runs r ON r.run_id = sr.run_id
                        WHERE sr.token_id = s.token_id ORDER BY r.started_at DESC LIMIT 1) AS last_failed,
                       (SELECT sr.requests FROM source_runs sr JOIN runs r ON r.run_id = sr.run_id
                        WHERE sr.token_id = s.token_id ORDER BY r.started_at DESC LIMIT 1) AS last_requests,
                       (SELECT sr.crawler FROM source_runs sr WHERE sr.token_id = s.token_id ORDER BY sr.run_id DESC LIMIT 1) AS crawler,
                       (SELECT COUNT(*) FROM alerts a WHERE a.token_id = s.token_id AND a.status = 'open' AND a.severity = 'red') AS red_alerts,
                       (SELECT COUNT(*) FROM alerts a WHERE a.token_id = s.token_id AND a.status = 'open' AND a.severity = 'yellow') AS yellow_alerts,
                       COALESCE(la.articles_total, 0) AS articles_total,
                       la.latest_pub_at,
                       la.latest_title_ok, la.latest_body_ok, la.latest_pub_ok
                FROM sources s
                LEFT JOIN (
                    -- 2026-07-05 老板抓 bug:完整度改"最近采集 3 条全部齐"口径(原来只看发布时间最新一条 · 与浮窗所见断层)
                    SELECT token_id,
                           MAX(articles_total) AS articles_total,
                           MAX(NULLIF(published_at, '')) AS latest_pub_at,
                           MIN(CASE WHEN title != '' THEN 1 ELSE 0 END) AS latest_title_ok,
                           MIN(CASE WHEN COALESCE(NULLIF(body_excerpt,''), NULLIF(description,'')) IS NOT NULL THEN 1 ELSE 0 END) AS latest_body_ok,
                           MIN(CASE WHEN published_at != '' THEN 1 ELSE 0 END) AS latest_pub_ok
                    FROM (
                        SELECT token_id, title, body_excerpt, description, published_at,
                               COUNT(*) OVER (PARTITION BY token_id) AS articles_total,
                               ROW_NUMBER() OVER (PARTITION BY token_id ORDER BY crawled_at DESC) AS rn
                        FROM articles
                    ) WHERE rn <= 3 GROUP BY token_id
                ) la ON la.token_id = s.token_id
                ORDER BY s.last_article_at DESC NULLS LAST
            `).all();
            json(res, 200, rows);
            return;
        }
        const srcMatch = /^\/api\/sources\/(\d+)$/.exec(path);
        if (srcMatch && req.method === 'GET') {
            const tokenId = Number(srcMatch[1]);
            const source = d.prepare('SELECT * FROM sources WHERE token_id = ?').get(tokenId);
            const runs30 = d.prepare(`SELECT sr.*, r.started_at FROM source_runs sr JOIN runs r ON r.run_id = sr.run_id WHERE sr.token_id = ? ORDER BY r.started_at DESC LIMIT 30`).all(tokenId);
            const arts = d.prepare('SELECT url, title, description, body_excerpt, published_at, crawled_at, crawler, push_status FROM articles WHERE token_id = ? ORDER BY COALESCE(NULLIF(published_at,\'\'), crawled_at) DESC LIMIT 10').all(tokenId);
            const alertHist = d.prepare('SELECT * FROM alerts WHERE token_id = ? ORDER BY alert_id DESC LIMIT 20').all(tokenId);
            const errs = d.prepare('SELECT * FROM crawl_errors WHERE token_id = ? ORDER BY err_id DESC LIMIT 20').all(tokenId);
            json(res, 200, { source, runs30, articles: arts, alerts: alertHist, errors: errs });
            return;
        }
        if (path === '/api/articles' && req.method === 'GET') {
            const page = Math.max(1, Number(q.get('page') ?? 1));
            const per = 50;
            const conds: string[] = []; const params: unknown[] = [];
            const kw = q.get('q');
            if (kw) { conds.push('(title LIKE ? OR description LIKE ? OR body_excerpt LIKE ?)'); params.push(`%${kw}%`, `%${kw}%`, `%${kw}%`); }
            const sym = q.get('symbol');
            if (sym) { conds.push('base_symbol LIKE ?'); params.push(`%${sym}%`); }
            const crawler = q.get('crawler');
            if (crawler) { conds.push('crawler = ?'); params.push(crawler); }
            const push = q.get('push');
            if (push) { conds.push('push_status = ?'); params.push(push); }
            if (q.get('pub_from')) { conds.push('published_at >= ?'); params.push(q.get('pub_from')); }
            if (q.get('pub_to')) { conds.push('published_at <= ?'); params.push(q.get('pub_to') + 'T23:59:59'); }
            if (q.get('crawled_from')) { conds.push('crawled_at >= ?'); params.push(q.get('crawled_from')); }
            if (q.get('crawled_to')) { conds.push('crawled_at <= ?'); params.push(q.get('crawled_to') + 'T23:59:59'); }
            const fields = q.get('fields'); // 字段完整度筛选(2026-07-05 老板抓口径:与显示列一致 · 正文=body_excerpt||description)
            if (fields === 'no_title') conds.push("(title IS NULL OR title = '')");
            if (fields === 'no_desc') conds.push("(COALESCE(body_excerpt,'') = '' AND COALESCE(description,'') = '')");
            if (fields === 'no_pub') conds.push("(published_at IS NULL OR published_at = '')");
            if (fields === 'full') conds.push("(title != '' AND (COALESCE(body_excerpt,'') != '' OR COALESCE(description,'') != '') AND COALESCE(published_at,'') != '')");
            const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
            const total = (d.prepare(`SELECT COUNT(*) c FROM articles ${where}`).get(...params) as { c: number }).c;
            const rows = d.prepare(`
                SELECT url, token_id, base_symbol, title, h1, description, jsonld_description, body_excerpt,
                       published_at, crawler, crawled_at, push_status, pushed_at, push_error,
                       COUNT(*) OVER (PARTITION BY url) AS shared_count,
                       (SELECT s.blog_url FROM sources s WHERE s.token_id = articles.token_id) AS blog_url
                FROM articles ${where}
                ORDER BY COALESCE(NULLIF(published_at,''), crawled_at) DESC LIMIT ? OFFSET ?
            `).all(...params, per, (page - 1) * per) as ArtRow[];
            json(res, 200, { total, page, per, rows: applyDisplay(rows) });
            return;
        }
        if (path === '/api/articles/detail' && req.method === 'GET') {
            const aUrl = q.get('url') ?? ''; const tokenId = Number(q.get('token_id') ?? 0);
            const art = d.prepare('SELECT * FROM articles WHERE url = ? AND token_id = ?').get(aUrl, tokenId) as Record<string, unknown> | undefined;
            if (!art) { json(res, 404, { error: 'not found' }); return; }
            // reset 前旧文 body_excerpt 可能为空且 raw-html 已清 → 显式标记(审计 A1-P1-7)
            json(res, 200, { ...art, full_text_available: !!(art.body_excerpt as string)?.length });
            return;
        }
        if (path === '/api/errors' && req.method === 'GET') {
            const page = Math.max(1, Number(q.get('page') ?? 1));
            const conds: string[] = []; const params: unknown[] = [];
            if (q.get('run')) { conds.push('run_id = ?'); params.push(q.get('run')); }
            if (q.get('kind')) { conds.push('kind = ?'); params.push(q.get('kind')); }
            if (q.get('q')) { conds.push('(base_symbol LIKE ? OR url LIKE ?)'); params.push(`%${q.get('q')}%`, `%${q.get('q')}%`); }
            const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
            const dist = d.prepare(`SELECT kind, COUNT(*) c FROM crawl_errors ${where} GROUP BY kind ORDER BY c DESC`).all(...params);
            const rows = d.prepare(`SELECT * FROM crawl_errors ${where} ORDER BY err_id DESC LIMIT 100 OFFSET ?`).all(...params, (page - 1) * 100);
            json(res, 200, { dist, rows, page });
            return;
        }
        if (path === '/api/proxy-config' && req.method === 'GET') {
            const pools = (['main', 'medium', 'slow'] as ProxyPool[]).map((pool) => {
                const row = d.prepare('SELECT * FROM proxy_config WHERE pool = ?').get(pool) as Record<string, unknown> | undefined;
                const effective = getProxyUrl(pool);
                return {
                    pool, configured: !!row,
                    masked: effective ? maskProxyUrl(effective) : '',
                    follows_main: pool !== 'main' && !!effective && effective === getProxyUrl('main') && !row,
                    updated_at: row?.updated_at ?? null,
                    last_test_at: row?.last_test_at ?? null, last_test_ok: row?.last_test_ok ?? null,
                    last_test_egress_ip: row?.last_test_egress_ip ?? null, last_test_latency_ms: row?.last_test_latency_ms ?? null,
                };
            });
            json(res, 200, pools);
            return;
        }
        if (path === '/api/proxy-config/audit' && req.method === 'GET') {
            json(res, 200, d.prepare('SELECT * FROM config_audit ORDER BY audit_id DESC LIMIT 20').all());
            return;
        }
        if (path === '/api/app-config' && req.method === 'GET') {
            json(res, 200, d.prepare('SELECT key, value, value_type, category, label, updated_at FROM app_config ORDER BY category, key').all()
                .map((r) => (r as { value_type: string; value: string; key: string }).value_type === 'secret' ? { ...(r as object), value: (r as { value: string }).value ? '•••' : '' } : r));
            return;
        }
        if (path === '/api/rules-version' && req.method === 'GET') {
            const { execSync } = await import('node:child_process');
            let commit = '';
            try { commit = execSync('git rev-parse --short HEAD', { cwd: REPO }).toString().trim(); } catch { /* */ }
            json(res, 200, { git_commit: commit });
            return;
        }

        // ═══ 写白名单(计划书 §0-A)═══
        const ackMatch = /^\/api\/alerts\/(\d+)\/ack$/.exec(path);
        if (ackMatch && req.method === 'POST') {
            d.prepare(`UPDATE alerts SET status = 'ack' WHERE alert_id = ? AND status = 'open'`).run(Number(ackMatch[1]));
            json(res, 200, { ok: true });
            return;
        }
        if (path === '/api/schedule/trigger' && req.method === 'POST') {
            if (isRunActive()) { json(res, 409, { error: 'busy', message: '当前有批次在跑,请稍后' }); return; }
            const body = await readBody(req);
            void runBatch({ trigger: 'manual', onlySymbols: (body.only_symbols as string) || undefined });
            json(res, 200, { ok: true, message: '批次已触发' });
            return;
        }
        const recrawlMatch = /^\/api\/sources\/(\d+)\/recrawl$/.exec(path);
        if (recrawlMatch && req.method === 'POST') {
            if (isRunActive()) { json(res, 409, { error: 'busy' }); return; }
            const sym = (d.prepare('SELECT base_symbol FROM sources WHERE token_id = ?').get(Number(recrawlMatch[1])) as { base_symbol?: string } | undefined)?.base_symbol;
            if (!sym) { json(res, 404, { error: 'unknown token' }); return; }
            void runBatch({ trigger: 'manual', onlySymbols: sym });
            json(res, 200, { ok: true, message: `单源重采 ${sym} 已触发` });
            return;
        }
        if (path === '/api/schedule/pause' && req.method === 'POST') { setPaused('crawl', true); json(res, 200, { ok: true }); return; }
        if (path === '/api/schedule/resume' && req.method === 'POST') { setPaused('crawl', false); json(res, 200, { ok: true }); return; }
        if (path === '/api/push/retry' && req.method === 'POST') {
            const body = await readBody(req);
            const urls = (body.urls as string[]) ?? [];
            if (!urls.length) { json(res, 400, { error: 'urls required' }); return; }
            const r = await runPusher(null, { retryUrls: urls });
            json(res, 200, r);
            return;
        }
        const proxyTestMatch = /^\/api\/proxy-config\/(main|medium|slow)\/test$/.exec(path);
        if (proxyTestMatch && req.method === 'POST') {
            const pool = proxyTestMatch[1] as ProxyPool;
            const body = await readBody(req);
            const candidate = (body.value as string) || getProxyUrl(pool);
            if (!candidate) { json(res, 400, { error: 'no value' }); return; }
            const r = await testProxy(candidate);
            d.prepare(`UPDATE proxy_config SET last_test_at = ?, last_test_ok = ?, last_test_egress_ip = ?, last_test_latency_ms = ? WHERE pool = ?`)
                .run(new Date().toISOString(), r.ok ? 1 : 0, r.ip ?? null, r.latencyMs ?? null, pool);
            json(res, 200, r);
            return;
        }
        const proxyPutMatch = /^\/api\/proxy-config\/(main|medium|slow)$/.exec(path);
        if (proxyPutMatch && req.method === 'PUT') {
            const pool = proxyPutMatch[1] as ProxyPool;
            const body = await readBody(req);
            const value = (body.value as string) ?? '';
            const force = body.force === true;
            if (!/^socks5:\/\/.+@.+:\d+$/.test(value) && !/^https?:\/\/.+/.test(value)) {
                json(res, 422, { error: 'format', message: '连接串格式不对(socks5://user:pass@host:port)' });
                return;
            }
            const test = await testProxy(value); // 软阻断:自动测试
            if (!test.ok && !force) {
                json(res, 422, { error: 'test_failed', test, message: '连通测试未通过 · 确认仍要保存请带 force:true' });
                return;
            }
            const old = getProxyUrl(pool);
            d.prepare(`INSERT INTO proxy_config (pool, value, updated_at, updated_by_ip, last_test_at, last_test_ok, last_test_egress_ip, last_test_latency_ms)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT(pool) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by_ip = excluded.updated_by_ip,
                           last_test_at = excluded.last_test_at, last_test_ok = excluded.last_test_ok,
                           last_test_egress_ip = excluded.last_test_egress_ip, last_test_latency_ms = excluded.last_test_latency_ms`)
                .run(pool, value, new Date().toISOString(), ip, new Date().toISOString(), test.ok ? 1 : 0, test.ip ?? null, test.latencyMs ?? null);
            audit(`proxy.${pool}`, maskProxyUrl(old), maskProxyUrl(value), hashProxy(old), hashProxy(value), test.ok ? 'pass' : 'fail', !test.ok && force, ip);
            json(res, 200, { ok: true, test, message: '已保存 · 下次批次生效(当前批次不受影响)' });
            return;
        }
        if (path === '/api/app-config' && req.method === 'PUT') {
            const body = await readBody(req);
            const key = body.key as string; const value = String(body.value ?? '');
            if (!key || !(key in CONFIG_DEFAULTS)) { json(res, 400, { error: 'unknown key' }); return; }
            const def = CONFIG_DEFAULTS[key];
            if (def.type === 'number' && !Number.isFinite(Number(value))) { json(res, 422, { error: 'not a number' }); return; }
            const old = (d.prepare('SELECT value FROM app_config WHERE key = ?').get(key) as { value?: string } | undefined)?.value ?? '';
            d.prepare(`INSERT INTO app_config (key, value, value_type, category, label, updated_at) VALUES (?, ?, ?, ?, ?, ?)
                       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
                .run(key, value, def.type, def.category, def.label, new Date().toISOString());
            const mask = (v: string) => def.type === 'secret' ? (v ? '•••' : '') : v;
            audit(`app.${key}`, mask(old), mask(value), '', '', 'n/a', false, ip);
            json(res, 200, { ok: true, message: '已保存 · 下次批次/tick 生效' });
            return;
        }

        // ═══ 静态文件 ═══
        const file = path === '/' ? '/index.html' : path;
        const fp = resolve(PUBLIC_DIR, `.${file}`);
        if (fp.startsWith(PUBLIC_DIR) && existsSync(fp)) {
            const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
            res.writeHead(200, { 'Content-Type': mime[extname(fp)] ?? 'application/octet-stream' });
            res.end(readFileSync(fp));
            return;
        }
        json(res, 404, { error: 'not found' });
    } catch (e) {
        console.error(`⚠️ API ${path} 异常:`, (e as Error).message);
        json(res, 500, { error: 'internal', message: (e as Error).message?.slice(0, 200) });
    }
}

// ── 启动 ──
seedDefaults();
seedProxyFromEnv();
startScheduler();
createServer((req, res) => { void handle(req, res); }).listen(PORT, () => {
    console.log(`🖥️ 运维台已启动 · http://0.0.0.0:${PORT} · 调度内置 · interval ${cfgNum('crawl_interval_min', 60)}min`);
});
