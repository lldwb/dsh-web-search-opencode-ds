# dsh-web-search-opencode-ds

把 **OpenCode** 注册为 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 的网页搜索提供方：
让模型侧的 `web_search` 工具**经 OpenCode 调用 DeepSeek 官方的服务端搜索**，
并在 dsh 的 **设置 → 插件** 里提供一张和官方「网页搜索」同款的配置页。

本仓库是一个 dsh **bundle**，而且是**双面**的一个：`index.js` 是 Host 半（注册 `opencode-ds` provider、
声明 Config schema），`client.js` 是浏览器半（画那张设置页）。两半由同一个包交付。

名字里没有 `go`：**Go 套餐只是同一个端点家族里的一个选项**（`goMode` 开关），不是这个插件的身份。

| | |
|---|---|
| 包名 / Loader 行 id | `dsh-web-search-opencode-ds` |
| provider id | `opencode-ds` |
| 设置命名空间 | `web-search-opencode-ds`（= Loader 行 id） |
| 默认端点 | `https://opencode.ai/zen/go/v1`（Go 套餐，包月） |
| 备用端点 | `https://opencode.ai/zen/v1`（按量计费） |

> 为什么是 bundle 而不是另写一个搜索后端：在 dsh 里，`ctx.web` 这一层已经定义了
> `WebSearchProvider` 契约，DeepSeek 的服务端 `web_search` 又是 OpenCode 直接提供的**原生工具**。
> 插件要做的只是把请求按 OpenCode 的 wire format 发出去、把结果映射回 `WebSearchSource`，
> 而不是自己去抓网页、拼摘要。

---

## 1. 实测验证结论

以下每一条都是**当天对线上端点实打实请求出来的**，不是从文档抄的。

| 观察 | 结果 |
|---|---|
| `POST /zen/go/v1/messages` + `model: deepseek-v4-flash` + `tools:[{type:'web_search_20250305'}]` | **HTTP 200**，返回真实 `web_search_tool_result`（本次 10 条结果） |
| 同上，但**不带** `x-opencode-session` | **HTTP 400** `{"type":"error","error":{"type":"MissingSessionID",...}}` |
| 只带 `Authorization: Bearer`（不带 `x-api-key`） | **HTTP 401** `AuthError: Missing API key.` |
| 只带 `x-api-key` | **HTTP 200** |
| `GET /zen/go/v1/models` | 200，**43** 个模型，含 `deepseek-v4-flash` |
| `GET /zen/v1/models` | 200，**85** 个模型，也含 `deepseek-v4-flash` |
| `POST /zen/v1/messages`（按量计费端点） | **HTTP 402** `Insufficient account funds` —— 路由与鉴权都通，**只是这个账户没有按量余额** |
| 候选会话创建路径（`/sessions`、`/session`、`/zen/v1/sessions`…） | **全部 404** —— 根本没有「先建会话」这一步 |

### 由此得到的硬结论

1. **`x-opencode-session` 是强制头，而且由客户端自己生成。** 默认每次搜索新生成一个 UUID v4
   （`sessionMode: 'per-request'`），`'stable'` 则全程复用同一个。既然没有注册端点、响应里也没有
   会话 id，「先创建会话」这条分支不存在，不需要实现。
2. **真正鉴权的是 `x-api-key`。** 最初的需求写的是只用 `Authorization: Bearer`，但那样会被 401 拒绝。
   本插件**两个头都发**，这样网关两种行为都活得下来。
3. **两个端点共用一套 wire format。** `goMode` 只改 base URL，请求体、头、模型全都不变；
   `deepseek-v4-flash` 在两个目录里都存在，所以切模式不需要换模型。
4. **按量计费端点要账户有余额。** 本机账户只有 Go 套餐，所以 `/zen/v1` 稳定返回 402。
   这是**账户事实，不是插件 bug** —— 插件会把 402 单独翻译成「余额不足，要么充值、要么把
   `goMode` 打回开启」的提示，而不是笼统报一个 HTTP 错误。

### 一个必须知道的限制：响应里没有 snippet

`web_search_result` 条目只带 `title`、`url`、`page_age`，外加一个不透明的 `encrypted_content`，
**没有摘要文本**。摘要只可能出现在 `text` 块的 `citations[].cited_text` 里。

