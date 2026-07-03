# 方案审计 · A5 维度:代理池前端可配置

> 审计对象:`docs/plan-ops-dashboard-2026-07-04.md`(计划书完全未覆盖此维度 · 老板 2026-07-04 新拍板)
> 审计依据:`docs/handoff-crawlee-poc-p2-2026-07-03.md` §2 + 现有源码实证(`src/main.ts` / `src/run-mirror.ts` / `src/handlers/medium.ts` / `.gitignore` / `systemd/*` 已 grep 核对,非拍脑袋)
> 结论先行:**存储选 SQLite 新表(方案 b)· 生效时机 = 下批次 · 设置页新增第 6 导航项 · 防呆用软阻断非硬阻断**

---

## 设计方案(可直接合入计划书的完整章节文段)

> 以下文段按计划书行文风格写就,建议作为**新增 §11**(在原 §10 之后、终版落定前合并),内部小节号独立编排,合并时按实际插入位置重排。

---

### 11. 代理池前端配置(2026-07-04 老板新拍板 · A2 第二个例外)

#### 11.0 拍板与张力

| # | 决策 | 拍板 |
|---|---|---|
| F | 代理池可配置 | 三代理池(主力/medium/slow)连接串**可在前端查看与修改**。这是继「告警 ack」之后 **A2(dashboard 只读)的第二个例外**——规则/名单改动仍 100% 走 Claude + git,不受本条影响 |

**张力说明**:§0-A 拍板「A2 · 常驻只读 dashboard」的原意是"业务规则改动走 git 有审阅",但代理池连接串不是业务规则,是**基础设施密钥**——它没有"对不对"的业务判断需要 Claude/git 走查,只有"通不通"的事实状态,且老板本人是直接持有密钥的人(池子是老板对接的资源方给的),不需要经过 Claude 中转编辑 git 文件这一层。这与「告警 ack」的例外性质相同:都是"运行时事实的直接操作",不是"业务逻辑变更"。**本节按此已拍板结论设计,不重新论证 A2 该不该开例外。**

#### 11.1 存储方案:三池连接串放哪

现状(已核实):服务器 `~/crawlee-blog-poc/.env.local`(不进 git)持有 `PROXY_URL` / `PROXY_URL_MEDIUM` / `PROXY_URL_SLOW` 三个 key,外加 `DASH_USER`/`DASH_PASS`(计划书 §7.1 拟定)等其他密钥共存一文件。旧 systemd service 用 `EnvironmentFile=-.env.local` 直接注入环境;手动跑走 `set -a; source .env.local; set +a`(handoff §9)。两条路径殊途同归:**环境变量在进程启动那一刻被读入,之后不变**。

| 方案 | 说明 | 密钥不进 git | 备份/留痕 | 采集器读取路径改动 | 审计留痕 |
|---|---|---|---|---|---|
| a. 仍 `.env.local` | dashboard 后端直接读写这个文本文件(解析/重写 KEY=VALUE 行) | ✓(前提:补 `.gitignore`,见风险清单) | ✗ 无历史,覆盖式编辑,改错了上一个值直接消失 | **零改动**(读取机制完全不变,仍是进程启动时环境变量注入) | 需要**另开**一个地方记 log(文件本身没有审计能力)→ 变相又要碰数据库,等于两处存储 |
| **b. SQLite 新表 `proxy_config`**(推荐) | 进 `storage/sources.db`,经 `shared/db.ts` + 新模块 `shared/proxy-config.ts` 读写 | ✓(`storage/` 已在 `.gitignore`,零额外动作) | ✓ 原生:改一次 = `config_audit` 追加一行,旧值可查 | 3 处 `process.env.X` 改成 `getProxyUrl('main'\|'medium'\|'slow')`(见 11.3) | ✓ 原生,与 alerts/runs 同一套 `shared/ledger.ts` 访问层习惯一致 |
| c. 独立 secrets 文件(如 `shared/proxy-secrets.json`) | 专开一个 JSON 只放代理配置 | ✓(需要新加 gitignore 项 —— 这类"需要记得再加一条 gitignore"的操作本项目已经出过一次疏漏,见风险清单) | ✗ 同 a,文本覆盖式 | 中等:仍要写一个读取模块,但比 db 简单 | ✗ 同 a,需另开库 |

**推荐:b(SQLite 新表)。理由:**

