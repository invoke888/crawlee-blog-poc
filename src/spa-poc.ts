// PoC · SPA 站 2 套抓法验证(2026-06-30 老板拍 C):
// - Next.js Pages Router(coredao 类):HTML 含 __NEXT_DATA__ · 直接 JSON.parse
// - Next.js 14 App Router + Server Action(scroll 类):POST + body + action ID 拿 RSC stream · 解 Markdown
//
// 跑:`tsx src/spa-poc.ts`
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

// 轻量 HTML 解析 · 不依赖 cheerio
function extractNextData(html: string): string | null {
    const m = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/);
    return m?.[1] ?? null;
}
function extractMeta(html: string, key: string): string {
    const re = new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${key}["'][^>]*content=["']([^"']*)["']`, 'i');
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name|itemprop)=["']${key}["']`, 'i');
    return html.match(re)?.[1] || html.match(re2)?.[1] || '';
}

interface ArticleData {
    url: string;
    handler: string;
    title?: string;
    description?: string;
    image?: string;
    published_at?: string;
    content_preview?: string;
    raw_size?: number;
    error?: string;
}

// === Handler 1: Next.js Pages Router · 抽 __NEXT_DATA__ ===
async function fetchNextData(url: string): Promise<ArticleData> {
    const resp = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!resp.ok) return { url, handler: 'next-data', error: `HTTP ${resp.status}` };
    const html = await resp.text();
    const raw = extractNextData(html);
    if (!raw) return { url, handler: 'next-data', error: '没找到 __NEXT_DATA__', raw_size: html.length };

    let data: unknown;
    try { data = JSON.parse(raw); }
    catch { return { url, handler: 'next-data', error: 'JSON parse fail' }; }

    // 通用路径搜索 · 找到第一个含 title/heading/body/content 的 object
    const tryPaths = [
        'props.pageProps.post',
        'props.pageProps.article',
        'props.pageProps.data',
        'props.pageProps.blog',
        'props.pageProps.story',
        'props.pageProps.content',
        'props.pageProps.entry',
        'props.pageProps',
    ];
    type Article = Record<string, unknown>;
    function get(obj: unknown, path: string): unknown {
        return path.split('.').reduce<unknown>((a, k) => (a && typeof a === 'object' ? (a as Record<string, unknown>)[k] : undefined), obj);
    }
    let article: Article | null = null;
    for (const p of tryPaths) {
        const val = get(data, p);
        if (val && typeof val === 'object') {
            const v = val as Article;
            if (v.title || v.heading || v.body || v.content || v.markdown) {
                article = v; break;
            }
        }
    }
    if (!article) return { url, handler: 'next-data', error: '__NEXT_DATA__ 解析无 article(可能字段名不在通用列表)', raw_size: raw.length };

    const s = (v: unknown): string => (typeof v === 'string' ? v : '');
    const title = s(article.title) || s(article.heading);
    const description = s(article.description) || s(article.excerpt) || s(article.summary);
    const image = s(article.image) || s(article.coverImage) || s(article.cover) || s(article.thumbnail);
    const published_at = s(article.publishedAt) || s(article.published_at) || s(article.date) || s(article.createdAt);
    const content_preview = (s(article.body) || s(article.content) || s(article.markdown) || s(article.html)).slice(0, 400);

    return { url, handler: 'next-data', title, description, image, published_at, content_preview, raw_size: raw.length };
}

