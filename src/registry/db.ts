import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const DB_PATH = resolve(process.cwd(), 'storage/sources.db');
const SCHEMA_PATH = resolve(import.meta.dirname, 'schema.sql');

export interface SourceRow {
    token_id: number;
    base_symbol: string;
    blog_url: string;
    fetch_url: string | null;
    blogpicker_id: number | null;
    blogpicker_status: string | null;
    blogpicker_mode: string | null;
    blogpicker_rule: number | null;
    sitemap_url: string | null;
    sitemap_count: number | null;
    fetch_strategy: string | null;
    og_quality: string | null;
    host_platform: string | null;
    http_status: number | null;
    server_header: string | null;
    probed_at: string | null;
    created_at: string;
    updated_at: string;
}

let _db: Database.Database | null = null;

export function db(): Database.Database {
    if (_db) return _db;
    mkdirSync(dirname(DB_PATH), { recursive: true });
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.exec(readFileSync(SCHEMA_PATH, 'utf-8'));
    return _db;
}

export function upsertSource(s: Partial<SourceRow> & { token_id: number; base_symbol: string; blog_url: string }): void {
    db().prepare(`
        INSERT INTO sources (token_id, base_symbol, blog_url, fetch_url, blogpicker_id, blogpicker_status, blogpicker_mode, blogpicker_rule, updated_at)
        VALUES (@token_id, @base_symbol, @blog_url, @fetch_url, @blogpicker_id, @blogpicker_status, @blogpicker_mode, @blogpicker_rule, CURRENT_TIMESTAMP)
        ON CONFLICT(token_id) DO UPDATE SET
            base_symbol = excluded.base_symbol,
            blog_url = excluded.blog_url,
            fetch_url = excluded.fetch_url,
            blogpicker_id = excluded.blogpicker_id,
            blogpicker_status = excluded.blogpicker_status,
            blogpicker_mode = excluded.blogpicker_mode,
            blogpicker_rule = excluded.blogpicker_rule,
            updated_at = CURRENT_TIMESTAMP
    `).run({
        token_id: s.token_id,
        base_symbol: s.base_symbol,
        blog_url: s.blog_url,
        fetch_url: s.fetch_url ?? null,
        blogpicker_id: s.blogpicker_id ?? null,
        blogpicker_status: s.blogpicker_status ?? null,
        blogpicker_mode: s.blogpicker_mode ?? null,
        blogpicker_rule: s.blogpicker_rule ?? null,
    });
}

export function updateProbe(token_id: number, probe: Partial<SourceRow>): void {
    db().prepare(`
        UPDATE sources SET
            sitemap_url = @sitemap_url,
            sitemap_count = @sitemap_count,
            fetch_strategy = @fetch_strategy,
            og_quality = @og_quality,
            -- 🆕 2026-07-03 P2#5 教训:probe 检测不出 platform(custom-domain substack 如 CRO)时保留人工标记 · 不许 null 覆盖
            host_platform = COALESCE(@host_platform, host_platform),
            http_status = @http_status,
            server_header = @server_header,
            probed_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE token_id = @token_id
    `).run({
        token_id,
        sitemap_url: probe.sitemap_url ?? null,
        sitemap_count: probe.sitemap_count ?? null,
        fetch_strategy: probe.fetch_strategy ?? null,
        og_quality: probe.og_quality ?? null,
        host_platform: probe.host_platform ?? null,
        http_status: probe.http_status ?? null,
        server_header: probe.server_header ?? null,
    });
}

export function listSources(filter?: { probed?: boolean; status?: string; limit?: number }): SourceRow[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter?.probed === true) conditions.push('probed_at IS NOT NULL');
    if (filter?.probed === false) conditions.push('probed_at IS NULL');
    if (filter?.status) {
        conditions.push('blogpicker_status = @status');
        params.status = filter.status;
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filter?.limit ? `LIMIT ${filter.limit}` : '';
    return db().prepare(`SELECT * FROM sources ${where} ORDER BY token_id DESC ${limit}`).all() as SourceRow[];
}

export function countSources(): number {
    return (db().prepare('SELECT COUNT(*) as c FROM sources').get() as { c: number }).c;
}