1. **计划书自己已经把这条路堵死给了唯一答案**——§9「明确不做」第 5 条白纸黑字:「不开第二个数据库/存储(一切进 sources.db)」。方案 a/c 都是在 `.env.local` 或新 JSON 之外**又开一个存储**,直接违反这条已拍板的红线;只有 b 符合。
2. **DASH_USER/DASH_PASS 留在 `.env.local` 不构成反例**:那是"进程自己启动时读一次的引导凭据",没有"前端查看/修改/测试连通性/审计"的需求。而代理池连接串现在被要求**全套 CRUD + 测试 + 审计**,这是一个完整的数据生命周期,和 `alerts`/`runs`表当初"为什么要进数据库"是同一个理由——只要有**审计/状态/生命周期**需求,就该进"一个库、一个访问层"里,不该留在纯 bootstrap 用的文本文件里。
3. **并发安全免费复用**:计划书 §10.3 已经拍板「SQLite 开 WAL(dashboard 读与批次写并发)」——这是专门为"dashboard 进程和采集进程同时碰同一份数据"解决的并发问题。代理池配置恰好也是这个场景(dashboard 写、main.ts 读),用 b 直接复用这套已经规划好的并发方案;用 a 则要自己解决"编辑 .env.local 时采集进程正在 `source` 它"的文本文件竞态(文本写入不是原子操作,理论上能读到半行)。
4. **审计留痕不需要二次开发**:选 a/c 时,"谁改了池子"这条审计需求依然要写进某个地方——写文件自己不会记日志,最终还是要挪一份记录进数据库,变成"值在文件、审计在库"的两处分裂存储,反而比直接方案 b 更绕。

**Schema(追加进 §4,同一个 `storage/sources.db`):**

```sql
CREATE TABLE IF NOT EXISTS proxy_config (
  pool TEXT PRIMARY KEY,             -- 固定三值:'main' / 'medium' / 'slow'(不做成开放列表)
  value TEXT NOT NULL,               -- 完整连接串明文(socks5://user:pass@host:port)
  updated_at TEXT NOT NULL,
  updated_by_ip TEXT,                -- 弱"谁"信号(单账号 basic auth 体系下唯一可辨识维度 · 见风险清单)
  last_test_at TEXT,
  last_test_ok INTEGER,              -- 0/1
  last_test_egress_ip TEXT,          -- 测试探到的出口 IP · 人工核对"真的换池了"用
  last_test_latency_ms INTEGER
);

CREATE TABLE IF NOT EXISTS config_audit (  -- 不复用 alerts 表(理由见 11.5)
  audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
  config_key TEXT NOT NULL,          -- 'proxy.main' / 'proxy.medium' / 'proxy.slow'(留前缀 · 未来其他可写配置可共用此表)
  old_value_masked TEXT,             -- 脱敏展示形式(人读)· 全程不存明文旧值
  new_value_masked TEXT,
  old_value_hash TEXT,               -- sha256 前 12 位(机器比对 · 与 runs 表关联见 11.6)
  new_value_hash TEXT,
  test_result TEXT,                  -- 'pass' / 'fail' / 'skipped'
  saved_despite_test_failure INTEGER DEFAULT 0,
  client_ip TEXT,
  at TEXT NOT NULL
);
```

**明文存储要不要加密?建议不加密,保持现状对等安全水位**:`.env.local` 现状也是明文(靠服务器文件权限保护),搬进 `sources.db` 后同样靠"谁能碰这台服务器/这个库文件"这条边界保护,并没有降低安全水位。若额外做应用层加密,会立刻遇到"加密密钥本身存哪"的套娃问题(SQLite 原生不带加密,上 sqlcipher 是新依赖,不符合"简洁优先"),不建议做。真正需要补强的是 11.5 的传输层(HTTPS)。

**迁移动作(实施清单,不属于 schema 本身但必须提前列出,防止上线当天三池显示为空造成"以为密钥丢了"的误判)**:执行 Claude 需要写一个一次性种子脚本,在服务器上读当前 `.env.local` 的三个值,`INSERT` 进 `proxy_config` 作为初始行,而不是留给老板重新手输三次密码。

---

#### 11.2 生效时机:下一批次生效,不做热更新

**结论:下一批次生效。不建议做热更新。**

