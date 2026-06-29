import { CheerioCrawler, Sitemap, Configuration } from 'crawlee';
import { Browser, ImpitHttpClient } from '@crawlee/impit-client';
import { listSources, updateProbe, type SourceRow } from './registry/db.js';

const PROBE_LIMIT = Number(process.env.PROBE_LIMIT ?? 200);
const MAX_CONCURRENCY = Number(process.env.PROBE_CONCURRENCY ?? 10);

function detectHostPlatform(url: string): string | null {
    try {
        const h = new URL(url).hostname;
        if (h === 'medium.com' || h.endsWith('.medium.com')) return 'medium';
        if (h === 'mirror.xyz' || h.endsWith('.mirror.xyz')) return 'mirror';
        if (h.endsWith('.substack.com')) return 'substack';
        if (h.endsWith('.ghost.io')) return 'ghost';
        if (h === 'paragraph.xyz' || h.endsWith('.paragraph.xyz')) return 'paragraph';
        if (h.includes('binance.com')) return 'binance';
        return null;
    } catch {
        return null;
    }
}

async function tryLoadSitemap(originUrl: string): Promise<{ url: string; count: number } | null> {
    const candidates = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap.txt'];
    for (const path of candidates) {
        try {
            const u = new URL(originUrl);
            const sitemapUrl = `${u.protocol}//${u.hostname}${path}`;
            const ctrl = AbortSignal.timeout(8000);
            const headResp = await fetch(sitemapUrl, { method: 'HEAD', signal: ctrl });
            if (!headResp.ok) continue;
            const { urls } = await Sitemap.load(sitemapUrl);
            if (urls.length > 0) return { url: sitemapUrl, count: urls.length };
        } catch {
            continue;
        }
    }
    return null;
}

function decideFetchStrategy(og_quality: string, has_sitemap: boolean, http_status: number): string {
    if (http_status === 403 || http_status === 429) return 'playwright';
    if (has_sitemap) return 'sitemap';
    if (og_quality === 'full' || og_quality === 'partial') return 'http';
    return 'http';
}

async function main(): Promise<void> {
    const sources = listSources({ probed: false, limit: PROBE_LIMIT });
    console.log(`🔬 probe 启动 · 目标 ${sources.length} 个未探测源 · concurrency=${MAX_CONCURRENCY}`);

    if (sources.length === 0) {
        console.log('⚠️ 无未探测源 · 退出。重新 probe 请删 storage/sources.db 重新拉');
        return;
    }

    const sourceMap = new Map<string, SourceRow>();
    for (const s of sources) sourceMap.set(s.blog_url, s);

    Configuration.getGlobalConfig().set('purgeOnStart', false);

    const crawler = new CheerioCrawler({
        httpClient: new ImpitHttpClient({ browser: Browser.Chrome }),
        maxConcurrency: MAX_CONCURRENCY,
        maxRequestsPerCrawl: sources.length * 4,
        requestHandlerTimeoutSecs: 60,
        async requestHandler({ request, $, response, log }) {
            const tokenId = request.userData?.token_id as number;
            const source = sourceMap.get(request.url) ?? sourceMap.get(request.loadedUrl ?? request.url);

            const ogTitle = $('meta[property="og:title"]').attr('content') ?? '';
            const ogImage = $('meta[property="og:image"]').attr('content') ?? '';
            const ogDescription = $('meta[property="og:description"]').attr('content') ?? '';
            const ogSiteName = $('meta[property="og:site_name"]').attr('content') ?? '';
            const ogScore = [ogTitle, ogImage, ogDescription, ogSiteName].filter(Boolean).length;
            const og_quality = ogScore >= 3 ? 'full' : ogScore >= 1 ? 'partial' : 'none';

            const host_platform = detectHostPlatform(request.url);
            const http_status = response.statusCode ?? 200;
            const server_header = (response.headers as Record<string, string>)?.server ?? null;

            let sitemap_url: string | null = null;
            let sitemap_count: number | null = null;
            try {
                const sm = await tryLoadSitemap(request.url);
                if (sm) {
                    sitemap_url = sm.url;
                    sitemap_count = sm.count;
                }
            } catch (e) {
                log.warning(`sitemap probe 失败 ${request.url}: ${(e as Error).message}`);
            }

            const fetch_strategy = decideFetchStrategy(og_quality, !!sitemap_url, http_status);

            updateProbe(tokenId, {
                og_quality, host_platform, http_status, server_header,
                sitemap_url, sitemap_count, fetch_strategy,
            });

            log.info(`✅ token_id=${tokenId} og=${og_quality} platform=${host_platform ?? '-'} sitemap=${sitemap_count ?? '-'} strategy=${fetch_strategy}`);
        },
        async failedRequestHandler({ request, log }, error) {
            const tokenId = request.userData?.token_id as number;
            const http_status = (error as { statusCode?: number })?.statusCode ?? -1;
            const fetch_strategy = http_status === 403 || http_status === 429 ? 'playwright' : 'http';

            updateProbe(tokenId, {
                og_quality: 'none', host_platform: detectHostPlatform(request.url),
                http_status, server_header: null, fetch_strategy,
                sitemap_url: null, sitemap_count: null,
            });
            log.warning(`❌ token_id=${tokenId} ${request.url} status=${http_status} err=${(error as Error).message?.slice(0, 80)}`);
        },
    });

    await crawler.run(
        sources.map((s) => ({ url: s.blog_url, userData: { token_id: s.token_id } })),
    );

    console.log('✅ probe 完成');
}

await main();