插件的处理：**有 `cited_text` 就按 url 拼成 `snippet`，没有就干脆不返回 `snippet` 字段**，
而不是拿标题或正文去伪造一段。搜索结果里 `snippet` 缺失是预期行为。

---

## 2. 安装

需要 dsh 桌面版，且 `plugin_manager` 可用。

### 2.1 克隆到本地再安装（推荐，最稳）

```bash
git clone https://github.com/lldwb/dsh-web-search-opencode-ds.git
cd dsh-web-search-opencode-ds
pnpm install          # 装唯一的运行时依赖 @deepseek-ai/schemastery，见 §10
```

```
plugin_manager { "action": "install_bundle", "target": "<你克隆到的绝对路径>" }
```

`plugin_manager` 会把这个包写进当前 profile 的 `dsh.profile.bundles`，并跑一次 pnpm。

### 2.2 为什么必须自己跑一次 `pnpm install`

这是本插件与纯配置型 bundle 最大的不同：它**有真实依赖**。

`plugin_manager install_bundle` 对 `link:` 形式的依赖**不会**安装被链包自己的依赖，
而 dsh 的 `@deepseek-ai/*` 包又**不从 profile 目录解析**（见 §10）。所以
`@deepseek-ai/schemastery` 必须装进这个包自己的 `node_modules`，Node 才能相对 `index.js` 找到它。
忘了这一步的症状是启动时报 `Cannot find module '@deepseek-ai/schemastery'`。

`pnpm-lock.yaml` 已随仓库提交，所以装到的版本是确定的。

### 2.3 本地开发时

profile 用 `link:` 依赖指向工作副本：

```jsonc
// ~/.dsh/profiles/<profile>/package.json
"dependencies": { "dsh-web-search-opencode-ds": "link:E:/dsh-plugins/dsh-web-search-opencode-ds" },
"dsh": { "profile": { "bundles": [ /* … */ "dsh-web-search-opencode-ds" ] } }
```

### 2.4 改动如何生效

- **Host 半 / patch 改动**：`plugin_manager set_bundle` 先 `enabled:false` 再 `enabled:true`，
  会返回 `"application":"applied"` 并热应用，**不需要重启**。
  （`install_bundle` 在无变化时返回 `"restart-required"`，那个不会热应用。）
- **Client 半改动**：client 插件的 HMR 接收器是活的，会直接重载；只有需要重建 bundle 时才要刷新页面。

---

## 3. 凭据配置

provider 在**每次搜索前**重新解析密钥，所以轮换密钥不需要重启。

### 方式 A：写进 DSH 凭据库（推荐）

在插件的设置页里填 **API Key** 并保存即可 —— 它走的是 DSH 的 credentials 域，**不会写进设置文件**。

也可以直接写 `~/.dsh/.credentials.yaml` 的 `refs:`：

```yaml
refs:
  OPENCODE_API_KEY: sk-...
```

**两个引用名都会被尝试**，顺序是：设置里 `apiKeyEnv` 指定的那个 → `OPENCODE_API_KEY` →
`OPENCODE_GO_API_KEY`。所以旧版本存在 `OPENCODE_GO_API_KEY` 下的密钥**改名后照样能用**。

### 方式 B：进程环境变量

```bash
export OPENCODE_API_KEY=sk-...        # 或 OPENCODE_GO_API_KEY
```

### 方式 C：插件 config 字面量

在 `cordis.patch.yml` 里给这一行加 `apiKey: sk-...`。字面量优先级最高，但会明文落在配置文件里，
**不建议**。

---

## 4. 设置页（GUI）

装好后打开 **设置 → 插件**，官方「网页搜索」卡片下面会多出一张
**「网页搜索（OpenCode）」**（`plugins.item` 槽位，`order: 41`，官方那张是 40）。

页面上有五个控件：

| 控件 | 字段 | 说明 |
|---|---|---|
| API Key | `apiKey` | 只写不读。写进凭据库；留空表示不改动现有密钥 |
| 接口地址 | `baseURL` | 留空则**按下面的模式自动决定** |
| 单次请求最多搜索次数 | `maxUses` | 一次请求在必须作答前最多搜几次 |
| **覆盖官方网页搜索配置** | `overrideOfficial` | 见 §4.1 |
| **使用 OpenCode Go 套餐** | `goMode` | 见 §4.2 |

