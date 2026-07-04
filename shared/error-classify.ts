// 🆕 2026-07-04 错误分类纯函数(计划书 §4 · 审计 A4)
// 优先级:①HTTP 状态码 ②error.code(Node 系统码)③message 正则 ④internal 兜底
// 仅代理层握手/连接错误才归 proxy_error(防"impit 抛的全算代理错"吃掉细分 · A4-P2-11)
import type { ErrorKind } from './types.js';

export interface ClassifyInput {
    message?: string;
    statusCode?: number | null;   // crawlee error 上常见 statusCode / response.status
    code?: string | null;         // Node error.code(ECONNRESET/ETIMEDOUT/ENOTFOUND…)
    retryAfter?: string | number | null;
}

export interface ClassifyResult {
    kind: ErrorKind;
    http_status: number | null;
    retry_after_s: number | null;
    error_code: string | null;
}

const PROXY_RE = /proxy|socks5?|tunnel(ing)? socket|407/i;
const TLS_RE = /tls|ssl|certificate|cert |handshake|EPROTO/i;
const TIMEOUT_RE = /timed? ?out|timeout/i;
const UNREACH_RE = /ENOTFOUND|ECONNREFUSED|EAI_AGAIN|getaddrinfo|dns|ECONNRESET|socket hang up|network|GOAWAY/i;
const PARSE_RE = /\$ is not a function|parse|unexpected token|malformed|cheerio/i;

function statusToKind(s: number): ErrorKind {
    if (s === 403) return 'http_403';
    if (s === 404) return 'http_404';
    if (s === 429) return 'http_429';
    if (s >= 500) return 'http_5xx';
    if (s >= 400) return 'http_4xx';
    return 'internal';
}

export function classifyError(input: ClassifyInput): ClassifyResult {
    const msg = input.message ?? '';
    const code = input.code ?? null;
    let retry_after_s: number | null = null;
    if (input.retryAfter != null) {
        const n = Number(input.retryAfter);
        if (Number.isFinite(n) && n >= 0) retry_after_s = Math.round(n);
    }

    // ① 显式状态码(参数或 message 里的 "received NNN status code" / "NNN - ")
    let status = input.statusCode ?? null;
    if (status == null) {
        const m = /(?:received |status code[: ]*|^|\s)(40[0-9]|41[0-9]|42[0-9]|4[3-9][0-9]|5[0-9][0-9])(?:\s*[-–]|\s+status|$|\s)/.exec(msg);
        if (m) status = Number(m[1]);
    }
    if (status != null && status >= 400) {
        return { kind: statusToKind(status), http_status: status, retry_after_s, error_code: code };
    }

    // ② Node error.code
    if (code) {
        if (/^(ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ECONNRESET|EPIPE|EHOSTUNREACH|ENETUNREACH)$/.test(code)) {
            return { kind: 'unreachable', http_status: null, retry_after_s, error_code: code };
        }
        if (/^(ETIMEDOUT|ESOCKETTIMEDOUT)$/.test(code)) {
            return { kind: 'timeout', http_status: null, retry_after_s, error_code: code };
        }
        if (/^EPROTO$/.test(code)) {
            return { kind: 'tls_error', http_status: null, retry_after_s, error_code: code };
        }
    }

    // ③ message 正则(代理判定要求明确的代理上下文词,排在通用网络词之前)
    if (PROXY_RE.test(msg)) return { kind: 'proxy_error', http_status: null, retry_after_s, error_code: code };
    if (TLS_RE.test(msg)) return { kind: 'tls_error', http_status: null, retry_after_s, error_code: code };
    if (TIMEOUT_RE.test(msg)) return { kind: 'timeout', http_status: null, retry_after_s, error_code: code };
    if (UNREACH_RE.test(msg)) return { kind: 'unreachable', http_status: null, retry_after_s, error_code: code };
    if (PARSE_RE.test(msg)) return { kind: 'parse_error', http_status: null, retry_after_s, error_code: code };

    // ④ 兜底(detector 有 unclassified_surge 盯着这个桶)
    return { kind: 'internal', http_status: null, retry_after_s, error_code: code };
}

// 软错误页(HTTP 200 但内容是拦截页 · detailHandler BAD_TITLE_RE 命中时二次判定)
export function classifySoftErrorPage(title: string): ErrorKind {
    if (/just a moment/i.test(title)) return 'cf_challenge';
    if (/404|not found/i.test(title)) return 'soft_404';
    return 'error_page';
}
