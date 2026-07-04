// 🆕 2026-07-04 批次执行(计划书 §5.1):调度 tick 与手动触发共用唯一入口 runBatch()
// 占位(SQLite 原子)→ spawn 采集器 → 超时(SIGTERM→SIGKILL)→ 收割 articles + 补漏 → detector → pusher
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { db } from '../shared/db.js';
import {
    claimRunSlot, recordSkippedOverlap, finishRun, advanceNextRun,
    upsertArticles, knownArticleKeys, refreshLastArticleAt, cleanupOldErrors, type ArticleInput,
} from '../shared/ledger.js';
import { cfgNum } from '../shared/config.js';
import { getProxyUrl, hashProxy } from '../shared/proxy-config.js';
import { isNoiseUrl, isNonArticleFile, isLandingUrl, isBlockedSubdomainUrl, hostOfUrl, isWhitelistedArticleUrl } from '../src/utils/article-filter.js';
import { runDetector } from './detector.js';
import { runPusher } from './pusher.js';

const REPO = resolve(import.meta.dirname, '..');
const LOGS_DIR = resolve(REPO, 'storage/logs');
const DATASET_DIR = resolve(REPO, 'storage/datasets/default');

let activeChild: ChildProcess | null = null;
export const isRunActive = (): boolean => activeChild !== null;

function gitCommit(): string {
    try { return execSync('git rev-parse --short HEAD', { cwd: REPO }).toString().trim(); } catch { return ''; }
}

// dataset 收割 + 补漏扫描(计划书 §3:兜住裸跑产物与崩溃窗口 · 两份真相自动收敛)
function harvestArticles(runId: string | null): { added: number; sourcesWithNew: number } {
    let files: string[] = [];
    try { files = readdirSync(DATASET_DIR).filter((f) => f.endsWith('.json')); } catch { return { added: 0, sourcesWithNew: 0 }; }
    const known = knownArticleKeys();
    const fresh: ArticleInput[] = [];
    // 🆕 2026-07-04 收敛轮实锤:known 行整体 skip 导致抽取器升级后旧行空字段永不自愈(ondo body 回填失败根因)
    // known 行也走同款过滤后 upsert(COALESCE 只补空字段 · 不覆盖非空)· 不计入本批新增
    const refresh: ArticleInput[] = [];
    for (const f of files) {
        try {
            const d = JSON.parse(readFileSync(resolve(DATASET_DIR, f), 'utf-8')) as Record<string, unknown>;
            const url = (d.url as string) ?? '';
            const tokenId = d.token_id as number;
            if (!url || tokenId == null) continue;
            const row: ArticleInput = {
                url, token_id: tokenId, base_symbol: (d.base_symbol as string) ?? '',
                title: (d.title as string) ?? '', h1: (d.h1 as string) ?? '',
                description: (d.description as string) ?? '',
                jsonld_description: (d.jsonld_description as string) ?? '',
                body_excerpt: (d.body_excerpt as string) ?? '',
                published_at: (d.published_at as string) || (d.publishedTime as string) || '',
                crawler: (d.crawler as string) ?? '', crawled_at: (d.crawledAt as string) ?? '',
            };
            if (known.has(`${tokenId}|${url}`)) refresh.push(row);
            else fresh.push(row);
        } catch { /* 单文件坏不拖垮收割 */ }
    }
    // 🆕 2026-07-04 质量战役:收割层同款过滤(与 pusher/聚合三层同一语义 · 修 DIA use-cases 类垃圾进账本根因)
    // 层级:noise/文件型/landing(白名单优先)→ 黑子域(与源 blog_url host 不同才拦)→ 按源白名单优先组过滤
    const blogHostByToken = new Map<number, string>();
    for (const r of db().prepare('SELECT token_id, blog_url FROM sources').all() as { token_id: number; blog_url: string }[]) {
        blogHostByToken.set(r.token_id, hostOfUrl(r.blog_url ?? ''));
    }
    const kept = fresh.filter((a) =>
        !isNonArticleFile(a.url) && !isNoiseUrl(a.url) && !isLandingUrl(a.url)
        && !isBlockedSubdomainUrl(a.url, blogHostByToken.get(a.token_id)));
    const byToken = new Map<number, ArticleInput[]>();
    for (const a of kept) { const g = byToken.get(a.token_id) ?? []; g.push(a); byToken.set(a.token_id, g); }
    // 白名单优先必须用全库口径(DIA 实锤:本批无白名单新文时组内判定全放行 → zktls-oracle 类产品页溜入)
    const tokenHasWhite = new Set<number>();
    for (const r of db().prepare('SELECT token_id, url FROM articles').all() as { token_id: number; url: string }[]) {
        if (isWhitelistedArticleUrl(r.url)) tokenHasWhite.add(r.token_id);
    }
    const passed = [...byToken.values()].flatMap((g) => {
        const groupWhite = g.filter((a) => isWhitelistedArticleUrl(a.url));
        if (groupWhite.length > 0) return groupWhite;              // 组内有白名单文 → 只留白名单
        if (tokenHasWhite.has(g[0].token_id)) return [];           // 组内无但库里有 → 非白名单增量全拦
        return g;                                                  // 该源从无白名单 → 信任放行(白名单不全的源不漏采)
    });
    if (passed.length < fresh.length) console.log(`🧹 收割过滤:${fresh.length} → ${passed.length}(拦 ${fresh.length - passed.length} 条非博文/噪音 · 不进账本)`);
    const added = upsertArticles(passed, runId);
    // known 行回填:同款过滤后 upsert(COALESCE 只补空)· runId 传 null 不动 first_run_id 语义 · 不计 added
    const refreshKept = refresh.filter((a) =>
        !isNonArticleFile(a.url) && !isNoiseUrl(a.url) && !isLandingUrl(a.url)
        && !isBlockedSubdomainUrl(a.url, blogHostByToken.get(a.token_id)));
    if (refreshKept.length) {
        upsertArticles(refreshKept, null);
        console.log(`♻️ 旧行空字段回填:${refreshKept.length} 条参与 COALESCE 补空`);
    }
    return { added, sourcesWithNew: new Set(passed.map((a) => a.token_id)).size };
}

