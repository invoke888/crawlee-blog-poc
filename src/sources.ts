export interface BlogSource {
    name: string;
    url: string;
    note?: string;
}

export const blogSources: BlogSource[] = [
    { name: 'Vitalik 个人博客', url: 'https://vitalik.eth.limo/', note: '静态 · 反爬基线' },
    { name: 'Ethereum 基金会', url: 'https://blog.ethereum.org/', note: 'SSR · 中等' },
    { name: 'Paradigm', url: 'https://paradigm.xyz/', note: '投资机构 · 可能 Cloudflare' },
    { name: 'a16z crypto', url: 'https://a16zcrypto.com/', note: '可能 Cloudflare' },
    { name: 'Coinbase Blog', url: 'https://www.coinbase.com/blog', note: '一定 Cloudflare · 反爬硬测试' },
];

export const startUrls = blogSources.map((s) => s.url);
