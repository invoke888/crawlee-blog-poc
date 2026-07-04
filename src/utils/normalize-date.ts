// 🆕 2026-06-30 published_at 统一 ISO-8601 normalizer
// memory: project-todo-published-at-iso8601-normalizer (老板 2026-06-29 拍 · 2026-06-30 落地)
// 输入任意时间格式 · 输出 ISO-8601 (YYYY-MM-DDTHH:mm:ss.sssZ)
// Date.parse native 已支持 ISO-8601 + RFC-822/2822 · 不引外部库 (不重复造轮子)
// 🆕 2026-07-03 行为变更(老板拍 E-B1 · 自测实锤 BABY 'Insert Publish Date' 占位符入库):
// 解析失败 → 置空(不再透传原值 · published_at 字段只装 ISO 或空 · 下游 push 干净)

export function normalizePublishedAt(raw: string | null | undefined): string {
    if (!raw) return '';
    const s = String(raw).trim();
    if (!s) return '';
    // 纯数字特殊处理(OXT 实测 "1658775500" · 且 Date.parse('12345')=公元12344年 乱解析)
    // 只认:10 位秒级 / 13 位毫秒级时间戳(2001+)· 4 位合理年份 · 其他纯数字(slug/id)置空
    if (/^\d+$/.test(s)) {
        if (s.length === 10) {
            const t = Number(s) * 1000;
            if (t > 978307200000) return new Date(t).toISOString();
        }
        if (s.length === 13) {
            const t = Number(s);
            if (t > 978307200000 && t < 9999999999999) return new Date(t).toISOString();
        }
        if (s.length === 4) {
            const y = Number(s);
            if (y >= 1990 && y <= 2035) return new Date(Date.UTC(y, 0, 1)).toISOString();
        }
        return '';
    }
    const t = Date.parse(s);
    if (Number.isNaN(t)) {
        // 🆕 2026-07-04 复检实锤(QUICK "March 15th 2025"):序数词/多余点号 Date.parse 不认 · 清洗后重试
        const cleaned = s.replace(/(\d)(?:st|nd|rd|th)\b/gi, '$1').replace(/(\w)\.(\s)/g, '$1$2');
        const t2 = Date.parse(cleaned);
        if (Number.isNaN(t2)) return '';
        return new Date(t2).toISOString();
    }
    return new Date(t).toISOString();
}
