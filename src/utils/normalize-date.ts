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
    // 🆕 2026-07-04 收敛轮(COLLECT 27/01/2026 实锤):D/M/YYYY 仅在日>12 无歧义时救 · ≤12 分不清日月不猜
    const dmy = /^(\d{1,2})\/(\d{1,2})\/((?:19|20)\d{2})$/.exec(s);
    if (dmy && Number(dmy[1]) > 12 && Number(dmy[2]) >= 1 && Number(dmy[2]) <= 12) {
        return new Date(Date.UTC(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]))).toISOString();
    }
    const t = Date.parse(s);
    if (Number.isNaN(t)) {
        // 🆕 2026-07-04 复检实锤(QUICK "March 15th 2025"):序数词/多余点号 Date.parse 不认 · 清洗后重试
        const cleaned = s.replace(/(\d)(?:st|nd|rd|th)\b/gi, '$1').replace(/(\w)\.(\s)/g, '$1$2');
        const t2 = Date.parse(cleaned);
        if (Number.isNaN(t2)) return '';
        return fixYearlessDefault(t2, s);
    }
    return fixYearlessDefault(t, s);
}

// 🆕 2026-07-05 核对战役实锤(KAVA "Wed Nov, 12" 型无年份日期):V8 Date.parse 缺年份默认落 2001
// 原串不含 "2001" 却解析出 2001 年 = 无年份格式 → 用当前年兜底;兜出未来 >48h 则回退一年(站点显示的是最近一次该日期)
function fixYearlessDefault(t: number, raw: string): string {
    const d = new Date(t);
    if (d.getUTCFullYear() === 2001 && !raw.includes('2001')) {
        const now = Date.now();
        d.setUTCFullYear(new Date(now).getUTCFullYear());
        if (d.getTime() - now > 48 * 3600 * 1000) d.setUTCFullYear(d.getUTCFullYear() - 1);
    }
    return d.toISOString();
}
