// 🆕 2026-06-30 published_at 统一 ISO-8601 normalizer
// memory: project-todo-published-at-iso8601-normalizer (老板 2026-06-29 拍 · 2026-06-30 落地)
// 输入任意时间格式 · 输出 ISO-8601 (YYYY-MM-DDTHH:mm:ss.sssZ)
// Date.parse native 已支持 ISO-8601 + RFC-822/2822 · 不引外部库 (不重复造轮子)
// 不能解的格式 → 透传原值 (不丢数据 · 老板后续看到能定位异常)

export function normalizePublishedAt(raw: string | null | undefined): string {
    if (!raw) return '';
    const s = String(raw).trim();
    if (!s) return '';
    // 🆕 2026-07-03 纯数字特殊处理(OXT 实测 "1658775500" · 且 Date.parse('12345')=公元12344年 乱解析)
    // 只认:10 位秒级 / 13 位毫秒级时间戳(2001+)· 4 位合理年份 · 其他纯数字透传不给 Date.parse 碰
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
        return s; // 其他纯数字(slug/id)透传
    }
    const t = Date.parse(s);
    if (Number.isNaN(t)) return s;
    return new Date(t).toISOString();
}