**代码证据(已读源码,非猜测)**:`src/main.ts:361-363` 三个 `PROXY_URL*` 是模块顶层 `const`,在文件加载时求值一次,随后被 `new ProxyConfiguration({ newUrlFunction: ... })` 的闭包捕获,`generalCrawler`/`mediumCrawler`/`slowCrawler` 三个 crawler 实例在本次进程里只创建一次。要做到"热生效",需要把这些 const 改造成"每次请求都重新查库"的动态读取,这是对现有代码结构的侵入式改造,而不是"外科手术式"小改。

**论证(四点,支撑"没必要做热更新")**:

1. **架构天然对齐**:`runs` 表一行 = 一个批次 = main.ts 一次独立进程生命周期(`Type=oneshot` 语义,handoff 现有 systemd service 已如此;新调度方案调用的仍是同一份 main.ts,详见风险清单 R2)。"进程重启生效"与这个离散执行单元的边界完全重合,不需要另造"进程内热更新"机制。
2. **既有 precedent**:计划书 §5.1/§5.2 对 `schedule-config.json`(频率/并发/阈值)也是同一语义——"改频率 = 改 json + 重装 timer","并发参数缺省回落现有默认值"——都是下次启动生效,不是热更新。代理池保持同一套生效时机语义,是架构一致性的自然延伸。
3. **真实运维场景不需要热更新**:场景 A(池子已被封,要紧急换池)——当前批次大概率已经在拿坏池子失败,"热更新剩下的请求"补救价值有限;更干净的止损是**当前批次跑完/被杀,下一批次用新池重跑**。场景 B(平时维护性调整)——完全不急,等下一批次(默认 hourly)毫无问题。
4. **紧急止损已有更简单的组合拳,不需要再发明热更新**:§5.4 已有 flock 超时机制可以"杀当前批次";改完配置后,若不想等到整点,应该是"手动立即触发一次批次"这个能力(见下方 R4,这属于调度维度,不是代理池维度需要解决的)。两个已有/待有能力组合 = 紧急止损,不需要给代理池单独造一个热更新特例。

**UI 落地**:保存成功后的提示文案必须明确写生效时间,不能让老板以为是热生效:

> "已保存 · 将在下次批次(预计 `{下次运行时间}`)生效,当前批次不受影响"

`{下次运行时间}` 直接复用 §7.1 `GET /api/summary` 里已有的"下次运行时间"字段,不需要新字段。

---

#### 11.3 消费点改造清单(外科手术式 · 三处,不是一处)

**已用 grep 核实,`process.env.PROXY_URL*` 在源码里有三个独立读取点,不是只有 main.ts 一处**——这是本次审计的一个关键纠偏,若执行 Claude 只改 main.ts,会漏掉另外两处,造成"UI 上显示已更新、某条管线实际仍在用旧池"的隐蔽不一致:

| 文件:行 | 用途 | 读取方式 |
|---|---|---|
| `src/main.ts:361-363` | 主流程三池(`PROXY_URL`/`_MEDIUM`/`_SLOW`),`_MEDIUM`/`_SLOW` 各自有 `\|\| PROXY_URL` 回落主池语义 | 模块顶层 const |
| `src/run-mirror.ts:17` | mirror 独立进程(`RUN_MIRROR=1` 才跑,P3 Playwright 相关,默认跳过) | 模块顶层 const,只读 `PROXY_URL` |
| `src/handlers/medium.ts:127` | `fetchAndPushRssFeeds`(2026-07-03 新加的"通用 RSS 直拉"第五路管线,走 Impit 直连,不经 main.ts 的 `ProxyConfiguration` 对象) | 函数内联 `process.env.PROXY_URL \|\| undefined` |

**新增 `shared/proxy-config.ts`(与 `shared/config.ts` 同构:db 优先 · 回落 env · 同步读取,保持"缺省回落"这条计划书已确立的向后兼容习惯)：**

```ts
// db 优先 · 表未迁移/该池未配置时回落现有 env(向后兼容 · 手动裸跑不受影响)
export function getProxyUrl(pool: 'main' | 'medium' | 'slow'): string {
    const row = db.prepare('SELECT value FROM proxy_config WHERE pool = ?').get(pool) as { value?: string } | undefined;
    if (row?.value) return row.value;
    const envKey = { main: 'PROXY_URL', medium: 'PROXY_URL_MEDIUM', slow: 'PROXY_URL_SLOW' }[pool];
    return process.env[envKey] ?? '';
}
```

