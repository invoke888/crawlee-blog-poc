// P2#1 生产同款探针(ImpitHttpClient Chrome 指纹 + 全头)· 修 agent 裸 curl 假反爬问题
// 用法: npx tsx scripts/probe-fetch.ts <url> [输出文件]
// 服务器跑 · 走 PROXY_URL(env 有就走)· 输出 HTTP 码 + HTML 到文件
import { Impit } from 'impit';

const url = process.argv[2];
const outFile = process.argv[3];
if (!url) {
    console.error('用法: npx tsx scripts/probe-fetch.ts <url> [out.html]');
    process.exit(1);
}

const impit = new Impit({
    browser: 'chrome',
    proxyUrl: process.env.PROXY_URL || undefined,
    timeout: 25000,
});
const res = await impit.fetch(url, {
    headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
    },
});
const body = await res.text();
console.log(`HTTP=${res.status} size=${body.length} url=${url}`);
if (outFile) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(outFile, body);
    console.log(`→ ${outFile}`);
}
process.exit(0);
