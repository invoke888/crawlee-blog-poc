import { upsertSource, countSources } from './registry/db.js';
import { isIgnoredUrl, URL_OVERRIDES } from './config.js';

const API_BASE = process.env.HHWL_API_BASE ?? 'https://blog-picker.hhwlnet.com';
const PAGE_SIZE = 50;

interface GoNullString { String: string; Valid: boolean }
interface GoNullInt64 { Int64: number; Valid: boolean }

interface BlogItem {
    id: number;
    token_id: number;
    base_symbol: string;
    blog_url: string;
    fetch_url: GoNullString;
    fetch_mode: string;
    rule_id: GoNullInt64;
    probe_confidence: GoNullString;
    status: string;
}

interface BlogListResp {
    items: BlogItem[];
    total: number;
    limit: number;
    offset: number;
}

const unwrapStr = (n: GoNullString | null | undefined): string | null =>
    n?.Valid ? n.String : null;
const unwrapInt = (n: GoNullInt64 | null | undefined): number | null =>
    n?.Valid ? n.Int64 : null;

async function fetchPage(offset: number, limit: number): Promise<BlogListResp> {
    const url = `${API_BASE}/api/blogs?limit=${limit}&offset=${offset}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}`);
    return resp.json() as Promise<BlogListResp>;
}

async function main(): Promise<void> {
    const targetCount = Number(process.env.FETCH_LIMIT ?? 200);
    console.log(`📥 拉 hhwl API · 目标 ${targetCount} 条 · 起点 ${API_BASE}`);

    let offset = 0;
    let fetched = 0;
    let total = 0;

    while (fetched < targetCount) {
        const remaining = targetCount - fetched;
        const limit = Math.min(PAGE_SIZE, remaining);
        const page = await fetchPage(offset, limit);
        total = page.total;

        if (page.items.length === 0) {
            console.log(`⚠️ offset ${offset} 返回 0 条 · 结束`);
            break;
        }

        let pageIgnored = 0;
        let pageOverridden = 0;
        for (const it of page.items) {
            // URL_OVERRIDES: hhwl 数据 URL 错的 · 这里硬改
            const blogUrl = URL_OVERRIDES[it.base_symbol] ?? it.blog_url;
            if (URL_OVERRIDES[it.base_symbol]) pageOverridden += 1;

            if (isIgnoredUrl(blogUrl)) {
                pageIgnored += 1;
                continue;
            }
            upsertSource({
                token_id: it.token_id,
                base_symbol: it.base_symbol,
                blog_url: blogUrl,
                fetch_url: unwrapStr(it.fetch_url),
                blogpicker_id: it.id,
                blogpicker_status: it.status,
                blogpicker_mode: it.fetch_mode,
                blogpicker_rule: unwrapInt(it.rule_id),
            });
        }

        fetched += page.items.length;
        offset += page.items.length;
        console.log(`  · 已拉 ${fetched}/${targetCount}(blogpicker 总计 ${total}) ⊘ ignored ${pageIgnored} · overridden ${pageOverridden}`);
    }

    console.log(`✅ 完成 · registry 总条数 ${countSources()}`);
}

await main();