三处改动都是"1 行替换 + 顶部 1 行 import",职责边界清楚:**`main.ts` 里 `_MEDIUM`/`_SLOW` 回落主池的业务语义保留在 main.ts 原地**(`getProxyUrl('medium') || getProxyUrl('main')`),不下沉进 `getProxyUrl` 本身——`getProxyUrl` 只管"单个 pool 的 db/env 兜底",不掺业务编排。

**⚠️ 一个应在实施前问清楚、不属于本次存储设计范围的疑点**:`handlers/medium.ts:127` 读的是主池 `PROXY_URL`,而不是语义上更贴近的 `PROXY_URL_MEDIUM`(main.ts 注释里 `PROXY_URL_MEDIUM` 的用途写的是"medium 专用池 · mediumCrawler(RSS)+ slow 队列的 medium 域",不包含这条新的"通用 RSS 直拉"管线)。不确定这是有意设计(通用 RSS 直拉刻意用主池分流压力)还是 2026-07-03 加新管线时的历史遗漏。**这不影响存储方案本身,但直接影响 UI 文案的准确性**——如果 UI 上"medium 池"卡片写"服务于 medium 生态 RSS 抓取",老板会以为改了 medium 池就能影响通用 RSS 直拉,但代码事实是它用的主池。UI 文案必须照抄代码真实消费范围,不能按池名望文生义。

---

#### 11.4 UI 设计

**放哪一页:新增第 6 导航项「设置」**(而非塞进"源管理")。

理由:代理池是 3 行固定结构的全局基础设施配置,信息形态和"源管理"页的 634 行可搜索业务数据表完全不同,硬塞进去既污染源管理页的单一职责,也没有自然的表格位置可放。计划书 §8 二期本就规划了"push 账本页 · 巡检 diff 页"两个新页面,说明"一期五页"从来不是永久天花板,只是当时的范围控制;现在只是把"加新页"这件事从二期提前到一期。**⚠️ 与 §0-UI「一期五页」这条已拍板条目存在字面冲突,不擅自突破,列入下方"需要老板拍板"。**

**页面内容:**

| 区块 | 内容 |
|---|---|
| 三池卡片 | 每池一张卡:池名+用途说明(照抄 11.3 代码事实,不脑补)/ 脱敏连接串(`socks5://blog:•••@admin-pool.hhwlnet.com:1080`)/ 最后修改时间 / 最后测试结果(✅ + 出口IP + 延迟 或 ❌ + 失败原因)/「跟随主力池」badge(medium、slow 未独立设置时,如实反映 main.ts 的 `\|\| PROXY_URL` 回落语义,不能让 UI 显示"空"给人一种"没配置"的错觉) |
| 编辑表单 | 点「编辑」展开:**分字段输入**(host / port / user / pass 四框拼接,而非整串 textarea)——分字段能在提交前做基本格式校验(如 port 必须数字),防止手滑打错 scheme 或漏打冒号导致整串解析失败;明文只在编辑态短暂出现,提交后立即回退为脱敏展示,不长期挂在 DOM 上 |
| 「测试连通性」按钮 ×2 处 | ①编辑表单内,输入新值后先测再存(见 11.5 防呆)②每张已保存池卡片上也有一个独立测试按钮,支持日常巡检"这个池现在还活着吗",不必等 detector 环比告警才发现 |
| 最近变更 | 折叠面板,拉 `config_audit` 最近 N 条(谁/何时/哪个池/测试是否通过) |

**连通性测试:必须是服务器侧发起、用生产同款指纹,不能是浏览器直接打 `api.ipify.org`**(浏览器发起不经过服务器配置的代理,测不出"这个池到底通不通")。**直接复用 `scripts/probe-fetch.ts` 已验证的配方**(`impit` + `browser: 'chrome'` 指纹,项目铁律"诊断一律生产指纹,严禁裸 curl"的落地对象不只是人工诊断,dashboard 的自动化测试同样要遵守,否则会重演 handoff §8「agent 裸 curl 假反爬」的教训,只是这次是"UI 测试通过"和"生产实际会通"两码事的翻版)。建议抽一个 `shared/proxy-test.ts` 小helper 给 dashboard 后端调用:

```ts
// 目标固定 https://api.ipify.org?format=json · 传入待测池的连接串(可以是还没保存的候选值)
export async function testProxy(proxyUrl: string): Promise<{ ok: boolean; ip?: string; latencyMs?: number; error?: string }> { ... }
```

