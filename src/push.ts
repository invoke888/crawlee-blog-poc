import { Dataset, Configuration } from 'crawlee';
import { filterArticlesWhitelistFirst } from './utils/article-filter.js';

// 关键!不清空 dataset · 否则 push.ts 启动时 main.ts 抓的数据就没了
Configuration.getGlobalConfig().set('purgeOnStart', false);

const PUSH_API_URL = process.env.PUSH_API_URL ?? '';
const PUSH_API_SECRET = process.env.PUSH_API_SECRET ?? '';
const DRY_RUN = process.env.DRY_RUN === '1';

interface PostPayload {
    post_id?: number;
    token_id: number;
    base_symbol: string;
    post_url: string;
    title: string;
    content: string;
    published_at?: string;
    fetched_at: string;
}

interface DatasetItem {
    crawler: string;
    token_id?: number;
    base_symbol?: string;
    url?: string;
    title?: string;
    description?: string;
    publishedTime?: string;
    crawledAt?: string;
}

async function main(): Promise<void> {
    if (!DRY_RUN && (!PUSH_API_URL || !PUSH_API_SECRET)) {
        console.error('❌ PUSH_API_URL / PUSH_API_SECRET 未设 · 设 DRY_RUN=1 跑空转');
        process.exit(1);
    }

    const dataset = await Dataset.open();
    const { items } = await dataset.getData({ limit: 100000 });

    const baseValid = (items as DatasetItem[]).filter(
        (it) => it.token_id != null && it.base_symbol && it.url && it.title,
    );

    // 🆕 2026-07-01 数据级白名单过滤(老板拍 · 跟报告聚合同一语义 · utils/article-filter.ts):
    // 按 token 分组 → 丢文件型 URL(sitemap.xml 等)→ 有白名单 article 只推白名单的
    // 防 781 条 landing/文件噪音推进 hhwl 生产
    const byToken = new Map<number, DatasetItem[]>();
    for (const it of baseValid) {
        const arr = byToken.get(it.token_id!) ?? [];
        arr.push(it);
        byToken.set(it.token_id!, arr);
    }
    const validItems: DatasetItem[] = [];
    for (const arr of byToken.values()) {
        validItems.push(...filterArticlesWhitelistFirst(arr));
    }

    console.log(`📤 准备推送 ${validItems.length}/${items.length} 条(基础过滤 ${baseValid.length} → 白名单数据级 ${validItems.length})`);
    console.log(`   · target: ${DRY_RUN ? 'DRY RUN 不真推' : PUSH_API_URL}`);

    let ok = 0;
    let fail = 0;
    for (const it of validItems) {
        const payload: PostPayload = {
            token_id: it.token_id!,
            base_symbol: it.base_symbol!,
            post_url: it.url!,
            title: it.title!,
            content: it.description ?? '',
            published_at: it.publishedTime || undefined,
            fetched_at: it.crawledAt ?? new Date().toISOString(),
        };

        if (DRY_RUN) {
            console.log(`   [dry] token_id=${payload.token_id} ${payload.title.slice(0, 60)}...`);
            ok += 1;
            continue;
        }

        try {
            const resp = await fetch(PUSH_API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Push-Secret': PUSH_API_SECRET,
                },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(10000),
            });
            if (resp.ok) {
                ok += 1;
            } else {
                fail += 1;
                console.warn(`   ❌ HTTP ${resp.status} token_id=${payload.token_id}`);
            }
        } catch (e) {
            fail += 1;
            console.warn(`   ❌ ${(e as Error).message?.slice(0, 80)} token_id=${payload.token_id}`);
        }
    }

    console.log(`\n✅ 完成 · 成功 ${ok} · 失败 ${fail}`);
}

await main();
