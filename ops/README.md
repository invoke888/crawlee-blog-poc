# 运维台 SOP(计划书 `docs/plan-ops-dashboard-2026-07-04.md` 的落地)

## 架构一句话
采集器(src/ · 被 spawn)+ 运维台(ops/ · 常驻:调度+分析+推送+六页 UI)+ shared/(唯一数据层)→ 全在 `storage/sources.db`。

## 装
```bash
# 1. .env.local 需有:DASH_USER / DASH_PASS(+ 原有 PROXY_URL 三件套作 DB 兜底)
# 2. 进程守护(老板拍 C:systemd 仅保活 · 无 timer)
sudo cp ops/deploy/ops-dashboard.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now ops-dashboard
# 3. 首次启动自动:建表 · seed 配置默认值 · 代理串从 env 迁入 proxy_config
# 4. HTTPS(一期强制):服务器有 nginx/caddy 则反代 8787 套证书;无则 caddy 单二进制:
#    caddy reverse-proxy --from your.domain --to localhost:8787
```

## 日常
| 事 | 怎么做 |
|---|---|
| 看运行状态 | dashboard 总览页(脉搏行/批次带)· 栏底常驻调度状态 |
| 改采集频率/并发/深度/告警阈值 | 设置页 · 下批次/下个 tick 生效(app_config 单一真相) |
| 换代理池 | 设置页代理卡 · 编辑→自动测试→保存(失败可二次确认强存)· 下批次生效 |
| 手动跑一轮 | 总览页「▶ 立即跑一轮」(忙时 409 拒绝) |
| 单源重采 | 源管理页行内「重采」按钮 |
| 暂停/恢复调度 | 栏底状态点击切换 |
| push 失败重推 | 博文页 push 列「重推」按钮 |
| reset(清采集状态重来) | `npx tsx ops/reset.ts --confirm`(只清 datasets/request_queues/key_value_stores · **绝不碰 sources.db**) |
| 裸跑调试采集器 | `npx tsx src/main.ts`(不写账本 · 产物由下轮批次补漏扫描收进 articles) |

## 数据与留存
- 永久:runs / source_runs / articles / alerts / 配置(账本资产 · reset 也不清)
- 30 天:crawl_errors + storage/logs/<run_id>.log(run-batch 收尾自动清)
- 磁盘预算:单轮日志 ~200KB × 24 × 30 ≈ 150MB;dataset 增长由 dataset_bloat 告警盯

## 排障
- 调度没跑:栏底心跳 >5min ⚠️ → `sudo systemctl restart ops-dashboard`;journalctl -u ops-dashboard
- 批次卡死:超时自动 SIGTERM→SIGKILL + timeout 告警;进程硬死 → 下次启动自动标 crashed + 告警
- 面板改了没生效:配置都是**下批次**生效(采集器 spawn 时读 DB);当前批次不受影响是设计