**加一次不走代理的直连基线对照请求**,避免第三方服务(api.ipify.org)自己抽风时被误判成"代理池坏了":若"走代理"和"不走代理直连"两次请求同时失败,大概率是 ipify 自己的问题,不是代理的锅;只有"直连成功、走代理失败"才是真正确诊代理池有问题。

**API(追加进 §7.1 只读 API 表,注意这几个是写操作)：**

| API | 说明 |
|---|---|
| `GET /api/proxy-config` | 三池当前状态(脱敏值/是否跟随主池/最后修改/最后测试) |
| `POST /api/proxy-config/:pool/test` | 纯只读探测,不写库;body 可传候选新值(编辑中测试)或不传(测当前生效值) |
| `PUT /api/proxy-config/:pool` | **写操作 #2**(继告警 ack 之后)。body `{ value, force? }`:先做格式校验,再自动跑一次连通性测试;测试失败且未带 `force:true` → 返回 422 + 测试详情,前端弹确认;确认后带 `force:true` 重提 → 写 `proxy_config` + 追加一行 `config_audit` |
| `GET /api/proxy-config/audit?limit=20` | 最近变更历史 |

**三态截图(呼应老板全局铁律"UI 改动必 playwright 截图三态"及计划书 §8 验收标准要求)**:①初始态(三池只读脱敏卡片)②操作中态(编辑表单展开 + 测试 loading/结果)③完成态(保存成功提示 + 最近变更出现新一行)。

---

#### 11.5 安全设计

**传输**:basic auth 本身是明文凭据,在它之上唯一有实际意义的加固是 **TLS**,不建议额外做应用层加密(比如前端先加密连接串再传)——basic auth 密码都能被截获的前提下,单独给 PUT body 加密属于"门没锁但保险箱上锁",防不住真正的威胁模型,只增加复杂度。§7.1 现有方案把 HTTPS 列为"有 nginx/caddy 就套、没有就记二期"的柔性处理,这是在"全程只读"的前提下合理的优先级;**但代理池一旦变成可写,意味着高敏感明文密钥会更高频地在公网上过 HTTP 明文**,风险量级变了,建议把"至少这一个写端点的传输加密"从"记二期慢慢来"提到"一期强制项"(详见风险清单 R1 和拍板点)。

**展示脱敏**:任何返回给前端的 GET 响应,连接串一律走 mask 函数,永不吐明文,即使 basic auth 已过:

```ts
// socks5://user:pass@host:port → socks5://user:•••@host:port
const maskProxyUrl = (url: string) => url.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:•••@');
```

**审计:新开 `config_audit` 表,不复用 `alerts` 表(info 级)。理由**:`alerts` 是计划书 §2/§6 定义好的**状态机**(open → 持续 → resolved/ack),服务的是"detector 纯函数从环比信号推导出的系统异常";而代理池变更是**人为操作的一次性事件**,没有"resolve"这个概念,硬塞进 alerts 会让这张表同时承担"机器判定的健康状态"和"人操作的审计流水"两种不同性质的语义,污染 detector 的查询逻辑(比如"只看真异常"以后要多一层 type 过滤才能排除人操作记录)。独立小表职责更干净,且未来其他可写配置(如果有)可以共用同一张 `config_audit`。

**"谁"改的局限性,如实标注**:计划书 §9「明确不做」已拍板"不做用户体系(单账号 basic auth)"——这意味着"谁改的"天然退化成"知道这个密码的人",无法区分具体是谁。本设计用 `client_ip` 做**弱**信号(至少能分办公网/家/服务器本机 SSH 隧道等),但这不是真正的身份审计。如果未来这条审计维度真的重要,需要引入多用户体系,这明显超出本次范围,只记录在案,不现在做。

**防呆(改错串导致全军覆没):推荐软阻断(测试失败仍可强制保存,需二次确认),不建议硬阻断(测试不过禁止保存)。**

老板原话带了个问号("保存前强制连通性测试通过?"),这是提议不是定案,这里给出完整论证:

