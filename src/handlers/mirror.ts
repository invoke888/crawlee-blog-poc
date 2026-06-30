// 🆕 2026-06-30 mirror.xyz Atom feed handler
// mirror.xyz 用 Atom(不是 RSS 2.0)· tag 是 <entry> 不是 <item>
// link 是 <link href="..."/> attr · 不是 <link>text</link>
// 实测 curl 反爬严(403/429)· 用 ImpitHttpClient Chrome fingerprint 应能过
import { createCheerioRouter, type CheerioCrawlingContext } from 'crawlee';
import { normalizePublishedAt } from '../utils/normalize-date.js';

export const mirrorRouter = createCheerioRouter();

// URL 形式 1: https://mirror.xyz/<addr>.eth → https://mirror.xyz/<addr>.eth/feed/atom
// URL 形式 2: https://<sub>.mirror.xyz/ → https://<sub>.mirror.xyz/feed/atom
export function mirrorToAtom(url: string): string {
    try {
        const u = new URL(url);
        const path = u.pathname.replace(/\/+$/, '');
        return `${u.protocol}//${u.hostname}${path}/feed/atom`;
    } catch {
        return url;
    }
}

interface TokenAssoc { token_id: number; base_symbol: string; original_url: string }

mirrorRouter.addDefaultHandler(async (ctx: CheerioCrawlingContext) => {
    const { request, $, log, pushData } = ctx;
    const sourcesForUrl = (request.userData?.sources_for_url ?? []) as TokenAssoc[];

    const channelTitle = $('feed > title').first().text().trim()
        || $('title').first().text().trim();

    let itemCount = 0;
    let pushCount = 0;
    const tasks: Promise<void>[] = [];
    $('entry').each((_, el) => {
        const $entry = $(el);
        const postTitle = $entry.find('title').first().text().trim();
        // Atom link: <link href="..." rel="alternate"/>
        const $links = $entry.find('link');
        const linkAlt = $links.filter('[rel="alternate"]').first().attr('href')
            || $links.first().attr('href') || '';
        const postUrl = linkAlt;
        const author = $entry.find('author > name').first().text().trim()
            || $entry.find('author').first().text().trim();
        // Atom uses <published> 或 <updated>
        const published = $entry.find('published').first().text().trim()
            || $entry.find('updated').first().text().trim();
        const summary = $entry.find('summary').first().text().trim();
        const content = $entry.find('content').first().text().trim();
        const snippet = (summary || content).replace(/<[^>]+>/g, '').slice(0, 280);
        const guid = $entry.find('id').first().text().trim();

        for (const src of sourcesForUrl) {
            tasks.push(pushData({
                crawler: 'mirror',
                token_id: src.token_id,
                base_symbol: src.base_symbol,
                source_url: src.original_url,
                atom_url: request.loadedUrl,
                channel: channelTitle,
                url: postUrl,
                title: postTitle,
                description: snippet,
                author,
                publishedTime: normalizePublishedAt(published),
                guid,
                crawledAt: new Date().toISOString(),
            }));
            pushCount += 1;
        }
        itemCount += 1;
    });
    await Promise.all(tasks);

    if (itemCount === 0) {
        log.warning(`⚠️ [mirror] 0 entries | ${request.url}(${sourcesForUrl.length} tokens 关联)`);
    } else {
        log.info(`✅ [mirror] ${itemCount} entries × ${sourcesForUrl.length} tokens = ${pushCount} 条 | ${channelTitle || '(no channel)'}`);
    }
});
