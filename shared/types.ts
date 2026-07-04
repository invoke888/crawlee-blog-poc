// 🆕 2026-07-04 共享类型(计划书 §4 schema 对应)
export type RunStatus = 'running' | 'ok' | 'failed' | 'timeout' | 'skipped_overlap' | 'queued' | 'crashed';
export type ErrorKind =
    | 'proxy_error' | 'unreachable' | 'timeout'
    | 'http_403' | 'http_404' | 'http_429' | 'http_4xx' | 'http_5xx'
    | 'tls_error' | 'parse_error'
    | 'cf_challenge' | 'soft_404' | 'error_page'
    | 'internal';

export interface CrawlErrorRow {
    token_id?: number;
    base_symbol?: string;
    url?: string;
    kind: ErrorKind;
    http_status?: number | null;
    retry_after_s?: number | null;
    error_code?: string | null;
    message?: string;
    retries?: number;
    at: string;
}

export interface AlertRow {
    alert_id?: number;
    token_id: number | null;
    base_symbol: string | null;
    type: string;
    severity: 'red' | 'yellow' | 'info';
    status?: string;
    detail: string;
}