- 硬阻断的自锁风险:代理池配置**恰恰是在出故障时最需要修改**的东西——如果当前池已死、老板想换一个新池的地址,而新地址因为运营商刚开、还在预热/传播中导致测试暂时不通过,硬阻断会锁死"救火"这个动作本身,变成"越是需要改的时候越改不了"。此外 `api.ipify.org` 本身若抽风也会连带把合法的新值一起挡在门外。
- 软阻断已经足够:自动测试 + 测试结果摆在老板面前 + 需要一次明确的"我知道有风险仍要保存"确认(勾选框或二次点击),把"改错的后果"从静默变成显性提示,但不剥夺老板在紧急情况下的操作权。`config_audit.saved_despite_test_failure` 字段把这类"明知有风险仍保存"的操作单独打标,方便事后复盘。
- **连通性测试的能力边界要写清楚,不能让人误以为测试通过=万事大吉**:测试只能排除"完全不可达/账密错/host 写错"这类硬故障,排除不了"新池 IP 被特定目标站限流/软封"这类软故础(ipify 不做反爬检测,永远会通)。软故障只能靠 11.6 的账本哈希关联在下一批次数据出来后才能确诊。**这两道防线是互补关系,不是替代关系**——不能因为有了测试按钮就误以为不再需要账本关联,反之亦然。

---

#### 11.6 变更与账本联动

**`runs` 表(§4)追加三列,记录本轮实际生效的池子指纹:**

```sql
-- 追加进 §4 runs 表 CREATE TABLE 内,与既有 git_commit 字段同一用途(版本归因),只是归因对象从"代码版本"换成"池子版本"
proxy_main_hash TEXT,     -- sha256(生效值) 前 12 位 · node:crypto 内置,不引新依赖
proxy_medium_hash TEXT,
proxy_slow_hash TEXT,
```

**写入者:`run-batch.ts`**(批次起跑、生成 `run_id` 的同一时刻,调用 `getProxyUrl()` 三次算出哈希落进这一行),与 `git_commit` 字段同一写入者、同一写入时机,不新增写入点,不违反 §3.3「一个写入点」原则。

**用途示例(直接回答"换池后失败率变化归因")**:

```sql
SELECT run_id, started_at, proxy_main_hash, requests_failed, http_403
FROM runs ORDER BY started_at DESC LIMIT 50;
-- 肉眼/脚本对比:proxy_main_hash 变化的那一行前后,requests_failed/http_403 是否跳变
```

这组哈希列同时也是 11.5 提到的"账本兜底"的落地方式:`config_audit.new_value_hash` 与某次改动对应的 `runs.proxy_main_hash` 可以直接 `=` 关联,做到"从审计记录一路查到它影响了哪几轮、这几轮表现如何"的完整归因链路,不需要额外的关联表。

---

#### 11.7 分池映射(`throttled_domains`)是否也进前端:一期不做,仍走 git

理由(四条,供直接采纳):

1. **已被现有拍板明确划界**:`throttled_domains` 是 `src/utils/filter-config.json` 的一部分,而这个文件整体已经在 §0-A/§9 被定义为"采集器业务规则,UI 不碰,改动走 Claude + git"的范围。单独把这一个字段挪出来做例外,没有获得对应的拍板授权。
2. **文件内字段深度耦合,拆一半会制造双头管理**:`filter-config.json` 里 `throttled_domains` 和白名单/`dead_hosts`/`dc_banned_hosts` 是同一份文件里互相关联的判断产物(比如一个 host 从 `throttled_domains` 挪到 `dc_banned_hosts` 是需要结合探测证据的业务决策,不是"选个下拉框"式的数据编辑)。只做前端可编辑其中一段,会让这份"单一真源"文件出现"部分字段 UI 管、部分字段 git 管"的分裂状态,且这个文件被"TS/python/HTML 三层共读"(handoff §2),改动面比代理池大得多。
3. **数据形态不匹配"3 行表单"级别的工作量**:代理池连接串是"固定 3 个 key"的封闭集合,天然适合表单;`throttled_domains` 是"域名 → 池"的开放映射,域名集合随规则演化持续变动(近期就有"C 类 9 源规则补齐"这类高频变更),前端化意味着要做一套小型 CRUD(域名列表 + 池选择器 + 校验),这不是老板本次拍板字面提到的范围。
4. **超出老板本次拍板的字面表述**:老板原话是"代理是分池的……这些**代理数据**最好也能在前端设置",指的是连接串本身,没有提"分流规则"。不应该借着这次拍板顺带把范围扩大到规则管理,符合"最小改动不连锁"和"不允许擅自修改已确认参数"两条工作铁律。