页面只在 Host 真的提供了这个命名空间时才挂载，所以没装插件的部署上**看不到任何痕迹**。

### 4.1 开关一：是否覆盖官方配置（`overrideOfficial`）

这个开关**不需要重启，立即生效**，因为 provider 在每次搜索时才决定怎么走：

| 取值 | 行为 |
|---|---|
| **开**（默认） | 用本页配置的端点与密钥，自己调 OpenCode |
| **关** | 把搜索**原样转交**给随附的 `deepseek-official` provider |

「关」的意义是：**官方那套配置（接口地址 `https://api.deepseek.com/anthropic`、`DEEPSEEK_API_KEY`、
它自己的搜索预算）继续说了算**，本插件完全不插手。

实现方式不是去改 `web.searchProvider` —— 那个字段**不是 `.volatile()`，进程启动时就固化了，
运行时改不了**；而且没有固定值时两个 provider 都可用会直接撞上 `WEB_PROVIDER_AMBIGUOUS`。
真正的做法是：本插件作为被选中的 provider，在 `search()` 里把请求委托给
`ctx.web.searchProviders.get('deepseek-official')`。这是一个**活的决定**，所以开关立刻生效。

如果 `deepseek-official` 没有挂载，`search()` 会明确报错说明「没有可转交的对象」，而不是静默失败。

### 4.2 开关二：Go 模式 vs 按量计费（`goMode`）

| 取值 | 端点 | 计费 |
|---|---|---|
| **开**（默认） | `https://opencode.ai/zen/go/v1` | OpenCode Go 包月套餐 |
| 关 | `https://opencode.ai/zen/v1` | 默认按量计费 API，按次扣费 |

**注意**：按量计费端点需要账户有余额。没有余额时它会回 **HTTP 402**，插件会把这条错误单独
翻译成「余额不足」的说明。**如果你的账户只有 Go 套餐，就保持这个开关开启。**

接口地址栏如果填了具体值，**永远优先于**这个开关（留空才是「按模式决定」）。

---

## 5. 配置项参考

设置页只能改 `.volatile()` 字段；下表其余项是**加载期配置**，只能写 `cordis.patch.yml`。

| 字段 | 默认值 | volatile | 说明 |
|---|---|---|---|
| `apiKey` | — | ✅（secret） | 字面量密钥，优先级最高，不会被表单持久化 |
| `apiKeyEnv` | `OPENCODE_API_KEY` | ✅（credential-ref） | 凭据引用名 |
| `baseURL` | 空 | ✅ | 空 = 按 `goMode` 决定 |
| `model` | `deepseek-v4-flash` | ✅ | Anthropic 格式模型名 |
| `apiVersion` | `2023-06-01` | ✅ | `anthropic-version` 头 |
| `maxTokens` | `4096` | ✅ | 生成上限 |
| `maxUses` | `5` | ✅ | 服务端搜索次数上限 |
| `timeoutMs` | `30000` | ✅ | 单次尝试超时 |
| `includeAnswer` | `false` | ✅ | 是否把模型正文放进 `content` |
| `overrideOfficial` | `true` | ✅ | 见 §4.1 |
| `goMode` | `true` | ✅ | 见 §4.2 |
| `retries` | `1` | ❌ | 首次之外的重试次数 |
| `sessionMode` | `per-request` | ❌ | `per-request` \| `stable` |
| `queryTemplate` | `Perform a web search for the query: {query}` | ❌ | 提示词模板 |

### 重试策略

重试的状态码：`408 409 425 429 500 502 503 504`。网络错误、超时，以及 **400 `MissingSessionID`**
也算可重试。**401/403 和 402 不重试** —— 重试不会让密钥变好，也不会让账户有钱。
退避为 `500ms × 尝试序号`，且可被调用方的 `AbortSignal` 打断。

---

## 6. DSH 如何选中这个 provider

`ctx.web` 在**每次调用时**解析提供方：

