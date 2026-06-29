import { Dataset } from 'crawlee';

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

    const validItems = (items as DatasetItem[]).filter(
        (it) => it.token_id != null && it.base_symbol && it.url && it.title,
    );

    console.log(`📤 准备推送 ${validItems.length}/${items.length} 条(过滤 token_id/url/title 缺失)`);
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
