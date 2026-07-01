#!/usr/bin/env python3
# 把报告 JSON 嵌进 HTML(本地跑)
# 用法: python3 scripts/embed-report.py [json 路径] [html 路径]
# 默认: docs/poc-report-data.json → docs/poc-recap-2026-06-30.html
#
# 步骤(历史教训固化):
#   1. reload + json.dumps 重 dump — 强制 escape 所有 control char(修过 raw \n 让浏览器 JSON.parse 挂的 bug)
#   2. split 法替换(不用 regex — backslash 会被 re 解析出错 · 修过一次)
#   3. 从 disk 重读 + json.loads 二次验证(第一次嵌完没验被老板抓过)
import json, os, sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JSON_PATH = sys.argv[1] if len(sys.argv) > 1 else os.path.join(REPO, 'docs/poc-report-data.json')
HTML_PATH = sys.argv[2] if len(sys.argv) > 2 else os.path.join(REPO, 'docs/poc-recap-2026-06-30.html')

data = json.loads(open(JSON_PATH).read())
clean = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
bad = sum(1 for c in clean if ord(c) < 0x20)
assert bad == 0, f'clean json 还有 {bad} 个 raw control char'
assert '</script>' not in clean.lower(), 'json 含 </script> · 会截断 script tag'
open(JSON_PATH, 'w').write(clean)

html = open(HTML_PATH).read()
ST = '<script id="data" type="application/json">'
EN = '</script>'
i = html.find(ST)
assert i >= 0, 'HTML 找不到 data script 开始 tag'
j = html.find(EN, i + len(ST))
assert j >= 0, 'HTML 找不到 data script 结束 tag'
open(HTML_PATH, 'w').write(html[:i + len(ST)] + clean + html[j:])

# 二次验证:disk 重读 + parse
html2 = open(HTML_PATH).read()
i2 = html2.find(ST)
j2 = html2.find(EN, i2 + len(ST))
data2 = json.loads(html2[i2 + len(ST):j2])
print(f'✅ 嵌入完成 · HTML {os.path.getsize(HTML_PATH)} bytes · 重读 parse OK')
print(f'   summary: {data2.get("summary")}')
m = data2.get('meta', {})
if m:
    print(f'   meta: 白名单命中 {m.get("whitelist_hit_sources")} 源 · 丢文件型 {m.get("dropped_file_urls")} · 丢非白名单 {m.get("dropped_non_whitelist")}')