- 配置了 id 且已注册且 `available()` → 用它
- 配置了 id 但没注册 → `WEB_PROVIDER_CONFIGURED_MISSING`
- 配置了 id 但不可用 → `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`
- 没配 id，恰好一个可用 → 用它
- 没配 id，多个可用 → `WEB_PROVIDER_AMBIGUOUS`
- 没配 id，没有可用 → `WEB_PROVIDER_UNAVAILABLE`

本插件的 bundle patch 固定了 `web.searchProvider: opencode-ds`，所以**它一定是被选中的那个**；
「用不用官方配置」再交给 `overrideOfficial` 决定。

> ⚠️ **id 定向 patch 会整体替换该行的 `config`，不做深合并。** 随附的 `web` 行目前没有 config，
> 所以只写 `searchProvider` 不会丢东西。但如果将来有更高优先级的层（比如 profile 自己的
> `cordis.patch.yml`）给 `web` 行加了 `fetchProvider`，那一层必须**同时重写两个字段**。

层序：所有 bundle patch → profile 自己的 `cordis.patch.yml` → `--patch` 覆盖。
所以 profile 里若也写了 `web` 行，会覆盖本 bundle 的固定值。

### 环境变量覆盖

`DSH_WEB_SEARCH_PROVIDER=opencode-ds` 与配置里的 `searchProvider` **等价**（不是隐藏的优先级链）。

---

## 7. 回退到随附的 `deepseek-official`

三种方式，任选一种：

1. **最省事**：设置页里把「覆盖官方网页搜索配置」**关掉**。官方的端点与密钥立刻重新生效。
2. 把 profile 的 `cordis.patch.yml` 里加上 `web` 行并把 `searchProvider` 改成 `deepseek-official`。
3. `plugin_manager set_bundle dsh-web-search-opencode-ds enabled:false` 整个停用。

---

## 8. 自检

### 端点验证脚本

```bash
# bash / Git Bash / WSL
OPENCODE_API_KEY=sk-... ./scripts/probe-opencode.sh "你的查询" go
OPENCODE_API_KEY=sk-... ./scripts/probe-opencode.sh "你的查询" metered
```

```powershell
# Windows PowerShell
$env:OPENCODE_API_KEY = 'sk-...'
.\scripts\probe-opencode.ps1 "你的查询" go
.\scripts\probe-opencode.ps1 "你的查询" metered
```

脚本会断言 `200 / 400 / 401` 三种情形，再检查响应里有没有 `web_search_tool_result`、
`server_tool_use`、`usage.server_tool_use.web_search_requests`。

- 退出码 `0` = 全部符合预期（按量模式下的 **402 会单独标成 `UNFUNDED(402)` 并仍然退 0**）
- `1` = 有偏差
- `2` = 缺凭据或缺工具

### 单元测试（不需要网络）

```bash
node --test test/parse.test.mjs      # 40 个用例
```

### 确认某次搜索到底是谁服务的

随附的 `deepseek-official` 在派发前会往会话里追加 `web/deepseek-search-llm-request` 事件，
**本插件从不写这个事件**。所以在会话日志里
（`~/.dsh/sessions/<slug>/<sessionId>/session.v4.jsonl.zstd`，注意是**多帧 zstd**，
每个 append 一帧，必须按帧魔数 `28 B5 2F FD` 切开分别解压）：

> 搜索产生了结果，而这次调用**没有**对应的 `web/deepseek-search-llm-request` ⇒ 就是本插件服务的。

---

## 9. 故障排查

| 现象 | 原因与处理 |
|---|---|
| 页面压根不出现 | Host 没提供命名空间。`Config.listConfigs` 里该行 `status` 必须是 `"schema"`（不是 `"absent"`）。`"absent"` 意味着插件没声明 Config。 |
| 页面出现但插件列表里没有 | Loader 没重读 profile。`set_bundle` 关再开一次。 |
| `WEB_PROVIDER_CONFIGURED_MISSING` | 固定了 `opencode-ds` 但插件没注册上 —— 看 Host 日志里插件是否加载失败。 |
| 401 | 密钥不对，或者**用错了模式**（Go 套餐的密钥不等于按量计费可用）。 |
| 402 | 按量计费端点余额不足。充值，或把 `goMode` 打回开启。 |
| 400 `MissingSessionID` | `x-opencode-session` 被中途剥掉了。插件每次都生成，看到这个说明有代理在改请求。 |
| 抓不到 `snippet` | 预期行为，见 §1。响应里本来就没有摘要。 |
| `Cannot find module '@deepseek-ai/schemastery'` | 插件目录里没跑过 `pnpm install`，见 §2。 |

