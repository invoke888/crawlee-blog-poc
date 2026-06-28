-- Source Registry · Crawlee PoC 的源清单 + 分类元数据
-- 跟 blogpicker prod 完全独立(本表只在 PoC 项目目录 storage/sources.db)

CREATE TABLE IF NOT EXISTS sources (
    -- 来自 hhwl /api/blogs
    token_id          INTEGER PRIMARY KEY,           -- 全局唯一 · 后续推送时回带
    base_symbol       TEXT NOT NULL,
    blog_url          TEXT NOT NULL,
    fetch_url         TEXT,                          -- nullable
    blogpicker_id     INTEGER,                       -- blogpicker 的 id(不是主键)
    blogpicker_status TEXT,                          -- active / paused / disabled
    blogpicker_mode   TEXT,                          -- http / browser(blogpicker 自己分类)
    blogpicker_rule   INTEGER,                       -- blogpicker rule_id

    -- Crawlee 自己跑 probe 补的字段(probe.ts 输出)
    sitemap_url       TEXT,                          -- discoverValidSitemaps 找到的
    sitemap_count     INTEGER,                       -- sitemap 里有多少 URL
    fetch_strategy    TEXT,                          -- 'http' / 'sitemap' / 'playwright'
    og_quality        TEXT,                          -- 'full' / 'partial' / 'none'
    host_platform     TEXT,                          -- 'medium' / 'mirror' / 'substack' / 'ghost' / null
    http_status       INTEGER,                       -- 首页 HTTP 探测状态码(200/403/...)
    server_header     TEXT,                          -- HTTP HEAD 的 Server 头

    -- 元数据
    probed_at         TEXT,                          -- ISO timestamp · null=未探测
    created_at        TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at        TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sources_blog_url ON sources(blog_url);
CREATE INDEX IF NOT EXISTS idx_sources_fetch_strategy ON sources(fetch_strategy);
CREATE INDEX IF NOT EXISTS idx_sources_host_platform ON sources(host_platform);
CREATE INDEX IF NOT EXISTS idx_sources_og_quality ON sources(og_quality);
