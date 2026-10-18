# DSH OpenCode Bridge

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
[![license](https://img.shields.io/github/license/bansheng2000/dsh-opencode-bridge?style=flat-square)](LICENSE)

在 DeepSeek Harness 里使用 **OpenCode Zen 的免费模型**。

## 这是什么

把 [OpenCode](https://opencode.ai/) 的免费模型（big-pickle、LongCat、MiMo、Nemotron、Space Bunny 等）接进 DSH 的模型选择器，作为 `opencode-bridge` 分组使用，并在**设置 → OpenCode Bridge** 里提供一个可视化的交互入口。

## 为什么必须这么做

OpenCode Zen 的免费模型有一个服务端门禁：

```
FreeTierError: OpenCode's free tier can only be used from within OpenCode
```

实测（2026-09-29）确认：

- **直连不行**：`https://opencode.ai/zen/v1/chat/completions` 直接请求返回 403。
- **改 User-Agent 不行**：试过 `opencode`、`opencode/1.18.33`、`Bun/1.2.0` 等 9 种写法，全部 403。判据不是 UA。
- **必须跑真正的 OpenCode 进程**：本机启动真实 `opencode serve` 后，同一批免费模型立刻可用。
- **权限策略是关键**：agent 的 `permission` 必须是 `{'*':'ask'}`；改成 `{'*':'deny'}` 或 `tools: {'*':false}` 会立刻变回 403。

所以本插件**不自造协议技巧**，而是：下载官方 OpenCode 二进制 → 在隔离环境里跑起来 → 在本地转成 OpenAI 兼容端点 → 注册给 DSH。

> 权限必须是 `ask` 意味着"每个本地操作都要审批"。插件在本地把**所有审批请求全部拒绝**，所以运行时看起来像正常 OpenCode 会话（门禁放行），但**本地一个动作都不会执行**。真正执行的是 DSH。

## 安装

> **这是 [XDTrees/dsh-opencode-xdbridge](https://github.com/XDTrees/dsh-opencode-xdbridge) 的 fork：包名 `dsh-opencode-bridge`，版本 `0.2.0`。**
> 相对上游（`main` 分支、尚未发布）多了「出站代理」配置面；上游 npm 上的 0.1.0 **没有**这些改动，两者包名不同、可以并存。
> 差异见 [CHANGELOG](./CHANGELOG.md)。

**从 GitHub 安装（本仓库，推荐）**：

```sh
dsh plugin --profile <profile> add git+https://github.com/bansheng2000/dsh-opencode-bridge.git
```

> 用 `git+https://` 而不是 `github:` 简写：本机实测简写会走 `git+ssh://`，没有 ssh key 的机器直接 `Permission denied (publickey)`。

**本地目录安装（开发用）**：在 profile 的 `package.json` 里加依赖，并把包名加进 `dsh.profile.bundles`：

```json
"dependencies": {
  "dsh-opencode-bridge": "file:E:/文档/deepseek-harness/dsh-opencode-bridge"
}
```

然后 `pnpm install` 并重启 DSH。

**上游原插件（参考，本 fork 的来源）**：

```sh
dsh plugin --profile <profile> add dsh-opencode-xdbridge
dsh plugin --profile <profile> add github:XDTrees/dsh-opencode-xdbridge
```

或者手动链接（开发用）：

```powershell
# 1. 链接插件到 profile
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-opencode-bridge" `
  -Target "D:\DSH\dsh-opencode-bridge"

# 2. 在 profile package.json 的 dsh.profile.bundles 里追加 "dsh-opencode-bridge"

# 3. 重启 DSH Desktop
```

首次启动会下载约 57 MB 的官方 OpenCode 运行时（只下载一次，缓存在数据目录）。

### 关于这次下载

下载的是 OpenCode 官方二进制（`opencode-windows-x64` 这个 npm 包，57.4 MB）。它必须存在，因为免费模型的门禁只认真实 OpenCode 进程发出的请求——插件自身只有 71 KB，不含模型代码。

下载被设计成**不会失败**，只会慢：

- **断点续传**：已下载的部分会保留，中断后重启从断点继续，而不是从头再来。
- **30 分钟总预算**：不再有单次请求的 5 分钟硬超时。
- **多源**：优先 npm 官方 registry，取不到或太慢时自动改用本仓库 GitHub Release 上的同名包。
- **完整性校验**：下载后比对 npm registry 发布的 sha512，不一致就丢弃重来——所以任何来源（包括镜像）都不可能让不同的代码被执行。

如果确实很慢，可以自己下载一次并指给它，插件会直接复制而不联网：

```sh
# 方式一：把已装好的 opencode 指给它
set OPENCODE_BINARY_PATH=C:\path\to\opencode.exe

# 方式二：指定一个下载源
set OPENCODE_BRIDGE_RUNTIME_URL=https://your-mirror/opencode-windows-x64-1.18.33.tgz
```

## 使用

重启后：

1. **模型选择器**里会出现 **OpenCode 免费模型** 分组（provider 为 `opencode-bridge`），直接选即可。
2. **设置 → OpenCode Bridge** 是插件的交互面板（布局参考 OW Bridge 控制面板）。

可用的模型随上游变化，插件每次启动都会重新读取。

## 交互面板

设置页里这张卡片就是插件的控制台：

| 区域 | 作用 |
| --- | --- |
| 服务状态 | 状态点 + 一行当前状态（启动中 / 运行中 / 错误 / 重启中），错误时直接给「重试」 |
| 指标条 | 已发现 / 可用 / 待检测 / 不可用 四个计数 |
| 运行时信息 | OpenCode 版本、本地端点、数据目录 |
| 模型目录 | 每个模型一行：名称、**推荐用途**、能力徽章（推理 / 图片）、状态徽章、最近响应耗时 |
| 详情 | 点任意一行展开：推荐用途、上下文与输出上限、图片与工具能力、推理档位、最近一次调用的动作数 / 被拦截的本地尝试 / 转交的外部工具 |
| 操作 | **读取模型**（重新向上游取清单）、**检测全部**（逐个发真实请求验证）、**重启运行时** |

排序规则与 OW Bridge 一致：可用模型在前、待检测居中、不可用置底。

### 推荐用途是怎么来的

上游 OpenCode 的模型目录**只提供** `family`、`release_date`、上下文与输出上限、图片与推理能力、推理档位——**没有**「推荐用途」字段。所以这一行是本插件按**实测能力**整理的，不是抄来的宣传语：

- 每条说明都基于该模型真实上报的上下文窗口、输出上限、图片输入、推理档位；
- 目录里没收录的新模型会自动退回按能力生成的一句话（例如「100 万上下文 · 图片输入 · 支持推理」），不会留空。

要改文案，编辑 `src/client/index.js` 里的 `USE_NOTES`，然后 `npm run build`。

### 图标

导航行与页面标题使用同一个内联 SVG 标记（菱形 + 桥拱，呼应 OpenCode 与本插件的「桥」定位）。DSH 的 `settings.section` 契约不带图标字段，外壳对不认识的 id 一律画齿轮，所以导航图标是用 CSS mask 覆盖上去的（社区页面的通行做法）。

几个设计取舍：

- **检测是串行的**。并行探测会争抢同一份上游免费额度，让每次测量都更慢也更不可信。
- **检测会真的发请求**，所以消耗少量免费额度；只回文本、不产生动作的模型会按「可用 · 仅对话」发布，而不是判为失败。
- **读取模型与检测是两件事**。「读取」只问上游有哪些模型，是启动读取失败后的恢复路径；「检测」才验证模型是否真的能干活。
- **重启只换 OpenCode 进程**，provider 与本地端点保持不变，所以不会出现重复注册。
- 面板每 5 秒轮询一次状态，关掉设置页即停止。

### 失败是怎么区分的

一次检测失败并不等于「模型不能用」，所以失败被分成两类：

| 类别 | 含义 | 是否从选择器移除 |
| --- | --- | --- |
| **超时 / 限流 / 服务端错误** | 这一刻够不到（不稳定） | **否**，保留并标为「不稳定」 |
| **地区限制 / 鉴权失败 / 额度不足** | 确定性的拒绝 | 是，标为「不可用」 |

这个区分很重要：超时说不了模型本身的任何事，因为一次慢就把它从选择器里拿掉，等于把能用的模型也一起收走了。

每个模型每次检测最多尝试 2 次，**每次独立计时（90 秒）**——早期版本让两次尝试共用一个 60 秒预算，慢模型的重试还没跑就被掐断，于是把「只回文本」这种有效结论误报成超时。实测把预算分开之后，可用模型从 4 个恢复到 6 个。

检测失败**不会**让模型变成不可再检测：失败记录只影响它是否出现在选择器里，模型始终留在目录中，下一次「检测全部」会重新试。

### 上下文长度与自动压缩

插件**不会**把模型的原始窗口直接报给 DSH，而是报一个**可用预算**：

```
可用 = (声明窗口 − 输出预留) × (1 − 15% 安全余量)
```

这么做的原因是一个实测过的故障：某个会话长到 **约 144 万 token**，而免费模型的窗口在 20 万～105 万之间。DSH 看到"窗口还够"就没有压缩，把请求发了出去，上游回了一句**完全不含原因的** `invalid_request_error: invalid request`。用户看到的现象是"换哪个模型、选哪个档位都报错"，真实原因只是**上下文超出了每一个模型的容量**。

所以现在：

- **报小窗口** → DSH 的压缩机制会**提前触发**，自动总结历史，请求不会长到无法成功；
- **超限时直接说清楚** → 返回「对话上下文超出该模型的容量：约 144 万 token，Big Pickle 上限约 20 万 token。请新建会话，或让上下文压缩后重试」，而不是把上游那句含糊的话透传出去。

设置页的模型详情里会同时显示：**可用上下文 / 声明的原始窗口**。

> 中文的 token 估算按**每字符 ≈ 1 token** 计算，而不是"字节数 ÷ 4"。中文在 UTF-8 里占 3 字节/字，用字节估算会**严重低估**——这正是早期误判的原因之一。

## 配置

**填代理的地方**（两个代理字段是插件配置里仅有的可编辑项）：

> 设置 → **OpenCode Bridge**（左栏本插件自己的页面）→ **出站代理**卡片 → 填地址 / 拨开关 → **保存**

表单就在本插件自己的设置页里，不用去「设置 → 插件」翻包详情：DSH 不会替第三方插件渲染配置表单（插件管理页的配置槽位没有任何占用者），所以表单由本插件自己的 client 半边用 `@deepseek-ai/dsh-client-ui-primitives` 渲染。万一宿主没提供 `configForms` 服务（老版本），页面照常显示、只是没有表单，状态行旁边会退化成一行「填写位置」文字提示。

保存后**不用重启插件**：两个字段是 volatile 的，`apply()` 通过闭包每次读它们的当前值。但**改完 `lib/client.js` 后必须重启 DSH**，客户端 bundle 只在启动时加载。

其余字段目前只能在 profile 的 loader 配置里写，即在 profile 的 `cordis.yml` 里该条目下加 `config:`（条目 id 是 `llm-opencode-bridge`）：

```yaml
- id: llm-opencode-bridge
  name: dsh-opencode-bridge
  config:
    dataDir: D:\DSH-data\opencode-bridge   # 运行时/日志存放位置
    binaryPath: C:\path\to\opencode.exe     # 用已有的 OpenCode，不下载
    runtimeVersion: 1.18.33                 # 固定版本
    autoRefresh: true                       # 启动后重新读一次模型清单
```

> 这两个代理字段必须保持 `volatile()`（见 `lib/index.js` 的 `Config`）：Harness 只为声明了 volatile 字段的条目渲染配置表单，去掉它表单就整块消失，而不是变灰。

| 字段 | 说明 | 默认 | 界面上可改 |
| --- | --- | --- | --- |
| `dataDir` | 受管运行时、日志、状态目录 | `<DSH home>/opencode-bridge` | 否 |
| `binaryPath` | 使用已有的 OpenCode 二进制 | 自动下载官方版本 | 否 |
| `runtimeVersion` | 固定 OpenCode 版本 | 最新版 | 否 |
| `autoRefresh` | 启动 15 秒后重读一次免费模型清单 | `true` | 否 |
| `proxyUrl` | 下载运行时、状态请求走这个 HTTP 代理；留空则沿用环境变量代理 | 不使用代理 | **是** |
| `proxyRuntime` | 把代理也传给受管 OpenCode 运行时 | `false` | **是** |

也可用环境变量 `OPENCODE_BRIDGE_DATA_DIR` 指定数据目录。

### 出站代理

- 填了 `proxyUrl` 就用它（`http://host:port`，也接受裸 `host:port`）。`NO_PROXY` 仍然优先于它，`127.0.0.1 / localhost / ::1` 永远直连。
- `proxyRuntime` **默认关，而且建议保持关**：实测把代理转发给受管运行时后，一次普通 completion 90 秒不返回（上游报 `SessionPrompt.createUserMessage` 500 UnknownError），完全不转发时同一调用 3.8 秒完成。只有运行时确实没有直连出口时才打开。
- 只支持 HTTP 代理，不支持 SOCKS5：`proxyRuntime` 打开时配置值只写入 `HTTP_PROXY` / `HTTPS_PROXY`，**故意不写 `ALL_PROXY`**（那个变量带 SOCKS 语义）。
- 状态行「出站代理」显示当前生效的代理描述；**从不显示凭据**，未配置时显示「直连（默认）」；只有在没有配置表单（宿主缺 `configForms`）时，才在旁边写出填写位置作为降级提示。
- 改完即生效，不用重启：两个字段是 `volatile` 的，`apply()` 通过闭包每次读它们的当前值（`lib/runtime.js` 的 `configureProxy` 负责解包），启动/重启/读状态前各同步一次。
- 不填 `proxyUrl` 时的行为与从前逐字一致（环境变量 `HTTPS_PROXY` 等仍按老路径生效）。

## 卸载与本机数据

卸载插件本身是宿主的活儿：**设置 → 插件 → 已安装 → 点包名 → 垃圾桶图标（卸载）** —— 宿主会从 profile 的 `dependencies` 与 `dsh.profile.bundles` 两处摘掉它，并重跑一次安装。

但插件下到磁盘上的东西没人清：受管运行时、运行时状态、日志与抓包记录。本机实测 **251 MB**（`runtime/opencode.exe` 173 MB + 运行时状态 78 MB + 日志），所以插件自己带一个清除入口：

> 设置 → **OpenCode Bridge** → **本机数据**卡片 → **清除本机数据** → **确认删除**

- 第一次点击只查体积（「将删除约 210.0 MB 的本机数据，确认后不可恢复。」），**确认后才真删**；删完状态回到「已停止」，点「重启」会重新下载（约 60 MB + 状态重新初始化）。
- 删除前先停掉运行时 —— Windows 上跑着的 exe 删不掉，半删的运行时目录比没有更糟。
- 只删 `runtime/`、`opencode/`、`capture/`、`opencode.log*` 这几个插件自己的条目；同一个目录下别人的文件不动。
- 逐项 `lstat`，遇到符号链接 / 目录联接（junction）**只删链接本身、绝不进入目标**（`fs.rmSync` 会顺穿 junction 删掉别处的东西，本仓库 2026-10-14 实测踩过）。数据目录里没有 `opencode/` 或 `runtime/` 标志子目录时**整体拒绝**并返回 `not_plugin_dir`：`dataDir` 是用户可配的，不能变成一个「删我随手填的路径」按钮。
- 想卸载前彻底清干净，先点这个按钮 —— **宿主的卸载流程不会替你删数据目录**。

## 架构

```
DSH Harness
   │  (pi-ai provider "opencode-bridge")
   ▼
lib/adapter.js ──── pi-ai createProvider + openAICompletionsApi
   │
   ▼
lib/shim.js ─────── 127.0.0.1 随机端口，进程内随机密钥
   │                （OpenAI /v1/chat/completions ↔ JSON 信封）
   ▼
lib/backend.js ──── 会话管理、权限拦截、信封校验
   │
   ▼
lib/runtime.js ──── 隔离的 opencode serve（独立 XDG 根 + 随机密码）
   │
   ▼
OpenCode Zen 免费模型
```

| 文件 | 职责 |
| --- | --- |
| `lib/index.js` | 插件入口：编排启动顺序，注册 provider，挂载设置页路由 |
| `lib/platform.js` | 数据目录与平台包名 |
| `lib/runtime.js` | 下载、启动、监督隔离的 OpenCode 运行时 |
| `lib/shim.js` | 回环 OpenAI 兼容端点（安全边界所在） |
| `lib/backend.js` | 一次推理回合：会话、权限拦截、信封校验 |
| `lib/protocol.js` | OpenAI ↔ JSON 信封的双向转换与校验 |
| `lib/handoff.js` | 被拦截的本地动作 → 外部工具调用的映射 |
| `lib/probe.js` | 模型检测（真实请求 + 动作判定 + 一次重试） |
| `lib/adapter.js` | pi-ai provider 组装 |
| `lib/catalog.js` | 免费模型目录 + 每个模型的最近观测结果 |
| `lib/web-status.js` | 设置页的同源路由（状态 / 读取 / 检测 / 重启 / 详情） |
| `lib/status-paths.js` | 主机与浏览器两侧共享的路由常量与文档结构 |
| `src/client/index.js` | 设置页卡片（浏览器侧，手写 CJS） |
| `scripts/build-client.mjs` | 把卡片包成宿主要求的模块加载器格式 |

## 发布与收录

对外发布涉及**三条各自独立、各自会失败**的通道：

| 通道 | 由什么触发 | 详细说明 |
| --- | --- | --- |
| npm 包 | 推 `v*` tag → GitHub Actions（OIDC） | [`release/npm.md`](./release/npm.md) |
| GitHub Release | 手动，维护者本人身份（运行时二进制的兜底源） | [`release/github-release.md`](./release/github-release.md) |
| 插件商店 | 往 `awesome-dsh-plugin` 提 PR，**等维护者合并** | [`list/`](./list/) |

发新版本的逐步操作见 [`release/checklist.md`](./release/checklist.md)。

> 商店收录只是**发现渠道**。提了 PR 不等于会显示，但不影响安装——
> `dsh plugin add dsh-opencode-bridge` 与 `dsh plugin add github:bansheng2000/dsh-opencode-bridge` 都是现在就能用的。

## 安全设计

- **隔离运行时**：独立的 XDG 根目录、随机服务密码、关闭自动更新/分享/项目配置；只转发常规系统与网络环境变量，**不读取也不写入**你自己 OpenCode 的配置、凭据和会话。
- **本地动作零执行**：运行时被配置为"每个操作都要审批"，而插件把**所有审批一律拒绝**。模型若试图本地执行，插件会尽量把该动作**转交**给 DSH 作为外部工具调用，否则明确拒绝并告知模型原因。
- **回环端点加固**：只监听 `127.0.0.1` 随机端口；校验 Host/Origin 必须是回环（防 DNS rebinding 与浏览器页面访问）；Bearer 常量时间比较；请求体上限 32 MB（对齐本插件自己向宿主要求的图片预算 `20_971_520` 字节 + base64 膨胀，原先的 8 MB 会把宿主已经放行的大图请求判成 413）。
- **信封先校验后执行**：模型返回的 JSON 信封必须先通过校验才能变成工具调用，工具名与参数都必须在本轮允许的列表和 schema 之内。
- **只暴露免费模型**：只有当运行时报告的**每一个**计费维度都为 0 时，模型才会被列出。不可能悄悄花掉你的额度。
- **设置页路由只服务同一台机器的浏览器**：这些路由由 `webServer.register` 注册，**不在宿主 `/api/*` 的浏览器鉴权墙后面**，所以每条路由自己校验 Host 头与 socket 来源必须是回环（这条挡掉 cloudflared 隧道）、`Origin` 存在时必须同源、写请求必须是 `application/json`。**这不是鉴权**（本机进程可以伪造这些头），只是挡住「网页 CSRF」与「隧道暴露」两条路径。
- **抓包默认关闭，开了也会脱敏**：`OPENCODE_BRIDGE_CAPTURE=1` 时记录请求，但图片 data URL 会被替换成 `<redacted image/png image, N bytes>`，单条超过 2 MB 截断，目录只保留最近 20 条 —— 而且清理只认自己写过的文件名，不会动你指定目录里的其它文件。

## 开发

```sh
npm run build        # 把 src/client/index.js 包成 lib/client.js
npm test             # 单元测试 + 四个独立校验（bundle / 渲染 / 声明 / 代理默认值），无需网络
npm run test:smoke   # apply() 注册 + 真实 PiAiAdapter + 检测流程
npm run test:e2e     # 端到端（需 OPENCODE_BRIDGE_E2E=1）
```

单独跑：

```sh
node test/client-bundle.test.mjs        # 模拟宿主加载器，验证卡片注册与渲染
node test/client-declaration.test.mjs   # 用宿主自己的代码校验 dsh.client 声明
node test/proxy-default-check.mjs       # 静态断言：代理变量没被写回 FORWARDED_ENV
node test/proxy-live.mjs                # 真实跑一次请求，验证运行时能到上游
node test/apply-smoke.mjs               # 用桩 ctx 验证 apply() 注册与全部路由
node test/harness-smoke.mjs             # 通过真实 PiAiAdapter 走一次 stream()
node test/probe-smoke.mjs               # 真实跑一次模型检测
node test/profile-load-check.mjs        # 用 DSH 自己的 loader 校验 profile
```

> **改了 `src/client/index.js` 必须重新 `npm run build`**，否则 DSH 拿到的是旧的 `lib/client.js`。

集成测试会真实下载/使用官方 OpenCode 二进制并产生真实上游请求，因此默认关闭，需要 `OPENCODE_BRIDGE_E2E=1` 显式开启。

## 已知限制

- **依赖 OpenCode Zen 的免费额度**：模型清单与可用性由上游决定，随时可能变化。
- **首次启动要下载**：约 60 MB，之后复用缓存。
- **依赖 OpenCode 客户端接口**（不是官方开放 API），OpenCode 更新后插件可能需要跟着调整。
- **支持的 DSH 版本**：`engines.dsh` = `>=0.1.1-rc.1 <0.3.0-0`（`0.2.1-rc.2` 实测通过；上界写 `-0` 是为了连 0.3.0 的预发布一起挡住，见 `test/engines-range.test.js`）。DSH 从 0.2.x 起有一道版本闸门：清单里有顶层 `engines.dsh` 时**只按它裁决**，不满足会**整个跳过这个 bundle** —— 插件消失、模型列表清空、设置页没有入口，日志里只有一行 `requirements ... are unmet`。DSH 升到 0.3.x 之前需要跟着更新插件（或在插件管理页签发一次性版本豁免）。
- 免费额度被上游限流时，请求会失败并报出上游原始错误。
- **商店收录待维护者合并**：本 fork 还没有提交商店收录（`list/` 里是条目模板）。这只影响「别人能不能搜到」，**不影响安装**——`dsh plugin add dsh-opencode-bridge` 现在就能用。详见 [`list/`](./list/)。
- **界面显示名与包名不同**：包名必须全小写（`dsh-opencode-bridge`，npm 规范），设置页显示为 `OpenCode Bridge` / `OpenCode Bridge`。

## 致谢

- [OpenCode](https://opencode.ai/) —— 本插件运行并复用其官方二进制与本地服务接口。
- [XDTrees/dsh-opencode-xdbridge](https://github.com/XDTrees/dsh-opencode-xdbridge) —— 本 fork 的上游项目（MIT）：受管隔离的 OpenCode 运行时、模型目录、检测逻辑与设置页布局都源自它，本 fork 只新增出站代理配置面。
- [louchi1984-coder/ow-bridge](https://github.com/louchi1984-coder/ow-bridge) —— 验证了"隔离 OpenCode + 本地 OpenAI 兼容端点 + 审批拦截"这一整体思路的可行性，其控制面板也是本插件设置页布局与交互逻辑的参考。本项目为独立实现，未复制其代码。

## 许可证

MIT