---

## 10. 设计说明

**为什么除了 schemastery 之外必须是零 `@deepseek-ai/*` 依赖。**
DSH 自己的包**不从 profile 目录解析**（`@deepseek-ai/dsh-web`、`@deepseek-ai/dsh-credentials`
在 profile 下都是 `MODULE_NOT_FOUND`），所以 profile 装的插件 import 不到它们。
`@deepseek-ai/schemastery` 是**公开发布的 MIT 包**，装进本包自己的 `node_modules`，
是 Node 相对本文件唯一能解析到的那个 —— 而声明 `Config` 又必须要它。

**为什么 `Config` 用 `.volatile()`。**
DSH 的设置服务只把**活跃 profile 条目上的 volatile 字段**投影成表单，并通过 profile 的 Cordis patch
持久化。没有 Config → 没有命名空间 → 设置页无从挂载；字段不 volatile → 表单里看不到。
所以「能不能配」完全由 schema 上的 `.volatile()` 决定。

**为什么 `configure({ auto: false })`。**
自带页面的插件要显式关掉 schema 自动生成页面。它注册在
`ctx.inject(['settings'], …)` 的可选子级里 —— 这样没有 settings 服务的 profile 也能正常跑，
而且策略绑在插件自己的 fiber 上，Settings 服务迟到或换实例也会采用。

**为什么「覆盖官方配置」用委托而不是改配置。**
`web.searchProvider` 不是 volatile，构造时就固化，运行时改不动；改成别的 id 还会在两个 provider
都可用时撞上 `WEB_PROVIDER_AMBIGUOUS`。委托是唯一既**立即生效**又**不动别人配置**的做法。

**为什么结果不二次截断。**
`maxResults` 的裁剪归 `ctx.web` 这一层管（`capSources`），所以插件的 `truncated` 恒为 `false`，
不会把本来正确的长度再砍一刀。

---

## 11. 参考

- OpenCode Go 文档：<https://opencode.ai/docs/go/>
- OpenCode Zen 文档：<https://opencode.ai/docs/zen/>
- `web_search_20250305` 工具语义（Anthropic Messages）
- DSH `ctx.web` 服务契约（`WebSearchProvider` / `WebSearchSource`）
- DSH 设置子系统：`@deepseek-ai/dsh-settings`、`@deepseek-ai/dsh-client-ui-settings-web-search`

---

## 12. 已知限制

- **配置整块替换**：Cordis 的 id 定向 patch 会替换该行的整个 `config`，不做深合并。
  bundle 里固定了 `web.searchProvider: opencode-ds`；如果你自己的 `cordis.patch.yml` 里也有 `web` 行，
  它层级更高，会**整体覆盖**本 bundle 的固定值（包括把 `fetchProvider` 一起抹掉）。
  此时请把 `searchProvider` 一并写进你自己的那一行，或删掉自己的行交给本 bundle 管。
- **响应里没有摘要**：OpenCode 返回的 `web_search_result` 只有 `title` / `url` / `page_age`，
  没有 `snippet`。插件不会伪造摘要，所以结果里 `snippet` 缺失是预期行为（见 §1）。
  想要摘要就把 `includeAnswer` 打开，模型正文会作为 `WebSearchResult.content` 返回。
- **按量计费端点要余额**：`goMode: false` 走 `/zen/v1`，账户没钱会返回 **HTTP 402**。
  只有 Go 套餐的账号请保持 `goMode` 开启。
- **不校验远端目录**：插件不检查 `model` 在目标端点的模型清单里是否存在，写错了要到实际调用才报错。
- **Go / 按量是两个独立权益**：同一个 OpenCode 账号上，Go 套餐的密钥不等于按量计费可用，反之亦然。
- 端点行为、模型目录都可能随时变动；§1 的实测结论标注了日期，请以你的实际请求为准。

---

## License

MIT — 见 [LICENSE](./LICENSE)。

