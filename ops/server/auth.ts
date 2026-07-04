// 🆕 2026-07-04 登录鉴权(老板拍方案 C 门厅):cookie HMAC 会话 + Basic 头兼容(curl/脚本)+ 失败限速
// 铁律:限速只计「提交了错误凭据」· 无凭据请求不计数(浏览器挑战-响应首发不背锅 · 修死锁)
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

const SESSION_DAYS = 30;
const LOCK_AFTER = 5;   // 连续错 5 次
const LOCK_MS = 60_000; // 锁 1 分钟

export interface AuthRequestLike { headers: { cookie?: string; authorization?: string } }

export interface AuthGate {
    issueToken(now?: number): string;
    verifyToken(token: string, now?: number): boolean;
    login(user: string, pass: string, ip: string, now?: number): 'ok' | 'bad' | 'locked';
    checkRequest(req: AuthRequestLike, ip: string, now?: number): boolean;
    isLocked(ip: string, now?: number): boolean;
    cookieHeader(token: string): string;
}

export function createAuthGate(user: string, pass: string): AuthGate {
    // secret 从凭据派生:改 .env.local 密码 = 已发会话全部立即失效
    const secret = createHash('sha256').update(`ops-session|${user}|${pass}`).digest();
    const failByIp = new Map<string, { n: number; until: number }>();

    const isLocked = (ip: string, now = Date.now()): boolean => {
        const f = failByIp.get(ip);
        if (!f) return false;
        if (f.until && f.until <= now) { failByIp.delete(ip); return false; } // 锁到期 → 计数清零 · 不续命
        return f.until > now;
    };
    const noteBad = (ip: string, now = Date.now()): void => {
        const cur = failByIp.get(ip) ?? { n: 0, until: 0 };
        cur.n += 1;
        if (cur.n >= LOCK_AFTER) cur.until = now + LOCK_MS;
        failByIp.set(ip, cur);
    };
    const credentialsOk = (u: string, p: string): boolean => !!user && !!pass && u === user && p === pass;

    const issueToken = (now = Date.now()): string => {
        const exp = String(now + SESSION_DAYS * 86_400_000);
        return `${exp}.${createHmac('sha256', secret).update(exp).digest('base64url')}`;
    };
    const verifyToken = (token: string, now = Date.now()): boolean => {
        const dot = token.indexOf('.');
        if (dot < 1) return false;
        const exp = token.slice(0, dot);
        if (!/^\d{1,16}$/.test(exp) || Number(exp) < now) return false;
        const want = createHmac('sha256', secret).update(exp).digest();
        let got: Buffer;
        try { got = Buffer.from(token.slice(dot + 1), 'base64url'); } catch { return false; }
        return got.length === want.length && timingSafeEqual(got, want);
    };

    return {
        issueToken,
        verifyToken,
        isLocked,
        login(u, p, ip, now = Date.now()) {
            if (!user || !pass) return 'bad'; // 未配凭据 = 拒绝一切(防裸奔)
            if (isLocked(ip, now)) return 'locked';
            if (credentialsOk(u, p)) { failByIp.delete(ip); return 'ok'; }
            noteBad(ip, now);
            return 'bad';
        },
        checkRequest(req, ip, now = Date.now()) {
            if (!user || !pass) return false;
            const m = /(?:^|;\s*)ops_s=([^;]+)/.exec(req.headers.cookie ?? '');
            if (m && verifyToken(m[1], now)) return true;
            const h = req.headers.authorization ?? '';
            if (h.startsWith('Basic ')) {
                if (isLocked(ip, now)) return false;
                const raw = Buffer.from(h.slice(6), 'base64').toString();
                const colon = raw.indexOf(':');
                const u = colon < 0 ? raw : raw.slice(0, colon);
                const p = colon < 0 ? '' : raw.slice(colon + 1);
                if (credentialsOk(u, p)) { failByIp.delete(ip); return true; }
                noteBad(ip, now); // 只有「带了 Basic 且凭据错」才计数
            }
            return false; // 无凭据:401 但不计失败
        },
        cookieHeader(token) {
            return `ops_s=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`;
        },
    };
}