**⚠️ 标注拍板点**:以上是审计员给出的强理由建议,但"要不要顺便做"仍是本次拍板范围外的解读,按"多种解读列出来"的原则列入下方拍板清单,防止老板其实有隐含期待但没被听到。

---

#### 11.8 架构关系图(补充进 §3 全局图)

```
dashboard 设置页(编辑池串)
     │ PUT /api/proxy-config/:pool(basic auth · 软阻断二次确认)
     ▼
ops/server ──写──▶ proxy_config 表 ──┐
     │                                │   (sources.db · 同一个库 · 同一访问层)
     └──写──▶ config_audit 表 ◀───────┘
                                       │
src/main.ts ─┐                        │
src/run-mirror.ts ├─ getProxyUrl() ───┘  读:db 优先 · env 兜底 · 各自进程启动时读一次 · 下批次生效
src/handlers/medium.ts ─┘
                                       │
run-batch.ts(批次起跑时)──写──▶ runs.proxy_{main,medium,slow}_hash(本轮生效值指纹 · 呼应 git_commit 同一归因用途)
```

---

#### 11.9 验收标准(建议追加进 §8 一期交付表)

| # | 交付物 | 验收标准 |
|---|---|---|
| 8 | 代理池前端配置(`proxy_config`+`config_audit`+3 处消费点改造+设置页) | 三池脱敏正确显示且"跟随主池"badge 与代码 `\|\|` 回落语义一致;编辑保存后 `config_audit` 新增一条且哈希可比对;`main.ts`/`run-mirror.ts`/`handlers/medium.ts` 三处均已切换且下一批次 `runs.proxy_*_hash` 与保存值一致;连通性测试为服务器侧真实探测(impit 生产指纹,非 mock/非浏览器直连)且能区分"代理故障"与"目标(ipify)故障";故意保存一个测试不通过的串能触发二次确认且被 `saved_despite_test_failure` 记录;三态(初始/编辑测试中/完成)playwright 截图 |

---

## 问题/风险清单(严重度)