function archiveCleanup(): void {
    // storage/logs 30 天清理(与 crawl_errors 同周期)
    try {
        const cutoff = Date.now() - 30 * 86_400_000;
        for (const f of readdirSync(LOGS_DIR)) {
            const p = resolve(LOGS_DIR, f);
            if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
        }
    } catch { /* 目录不存在等 */ }
    cleanupOldErrors(30);
}

export interface RunBatchResult { ok: boolean; reason?: string; runId?: string }

export async function runBatch(opts: { trigger: 'scheduler' | 'manual'; batchType?: string; onlySymbols?: string }): Promise<RunBatchResult> {
    const batchType = opts.batchType ?? (opts.onlySymbols ? 'single' : 'crawl');
    if (activeChild) return { ok: false, reason: 'busy' };

    const runId = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    mkdirSync(LOGS_DIR, { recursive: true });
    const logPath = `storage/logs/${runId}.log`;

    // reset 后首轮标记(ops/reset.ts 落的 flag · detector 跳过环比误报)
    let isAfterReset = 0;
    try {
        const flag = db().prepare(`SELECT value FROM app_config WHERE key = 'pending_reset_flag'`).get() as { value?: string } | undefined;
        if (flag?.value === '1') {
            isAfterReset = 1;
            db().prepare(`DELETE FROM app_config WHERE key = 'pending_reset_flag'`).run();
        }
    } catch { /* 无表等 */ }

    const claimed = claimRunSlot({
        runId, triggeredBy: opts.trigger, batchType, scope: opts.onlySymbols,
        extra: {
            is_after_reset: isAfterReset,
            git_commit: gitCommit(), log_path: logPath,
            proxy_main_hash: hashProxy(getProxyUrl('main')),
            proxy_medium_hash: hashProxy(getProxyUrl('medium')),
            proxy_slow_hash: hashProxy(getProxyUrl('slow')),
        },
    });
    if (!claimed) {
        recordSkippedOverlap(`${runId}-skip`, opts.trigger);
        return { ok: false, reason: 'skipped_overlap' };
    }

    const env: NodeJS.ProcessEnv = { ...process.env, RUN_ID: runId, NODE_OPTIONS: '--max-old-space-size=3072' };
    if (opts.onlySymbols) env.ONLY_SYMBOLS = opts.onlySymbols;

    activeChild = spawn('npx', ['tsx', 'src/main.ts'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const logStream = createWriteStream(resolve(REPO, logPath));
    activeChild.stdout?.pipe(logStream);
    activeChild.stderr?.pipe(logStream);

    const timeoutMin = cfgNum('batch_timeout_min', 30);
    let timedOut = false;
    const killTimer = setTimeout(() => {
        timedOut = true;
        console.warn(`⏱️ 批次超时(${timeoutMin}min)· SIGTERM(10s 宽限后 SIGKILL)`);
        activeChild?.kill('SIGTERM');
        setTimeout(() => { try { activeChild?.kill('SIGKILL'); } catch { /* 已退 */ } }, 10_000);
    }, timeoutMin * 60_000);

    return await new Promise<RunBatchResult>((resolvePromise) => {
        activeChild!.on('exit', (code, signal) => {
            void (async () => {
                clearTimeout(killTimer);
                activeChild = null;
                try {
                    const { added, sourcesWithNew } = harvestArticles(runId);
                    // 部分成功语义(审计 A1-P0-3):非零码但账本有数据 → failed + notes
                    const hasPartial = (db().prepare('SELECT COUNT(*) c FROM source_runs WHERE run_id = ?').get(runId) as { c: number }).c > 0;
                    const status = timedOut ? 'timeout' : code === 0 ? 'ok' : 'failed';
                    const notes = status === 'failed' && hasPartial ? '部分管线成功(账本有数据)' : undefined;
                    const alertsOpened = runDetector(runId);
                    finishRun(runId, { status, exitCode: code, exitSignal: signal ?? null, datasetAdded: added, sourcesWithNew, alertsOpened, notes });
                    refreshLastArticleAt();
                    advanceNextRun('crawl', runId);
                    archiveCleanup();
                    await runPusher(runId);
                    console.log(`🏁 批次 ${runId} 完成 status=${status} +${added} 篇 · 告警 ${alertsOpened}`);
                } catch (e) {
                    console.error('⚠️ 批次收尾异常(下轮补漏扫描兜底):', (e as Error).message);
                    finishRun(runId, { status: timedOut ? 'timeout' : 'failed', exitCode: code, exitSignal: signal ?? null, notes: `收尾异常: ${(e as Error).message.slice(0, 120)}` });
                    advanceNextRun('crawl', runId);
                }
                resolvePromise({ ok: true, runId });
            })();
        });
        activeChild!.on('error', (e) => {
            clearTimeout(killTimer);
            activeChild = null;
            finishRun(runId, { status: 'failed', notes: `spawn 失败: ${e.message.slice(0, 120)}` });
            advanceNextRun('crawl', runId);
            resolvePromise({ ok: false, reason: 'spawn_error', runId });
        });
    });
}

export { existsSync };
