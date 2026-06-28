import { Browser, ImpitHttpClient } from '@crawlee/impit-client';
import { CheerioCrawler } from 'crawlee';

import { router } from './routes.js';
import { startUrls } from './sources.js';

const crawler = new CheerioCrawler({
    httpClient: new ImpitHttpClient({ browser: Browser.Chrome }),
    requestHandler: router,
    maxRequestsPerCrawl: 50,
});

await crawler.run(startUrls);
