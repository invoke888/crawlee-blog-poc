// 🆕 2026-06-30 published_at 统一 ISO-8601 normalizer
// memory: project-todo-published-at-iso8601-normalizer (老板 2026-06-29 拍 · 2026-06-30 落地)
// 输入任意时间格式 · 输出 ISO-8601 (YYYY-MM-DDTHH:mm:ss.sssZ)
// Date.parse native 已支持 ISO-8601 + RFC-822/2822 · 不引外部库 (不重复造轮子)
// 不能解的格式 → 透传原值 (不丢数据 · 老板后续看到能定位异常)

export function normalizePublishedAt(raw: string | null | undefined): string {
    if (!raw) return '';
    const s = String(raw).trim();
    if (!s) return '';
    const t = Date.parse(s);
    if (Number.isNaN(t)) return s;
    return new Date(t).toISOString();
}
