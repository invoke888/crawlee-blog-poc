// 🆕 2026-07-04 代理连通测试(计划书 §5.5):服务器侧 impit 生产指纹(铁律:禁裸 curl · dashboard 自动化同样遵守)
// 带直连基线对照:双失败 = ipify 自己的锅 · 只有"直连通、代理挂"才判池坏
import { Impit } from 'impit';

const TARGET = 'https://api.ipify.org?format=json';

async function fetchIp(proxyUrl?: string): Promise<{ ok: boolean; ip?: string; latencyMs?: number; error?: string }> {
    const t0 = Date.now();
    try {
        const impit = new Impit({ browser: 'chrome', proxyUrl: proxyUrl || undefined, timeout: 15000 });
        const res = await impit.fetch(TARGET, { headers: { 'Accept': 'application/json' } });
        const body = await res.text();
        if (res.status !== 200) return { ok: false, error: `HTTP ${res.status}` };
        const ip = (JSON.parse(body) as { ip?: string }).ip;
        return { ok: true, ip, latencyMs: Date.now() - t0 };
    } catch (e) {
        return { ok: false, error: ((e as Error).message ?? String(e)).slice(0, 200) };
    }
}

export interface ProxyTestResult {
    ok: boolean;
    ip?: string;
    latencyMs?: number;
    error?: string;
    baseline_ok: boolean;      // 直连基线 · false 且代理也失败 = 疑似 ipify 故障非池故障
    verdict: 'pool_ok' | 'pool_dead' | 'target_flaky';
}

export async function testProxy(proxyUrl: string): Promise<ProxyTestResult> {
    const [viaProxy, direct] = await Promise.all([fetchIp(proxyUrl), fetchIp(undefined)]);
    let verdict: ProxyTestResult['verdict'];
    if (viaProxy.ok) verdict = 'pool_ok';
    else if (direct.ok) verdict = 'pool_dead';
    else verdict = 'target_flaky';
    return { ...viaProxy, baseline_ok: direct.ok, verdict };
}
