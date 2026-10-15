# Changelog

## 0.2.0

基于上游 [XDTrees/dsh-opencode-xdbridge](https://github.com/XDTrees/dsh-opencode-xdbridge) 的 `main`（尚未发布到 npm）的 fork。这是新包名的第一次发布，没有兼容负担。

### 变更

- 包名 `dsh-opencode-xdbridge` → `dsh-opencode-bridge`，并同步改名：宿主入口 id `llm-opencode-bridge`、设置命名空间与 provider `opencode-bridge`、设置页路由 `/plugins/dsh-opencode-bridge/*`、环境变量 `OPENCODE_BRIDGE_*`。
- 数据目录默认值从 `<DSH home>/opencode-xdbridge` 变为 `<DSH home>/opencode-bridge`：老目录里的运行时（约 57 MB）可以手工搬过去，否则首次启动会重新下载。
- 设置页显示名改为 **OpenCode Bridge**（原 OpenCode-XD / OpenCode-XDbridge）。

### 新增

- 配置项 `proxyUrl`：下载受管运行时与状态请求走指定的 HTTP 代理；留空则沿用环境变量代理。
- 配置项 `proxyRuntime`：是否把代理也转发给受管 OpenCode 运行时（默认关，原因见 README「出站代理」）。
- 设置页状态行「出站代理」（原「运行时代理」）：显示生效中的代理，不含凭据；未配置时显示「直连（默认）」。
- 从 `lib/runtime.js` 导出 `configureProxy()` / `describeProxy()` / `proxyFor()` / `tunnelledSocket()`，供测试与复用。
- **代理字段现在能在设置界面里填**：`Config` 的 `proxyUrl` / `proxyRuntime` 改为 `volatile()`。此前 schema 里一个 volatile 字段都没有，Harness 因此完全不渲染配置表单（`dsh-settings` 的 `volatileForm()` 无命中即返回 `[]`），表现就是「找不到填代理的地方」——不是没重启，是界面压根没有这两项。入口：设置 → 插件 → 已安装 → `dsh-opencode-bridge` → 组件 `llm-opencode-bridge` → 「配置 llm-opencode-bridge」。
- 代理改动**保存即生效，不用重启**：`configureProxy()` 会在启动、重启与读取状态前重新读取字段当前值，`volatile` 包装由 `lib/runtime.js` 的 `fieldValue()` 解开。
- 设置页状态行在未配置代理时补上填写位置提示（中英双语）。

### 修复

- 带凭据的代理（`http://user:pass@host:port`）在 `tunnelledSocket()` 里会丢掉 CONNECT 的 `Host` 头——第二个 `headers` 键覆盖了第一个。现在合并成一个 `headers` 对象，凭据与 `Host` 同时发出。

### 说明

- 零行为变化：不填 `proxyUrl`、不设 `OPENCODE_BRIDGE_RUNTIME_PROXY=1` 时，代理变量依旧不进受管运行时，与 0.1.0 一致。
- 0.2.0 未发布到 npm：本机 profile 里用的是 `file:E:/文档/deepseek-harness/dsh-opencode-bridge`，不是 registry。

## 0.1.0

首个版本。

### 模型接入

- 在 DeepSeek Harness 里使用 OpenCode Zen 的免费模型，作为 `opencode-bridge` provider 分组。
- 受管、隔离的 OpenCode 运行时：独立 XDG 根、每次启动随机服务密码、关闭自动更新与分享；只转发常规系统与网络变量，不读取也不写入用户自己 OpenCode 的配置、凭据和会话。
- 只列出运行时报告的**每一个**计费维度都为 0 的模型，不会悄悄花掉额度。
- 模型清单随上游变化，每次启动重新读取。

### 设置页

- 设置 → **OpenCode Bridge** 提供交互面板：服务状态、指标条、运行时信息、模型目录与详情。
- 每个模型一行：名称、推荐用途、能力徽章、状态徽章、最近响应耗时；点击该行在**其正下方**展开详情。
- 三个操作：读取模型、检测全部、重启运行时。
- 推荐用途按模型实测能力整理；未收录的新模型会按能力自动生成一句话，不留空。

### 检测

- 检测串行执行，避免并行争抢同一份上游免费额度。
- 每个模型每次检测最多尝试 2 次，**每次独立计时（90 秒）**。
- 失败分两类：超时/限流/服务端错误视为**瞬时**（保留在选择器，标「不稳定」）；地区限制/鉴权失败/额度不足视为**确定性**（移除，标「不可用」）。
- 只回文本、不产生动作的模型按「可用 · 仅对话」发布，而不是判为失败。

### 修复

- **重探测死锁**：探测曾用 `catalog.visible()` 校验请求，而它已排除失败模型，导致失败过的模型再探测时被判 `model_not_found`，永远卡在「不可用」。改为对 `catalog.all()` 校验后，失败模型可正常恢复。
- **重试预算被饿死**：首次尝试与重试曾共用一个 60 秒 deadline，慢模型的重试还没跑就被掐断，把「只回文本」这种有效结论误报成超时。改为每次尝试独立预算后，实测可用模型从 4 个恢复到 6 个。
- **详情面板位置**：曾渲染在整个列表底部，改为在被点击的那一行正下方展开。
- **卡片标题空白**：卡片标题曾复用头部的 `flex-grow` 类，撑出一块空白；已改用独立类。
- 地区限制现在显示为「地区不可用」，而不是含糊的「访问受限」。

### 安全

- 回环端点只监听 `127.0.0.1` 随机端口，校验 Host/Origin 必须是回环（防 DNS rebinding 与浏览器页面访问），Bearer 常量时间比较，请求体上限 8 MB。
- 运行时被配置为「每个操作都要审批」，插件把所有审批一律拒绝，本地零执行；模型若试图本地执行，会尽量把该动作转交为外部工具调用。
- 模型返回的 JSON 信封必须先通过校验才能变成工具调用。

### 测试

- 48 项单元测试、客户端 bundle 校验、15 项无头渲染检查、声明校验、真实运行时端到端测试。