| 严重度 | 发现 | 证据 | 影响 | 建议 |
|---|---|---|---|---|
| 🔴 高 | 代理池"可写"后,高敏感明文密钥会更高频经公网 HTTP 明文传输 | §7.1 现状把 HTTPS 列为"没有就先记二期"的柔性处理,当时前提是"全程只读" | 密钥被公网嗅探的窗口从"几乎不存在"变成"每次改池都过一遍明文" | 建议本功能(至少这一个 PUT 写端点)的传输加密从二期提前到一期,哪怕只是先用 SSH 隧道/stunnel 顶上,不必等通用 HTTPS 铺开 |
| 🟡 中 | "调度进运维台进程"这条平行拍板,若导致 main.ts 从"独立子进程"变成被长驻 ops 进程 `import` 直接调用,会让"下批次生效=进程重启生效"这条核心论证失效 | main.ts 现有 `process.exit(0)` 是专门为"并行后进程不退"这个历史 bug 修的(handoff §8);计划书 §10.3 已拍板 dashboard 内存预算 <200MB,而爬虫本身是重资源进程,两者按常理不会揉进同一进程 | 若真发生,代理池"改配置去哪读"的时机语义要重新论证 | 建议与负责"调度废弃 systemd"维度的审计员对齐一句话结论:main.ts 在新方案下是否仍是独立 spawn 子进程。大概率是(内存预算已经暗示答案),但要明确写进最终版,不能靠"大概率"过关 |
| 🟡 中 | `PROXY_URL*` 有 3 个独立读取点(`main.ts`/`run-mirror.ts`/`handlers/medium.ts`),不是只有 1 处 | grep 实证,见 11.3 表格 | 迁移若只改 main.ts,会出现"UI 显示已更新、某条管线仍用旧值"的隐蔽不一致,尤其 `handlers/medium.ts` 是 2026-07-03 刚上的新管线,最容易被漏改 | 实施 checklist 显式列出这 3 个文件:行号,不允许笼统写"改 main.ts 的代理读取" |
| 🟡 中 | `handlers/medium.ts:127` 的"通用 RSS 直拉"读的是主池 `PROXY_URL`,不是语义上更贴近的 `PROXY_URL_MEDIUM` | 同上 grep,对照 `main.ts:359` 注释("`PROXY_URL_MEDIUM` … mediumCrawler(RSS)+ slow 队列的 medium 域",未提这条新管线) | 不确定是有意设计还是历史遗漏;若 UI 文案照"池名"望文生义写"medium 池服务于 medium 生态抓取",会与代码事实不符,老板可能改错池却以为改对了 | 实施前一句话问清楚是否有意;不论答案是什么,UI 文案必须照抄代码真实消费范围 |
| 🟡 中 | 连通性测试单独依赖第三方 `api.ipify.org`,该服务本身抽风会污染判断 | 任务要求原文即指定 ipify | 可能把"ipify 自己挂了"误判成"代理池坏了",导致误报 | 加一次不走代理的直连基线对照请求,两者同时失败才判定"非代理问题"(已写入 11.4 设计) |
| 🟡 中 | `.env.local` 目前**不在** `.gitignore` 覆盖范围内 | 已读 `.gitignore` 实证:仅有 `.idea/dist/node_modules/storage/docs-reference/.tmp/.claude/.playwright-mcp/__pycache__`,无任何 `.env*` 规则;本地也确认没有 `.env.local`,只有 `.env.example` | 现状纯靠"从未 `git add` 过"侥幸不泄露;一旦有人在服务器上手滑 `git add -A`,三池密钥 + `DASH_USER`/`DASH_PASS` 会被一并暂存。本次若仍保留 `.env.local` 作为 `getProxyUrl()` 的 env 兜底来源,这个缺口依然在场 | 顺手补一条 `.env.local` 进 `.gitignore`(与本次任务强相关的最小追加,非顺手重构无关代码,符合"外科手术式改动") |
| ⚪ 低 | 单账号 basic auth 体系下,"谁改的"审计维度天然弱化为"密码持有者",无法做到人的粒度 | 计划书 §9 已拍板"不做用户体系" | 审计价值打折扣,但符合已拍板的系统边界 | 用 `client_ip` 做弱信号即可,不建议现在引入多用户体系;仅记录在案,若未来审计需求变强再议 |
| ⚪ 低 | 保存时的并发覆盖竞态(两人同时改同一池,后提交覆盖先提交) | 设计推演,非实测 | 窗口极窄(单账号、低频操作),后果可通过 `config_audit` 追溯但无法自动阻止 | 不建议做乐观锁(版本号/if-match)这种复杂机制,现阶段"事后可查"已经足够 |

---

## 需要老板拍板的点

| # | 问题 | 选项 | 审计员建议 |
|---|---|---|---|
| A | 存储方案 | a. 仍 `.env.local` / **b. SQLite 新表 `proxy_config`** / c. 独立 secrets 文件 | **b**(§9 已拍板"一切进 sources.db"实际上已经把这题定死,列出来是为了让老板知晓这个推导链条,不是真的三选一) |
| B | 设置页放哪 | A. 新增第 6 导航项「设置」(突破"一期五页") / B. 硬塞进"源管理"页 | **A**,但与 §0-UI「一期五页」拍板字面冲突,需要老板明确松口"加第 6 页" |
| C | 保存前防呆力度 | A. 软阻断(测试不过仍可二次确认强制保存) / B. 硬阻断(测试不过禁止保存) | **A**,理由见 11.5(硬阻断在"池子已死急需换新池"这个最需要用到本功能的场景下会自锁) |
| D | `throttled_domains` 要不要一并进前端 | A. 一期不做,仍走 git / B. 一并做成前端可编辑 | **A**(理由见 11.7),但这是本次拍板字面范围外的延伸解读,单独确认一下没有隐藏期待 |
| E | 传输加密是否因"代理池可写"从二期提前到一期 | A. 提前到一期(至少这一个写端点) / B. 维持二期,先接受明文风险窗口 | **A** |
| F | `handlers/medium.ts` 用主池而非 medium 池是否有意 | A. 有意(维持现状,UI 文案照实写) / B. 遗漏(应改用 `PROXY_URL_MEDIUM`,但这是代码改动,超出本次"前端配置"任务范围,需另立小任务) | 不确定,需要一句话确认,不影响存储方案本身,只影响 UI 文案措辞 |
| G | main.ts 在"调度进运维台进程"新方案下是否仍是独立 spawn 子进程 | 需与调度维度审计对齐,非本维度能单独拍板 | 大概率是(内存预算已暗示),但需要明确写进最终版 |
