// 🆕 2026-07-04 内置调度器(计划书 §5.1 · 废 systemd timer):tick + schedule_state 持久化 + 崩溃恢复
import { ensureScheduleState, getScheduleState, touchScheduleTick, findStaleRunningRuns, markRunCrashed, upsertAlert } from '../shared/ledger.js';
import { cfgNum } from '../shared/config.js';
import { runBatch, isRunActive } from './run-batch.js';

const TICK_MS = 30_000;

export function recoverFromCrash(): void {
    const timeoutMin = cfgNum('batch_timeout_min', 30);
    const stale = findStaleRunningRuns(timeoutMin);
    for (const run of stale) {
        console.warn(`⚠️ 侦测到孤儿 running 批次 ${run.run_id}(进程异常终止)→ 标 crashed`);
        markRunCrashed(run.run_id);
        upsertAlert({ token_id: null, base_symbol: null, type: 'run_interrupted', severity: 'red',
            detail: `批次 ${run.run_id} 进程异常终止(启动时侦测 · 数据由补漏扫描兜底)` }, run.run_id);
    }
    ensureScheduleState('crawl', cfgNum('crawl_interval_min', 60) * 60_000);
}

function tick(): void {
    try {
        touchScheduleTick('crawl');
        // 🆕 2026-07-13 死锁根治(2026-07-11 OOM 实锤 · 零采集2天):stale 孤儿检查每 tick 跑
        // 原只在启动跑一次 → OOM 杀进程时刚 claim 的孤儿(<15min 不算 stale)重启后永无人清 → claim 连环撞死锁
        if (!isRunActive()) {
            const timeoutMin = cfgNum('batch_timeout_min', 30);
            for (const run of findStaleRunningRuns(timeoutMin)) {
                console.warn(`⚠️ tick 侦测 stale running 孤儿 ${run.run_id} → 标 crashed(解锁调度)`);
                markRunCrashed(run.run_id);
                upsertAlert({ token_id: null, base_symbol: null, type: 'run_interrupted', severity: 'red',
                    detail: `批次 ${run.run_id} 孤儿(进程曾被杀)· tick 自愈清除` }, run.run_id);
            }
        }
        // interval 面板改动 → 每 tick 同步(热生效)
        ensureScheduleState('crawl', cfgNum('crawl_interval_min', 60) * 60_000);
        const st = getScheduleState('crawl');
        if (!st || st.paused) return;
        if (new Date(st.next_run_at) > new Date()) return;
        if (isRunActive()) return;
        console.log(`⏱️ 调度触发批次(next_run_at=${st.next_run_at})`);
        void runBatch({ trigger: 'scheduler' });
    } catch (e) {
        console.error('⚠️ 调度 tick 异常(下个 tick 继续):', (e as Error).message);
    }
}

export function startScheduler(): void {
    recoverFromCrash();
    setInterval(tick, TICK_MS);
    tick(); // 启动即判一次
    console.log(`⏱️ 内置调度器已启动(tick ${TICK_MS / 1000}s · interval ${cfgNum('crawl_interval_min', 60)}min)`);
}