// === Handler 2: Next.js 14 App Router + Server Action · POST RSC ===
async function fetchNextjsRsc(url: string, actionId: string, stateTreeTpl: string): Promise<ArticleData> {
    const u = new URL(url);
    const slug = u.pathname.split('/').filter(Boolean).pop() ?? '';
    const stateTree = stateTreeTpl.replace('{slug}', slug);

    // GET 拿 og meta(站本身设了 og · scroll 是 SSR head)
    let ogTitle = '', ogImage = '', ogDescription = '', ogPub = '';
    try {
        const getResp = await fetch(url, { headers: { 'User-Agent': UA } });
        if (getResp.ok) {
            const html = await getResp.text();
            ogTitle = extractMeta(html, 'og:title').trim();
            ogImage = extractMeta(html, 'og:image');
            ogDescription = extractMeta(html, 'og:description');
            ogPub = extractMeta(html, 'article:published_time') || extractMeta(html, 'article:modified_time');
        }
    } catch { /* og 拿不到不致命 · 继续 POST */ }

    // POST 拿 RSC(完全模拟浏览器 #75)
    const resp = await fetch(url, {
        method: 'POST',
        headers: {
            'User-Agent': UA,
            'next-action': actionId,
            'Next-Router-State-Tree': stateTree,
            'Accept': 'text/x-component',
            'Content-Type': 'text/plain;charset=UTF-8',
            'Referer': url,
        },
        body: JSON.stringify([slug]),
    });
    if (!resp.ok) return { url, handler: 'nextjs-rsc', error: `POST ${resp.status}` };
    const rsc = await resp.text();

    // 解析 RSC stream:找 T<len>, 后面的内容 · 取最长的当 Markdown
    const lines = rsc.split('\n');
    let best = '';
    let i = 0;
    while (i < lines.length) {
        const m = lines[i].match(/^[0-9a-f]+:T\d+,(.*)$/);
        if (m) {
            const parts = [m[1]];
            let j = i + 1;
            while (j < lines.length && !/^[0-9a-f]+:/.test(lines[j])) {
                parts.push(lines[j]); j++;
            }
            const text = parts.join('\n');
            if (text.length > best.length) best = text;
            i = j;
        } else { i++; }
    }
    if (!best) return { url, handler: 'nextjs-rsc', error: '解 RSC 没 Markdown chunk · 可能 action ID 过期', raw_size: rsc.length };

    const titleM = best.match(/^#\s+(.+)$/m);

    return {
        url, handler: 'nextjs-rsc',
        title: titleM?.[1]?.trim() || ogTitle,
        description: ogDescription,
        image: ogImage,
        published_at: ogPub,
        content_preview: best.slice(0, 400),
        raw_size: rsc.length,
    };
}

// === 主 PoC ===
async function main(): Promise<void> {
    const scrollStateTpl = '%5B%22%22%2C%7B%22children%22%3A%5B%22blog%22%2C%7B%22children%22%3A%5B%5B%22blogId%22%2C%22{slug}%22%2C%22d%22%5D%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%2Ctrue%5D';
    const scrollAction = '7f343f7d62750775beffcc8ab57787db53b8b4e606';

    const tests: Array<{ name: string; fn: () => Promise<ArticleData> }> = [
        // Next.js 14 App Router + Server Action
        { name: 'scroll.io · community-update-october',
            fn: () => fetchNextjsRsc('https://scroll.io/blog/community-update-october', scrollAction, scrollStateTpl) },
        { name: 'scroll.io · founderLetter',
            fn: () => fetchNextjsRsc('https://scroll.io/blog/founderLetter', scrollAction, scrollStateTpl) },
        { name: 'scroll.io · scrolls-security-measures',
            fn: () => fetchNextjsRsc('https://scroll.io/blog/scrolls-security-measures', scrollAction, scrollStateTpl) },
        // Next.js Pages Router · __NEXT_DATA__
        { name: 'coredao.org · the-core-revenue-roadmap',
            fn: () => fetchNextData('https://coredao.org/blog/the-core-revenue-roadmap') },
    ];

    console.log(`🚀 SPA PoC · 跑 ${tests.length} 个测试 URL\n`);
    let ok = 0, fail = 0;
    for (const t of tests) {
        try {
            const r = await t.fn();
            if (r.error) {
                console.log(`❌ ${t.name}\n   [${r.handler}] ${r.error} (raw_size=${r.raw_size ?? '-'})\n`);
                fail += 1;
            } else {
                console.log(`✅ ${t.name}`);
                console.log(`   [${r.handler}] raw_size=${r.raw_size ?? '-'}`);
                console.log(`   title:       ${r.title?.slice(0, 80) || '(空)'}`);
                console.log(`   description: ${r.description?.slice(0, 80) || '(空)'}`);
                console.log(`   published:   ${r.published_at || '(空)'}`);
                console.log(`   image:       ${r.image?.slice(0, 80) || '(空)'}`);
                console.log(`   content:     ${(r.content_preview ?? '').slice(0, 160).replace(/\n/g, ' ')}...\n`);
                ok += 1;
            }
        } catch (e) {
            console.log(`❌ ${t.name}\n   ${(e as Error).message}\n`);
            fail += 1;
        }
    }
    console.log(`\n📊 总计:✅ ${ok} 成功 · ❌ ${fail} 失败`);
}

await main();
