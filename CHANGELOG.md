# Changelog

## 0.2.3

### 修复

- **思考模型不再被强制 tool_choice**（lib/backend.js）：运行时把 JSON-schema 的 format 实现成「强制调用 StructuredOutput」，而思考中的模型上游只接受自动选择工具，于是带工具的回合以 "Upstream request failed: [invalid_request_error] Thinking mode does not support this tool_choice" 收场（2026-10-19 单小时 10 次，全部 agent=buddy-bridge + 免费 thinking 模型）。现在请求照常下发 format，只有在**上游真的回了这条 400** 时才去掉 format、改成纯文本信封指令并重试同一轮；这次放宽不消耗那唯一一次格式纠正重试。按 model.reasoning 预判的做法已放弃（会让本来正常的模型改走纯文本路径，反而更容易出信封错误）。
- **模型把 calls 写成字符串时不再误判信封无效**（lib/protocol.js）：免费模型常把信封的 calls 字段序列化成字符串（"[{...}]" 或单个对象 "{...}"），原来只认数组，直接报「模型未返回合法的信封 JSON，未执行任何工具」。新增 parseCalls() 容错：空串→无调用、数组→数组、单个对象→[对象]；calls 读不出但 content 是有效正文时按「无工具调用」处理，强制工具的场景仍由既有检查拦成「模型遗漏了必需的工具调用」。

### 测试

- test/payload-shape.test.js（3 例）：默认仍下发 json_schema format；上游拒绝后重试不带 format 且仍能解出答案；放宽不吞掉那唯一一次格式纠正。
- test/protocol.test.js 新增 5 例，覆盖 calls 被写成字符串的各种形态。

## 0.2.2

### 修复

- **修掉「回答 = 系统提示词」的回显事故**（`lib/stream.js`、`lib/backend.js`）：运行时把适配器刚发出去的请求原样存成一个 text part，**属于 user 消息**，而那段文本就是 `JSON.stringify(messages)` —— 它的第一个 `content` 正是 DSH 的系统提示词。真流式把 part 文本一律当答案解信封，于是在请求开始 **0.5 秒**后把 173,406 字符的完整系统提示词（含附录）当成回答发给客户端（2026-10-18 turn 13，用户按「停止」才截断）；同一个 bug 也让标题请求把会话名污染成 `Create a concise title for an AI coding-assistant session from the supplied huma`。现在两道闸：①`message.updated` 记下每个消息的角色，属于已知非 assistant 消息的 part 及其增量一律拒绝；②投递前再按内容拦一次 —— 以 `[{"role":"` 开头的文本是适配器自己的载荷，无论事件顺序如何都不进用户视野（事件订阅是后台建连的，早期 `message.updated` 可能漏看，所以第二道闸刻意不依赖它）。

- **回答在生成过程中就开始返回**（新增 `lib/stream.js`；改 `lib/backend.js`、`lib/shim.js`、`lib/protocol.js`）：原先 `lib/shim.js` 只在事件流报出「有内容」时写一帧 assistant role，正文一律压到 `await complete(...)` 返回后才由 `sendSSE()` 一次性下发 —— 客户端的首 token 延迟因此等于整轮生成时间（本机实测每步 13–118 秒；同一模型族下插件免费模型约 49.6 s/步、直连付费 29.1 s/步，插件多出来的正是这段缓冲）。现在把运行时的 `message.part.*` 事件转成 OpenAI SSE 增量：`lib/backend.js` 的 `handleEvent()` 用新的 `createStreamState()` 跟踪每个 part，把新出现的可见文本放进 `progress.delta`；`lib/shim.js` 收到 delta 就写一帧 `delta.content`；`lib/protocol.js` 的 `sendSSE()` 新增 `streamed` 参数，收尾时只补发剩余部分，**绝不重发已经发过的前缀**。
- 两种答案形状分开处理：仅对话模型（`chatOnly`）的文本本身就是答案；带工具的模型回复的是适配器 JSON 信封，只有其中的 `content` 字符串是给用户看的 —— 新增的 `envelopeContent()` 容忍分片到达的转义（`\uXXXX` 读满 4 位才解码、尾随未完成的转义先压住），**JSON 语法永远不会出现在用户眼前**；工具调用仍等信封校验通过后才下发（提前发出去可能给客户端一个随后被拒绝的动作）。收尾时若正文不以前缀开头（格式纠正导致重写），则整段重发并在日志里说明原因：客户端已经显示的字符撤不回来。
- part 的文本按「累计报告 + 该报告之后的增量」保存，报告覆盖增量而不是与之相加 —— 用后缀比较去重会吃掉 JSON `\\` 转义里两个一模一样的反斜杠（写测试时真的踩到了）。

### 测试

- 新增 `test/stream.test.js`（11 例：分片大小 1/2/3/7/64 下的信封解码、跨分片的 `\u` 转义、重试不重复前缀、`sendSSE` 的补发与整体重发语义）与 `test/stream-events.test.js`（7 例：事件流 → delta 的接线、信封模型不吐 JSON、推理文本不当答案、别的会话或无会话的事件不串台、下面那条回显事故的三种顺序）与 `test/stream-shim.test.js`（3 例：在真实 socket 上验证增量投递、答案被重写后整段重发、非流式请求仍是单个 JSON）。

## 0.2.1

### 兼容性

- **支持 DSH 0.2.1-rc.2**（`package.json`）：`engines.dsh` 原为 `>=0.1.1-rc.1 <0.2.0`，而 DSH 从 0.2.x 起多了一道版本闸门 —— `@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility()` 在插件清单里存在**顶层 `engines.dsh`** 时**只按它裁决**（`semver.satisfies(runtime, range, { includePrerelease: true })`），不满足就整个 bundle 跳过（`skippedBundles`），表现为插件完全消失、模型列表清空、设置页没有入口，日志里只有一行 `requirements ... are unmet`。现在放宽为 `>=0.1.1-rc.1 <0.3.0-0`：0.1.x 与 0.2.x（含预发布）都通过，**0.3.0 那一线仍然拒绝 —— 连它的预发布一起**。上界写 `-0` 是有意的：闸门带 `includePrerelease`，若只写 `<0.3.0`，`0.3.0-rc.1` 因为排序低于 `0.3.0` 反而会被放行，等于让一条**没测过**的线直接加载；`-0` 是 semver 里最小的预发布标识符，能把整条线挡住（fail-closed）。
- 同步放宽 `peerDependencies`：三个 `@deepseek-ai/dsh-*` 的范围原来都写死 `<0.2.0`（闸门在 `engines.dsh` 缺席时才看 peers，但 `pnpm` 与插件管理页同样会读到），`@earendil-works/pi-ai` 由 `>=0.82.1 <0.86.0` 放宽为 `>=0.82.1 <2.0.0`（0.2.1 宿主自带 1.1.0）。
- **实测依据**：①把运行中的 DSH（`@deepseek-ai/dsh-desktop` 0.2.1-rc.2）asar 里 app-boot 的 `unmetRequirements`/`satisfies` 原文取出来，配 0.2.1 自带的 semver 7.8.5 跑新版清单 —— `0.2.1-rc.2` / `0.2.0-rc.2` / `0.1.1-rc.3` 均返回 `{}`（无未满足项），`0.3.0` / `1.0.0` 仍返回含 `engines.dsh` 的未满足项。②逐一核对 0.2.1 上插件真正用到的宿主接口，名称与形状都没变：`ctx.llm.registerAdapter / registerConfigurableProviders / registerModelDiscovery`、`ctx.webServer`（`super(ctx, "webServer")`）、`ctx.get("attachments")`、`ctx.get("fs").processPathFromHostPath`、客户端 `slots.register({ name: "settings.section" })`（`dsh-client-ui-settings-general` 仍在渲染该 slot）、`locale.register`、`ctx.configForms`、以及客户端 seed `@deepseek-ai/dsh-client-ui-primitives`（宿主自己的 `lib/client.js` 全部 require 它）。③pi-ai 跨版本交接实测：用 profile 里 0.87.1 的 `createProvider({ ...openAICompletionsApi() })` 造出的 provider，塞进 1.1.0 的 `createModels().setProvider()`，经 `streamSimple()` 打本地假 OpenAI 端点 —— 上游收到 `Authorization: Bearer ...`、SSE 正确还原成 5 个 chunk（含 usage/cost），即 profile 里那份 0.87.1 与宿主的 1.1.0 **混用不会断**，不需要动 profile 的依赖。

### 测试

- 新增 `test/engines-range.test.js`：按 DSH 自己的算法（`semver.satisfies(runtime, range, { includePrerelease: true })`）把 `package.json` 的范围钉住 —— `0.1.1-rc.1` / `0.1.1-rc.3` / `0.2.0-rc.2` / `0.2.1-rc.2` / `0.2.9` 必须通过，`0.3.0-0` / `0.3.0-rc.1` / `0.3.0` / `1.0.0` 必须拒绝；三个 `@deepseek-ai/dsh-*` peer 范围同样要接受这些运行时。反向验证：把 `engines.dsh` 改回 `<0.2.0`，用例立刻报 `0.2.1-rc.2 must satisfy ...`。

### 修复

按代码审查报告的建议顺序逐项修复（已完成）：**H2 ✓ → H1 ✓ → M1/M2 ✓ → M3/M4 ✓ → 其余中危 ✓ → 低危 ✓ → 新增：清除本机数据 ✓**。每项都先验证、再进入下一项；每条修复都用「把 bug 写回去，测试必须变红」反向验证过。

### 修复

- **启动失败不再把插件锁死**（`lib/index.js`）：原先第一次启动失败会走完整的卸载路径 —— `shutdown()` 把 `closed` 置为 `true`，而 `restart()` 看到 `closed` 就抛「插件已卸载」。于是一次坏启动（一次下载超时就够了）之后，设置页的「重启」按钮永久报错，只能重启整个 DSH。现在启动失败只释放这次尝试建出来的资源（新的 `releaseRuntime()`），`closed` 只由真正的卸载设置；`restart()` 在「端点还没建出来 / provider 还没注册」时重跑整个启动 —— `init()` 可重建缺失环节，provider 至多注册一次（同一 provider 第二次 `registerAdapter` 会被宿主拒绝）。
- 启动失败后的状态更准确：失败态由 `start()` 自己记录（`phase = 'error'` + 原因），所以「重启」再失败时页面显示新的原因，而不是停在「正在重启」。

- **探测请求不再挂在整轮检测上**（`lib/index.js`、`src/client/index.js`）：`POST /plugins/dsh-opencode-bridge/models/probe` 原先 `await started.done`，把 HTTP 响应压在整轮扫描后面 —— 一个模型 2 次尝试各 90 秒，N 个模型就是 N×180 秒的长连接，和同文件里「后台跑、页面轮询」的注释自相矛盾；页面 5 秒一轮的 `status` 已经在报 `probe.running/current/pending`，等这一轮纯属白等。现在路由在扫描启动后立即返回 `{ started: true, count, pending: true }`（形状由新的纯函数 `probeRouteResult` 决定，回复不再是 promise），结果照旧逐条写进 catalog 并随状态文档给页面；「已有扫描在跑」仍返回 `started: false`。客户端按钮反馈改为读 `started/count`（原来读 `ok/failed`，早返回后会显示「0 可用」），文案「已开始检测 N 个模型，进度见上方状态」。

- **设置页路由现在只接受同一台机器的浏览器请求**（`lib/web-status.js`）：这些路由由 `ctx.webServer.register` 注册，**不在宿主 `/api/*` 的浏览器鉴权墙后面**。实测（2026-10-17，本机 DSH）：无凭据 `GET /plugins/dsh-opencode-bridge/status` = 200（回环端点、数据目录、模型清单一并返回），`POST /models/refresh` 带 `Content-Type: text/plain`（CORS 安全列类型，跨站可以无预检直发）= 200 且真的执行了刷新；同样条件打宿主自己的 `/api/dsh-im/*` = 401。现在 `route()` 先过新的 `inspectRequest()`：`Host` 头与 socket 来源都必须是回环（这条挡掉 cloudflared 隧道 —— 公网请求是以 127.0.0.1 送达的，只看来源地址放行是原设计的漏洞）、`Origin` 存在时必须回环且与 `Host` 同源、写请求必须是 `application/json`（跨站页面设不了这个类型，预检又会被 405 挡掉）。**这不是鉴权**：本机进程可以伪造上面全部头；真正落进鉴权墙要改走 `ctx.connection.fetch.register`（尚未排期）。
- 上面的收紧带来两个使用上的变化：经隧道（cloudflared 之类）访问设置卡片会被 403（宿主自带管理接口同策略）；用 curl 调试写接口要带 `-H 'Content-Type: application/json'`（模拟浏览器再加 `-H 'Origin: http://127.0.0.1:19387'`）。只读的 `GET` 不受影响。

- **一轮推理现在有墙钟上限**（`lib/backend.js`）：`/message` 是长轮询（运行时要等模型跑完才应答），所以原先显式传了 `timeout = null` —— 代价是运行时卡住时那次请求永不返回，只能等客户端自己断开，运行时侧会话也不会被中止。现在默认上限 **300 秒**，配置项 `OPENCODE_BRIDGE_MESSAGE_TIMEOUT_MS`（毫秒，非正数或解析不出则回落默认），超时按可重试错误回给客户端：`code: 'message_timeout'`、状态 504、文案写明是多少秒和该调哪个环境变量；`finally` 里的 `DELETE /session/*` 照旧执行。顺带修好一个更隐蔽的问题：`request()` 原来用 `AbortSignal.timeout()` 直接参与 `AbortSignal.any()`，**Node 的 http 客户端会把这种 abort 变成裸 `ABORT_ERR`/「The operation was aborted」，原生的 `TimeoutError` 丢了**，于是 `lib/shim.js` 里那条「模型请求超时」分支永远不会命中，所有既有带超时的调用（限流重试、许可查询、事件流）超时都错报成未知错误。现在把 deadline 单独存着，`req.on('error')` 时用 `deadline.aborted ? deadline.reason : error` 还原真实原因。
- **审批轮询不再和事件流抢着发请求**（`lib/backend.js`）：`complete()` 的监视循环每 250 毫秒调一次 `pendingPermissions()`，而它每次都直发 `GET /permission` —— 但 `permission.asked` / `permission.replied` 早就由事件流写进 `pendingApprovals` 了，也就是每个在飞请求白打 4 次/秒的 HTTP。现在事件流连着的时候直接读本地表（零请求），只在流断开时读运行时列表，并且**每次重连后对账一次**（断连期间产生的审批不会经事件流到达，这是唯一会漏的窗口）。
- **请求体上限不再低于图片预算**（`lib/shim.js`）：对话请求的读取上限原来是 `8 MB`，而本插件自己向宿主要求的图片预算是 `REQUEST_IMAGE_BUDGETS.maxRequestImageBytes = 20_971_520`（`lib/adapter.js`）—— base64 还要膨胀约 1/3。也就是宿主已经放行的大图请求，会在自己的收口处被 413「请求体超过 8 MB」挡回去，报错词还不达意。现在上限 **32 MB**（文案按常量算），并且在 `Content-Length` 已声明超限时**先排空请求再拒绝**：原实现是边读边抛，socket 被销毁，同一条 keep-alive 连接上的下一个请求会挂到 30 秒超时（实测）。
- **抓包默认不再把对话正文和图片落盘**（`lib/shim.js`）：`OPENCODE_BRIDGE_CAPTURE`（或 dataDir 里的 `capture-requests` 标记）打开时，原来会把完整请求体写进 `<dataDir>/capture/*.json`，没有条数、体积或期限限制。现在图片 data URL 被替换成 `<redacted image/png image, 12345 bytes>`，单条记录超过 2 MB 截断，目录只保留最近 20 条；清理只认自己写过的文件名（`数字-名字.json`），因为 `OPENCODE_BRIDGE_CAPTURE` 可以指向任意目录，不能顺手动别人的文件。
- **上游响应体有上限**（`lib/backend.js`）：畸形或失控的运行时可以把任意大的响应灌进内存（`chunks` 无上限累积）。现在超过 **32 MB** 立即 `destroy()` 并回 `BridgeError(..., 502, 'upstream_error')`，同时把错误里带的上游正文从「前 600 字原文」压成单行 200 字（原来会把运行时的错误页整段塞给客户端）。
- **运行期日志会轮转**（`lib/index.js`）：原来只在插件启动时检查一次 `opencode.log` 大小，长跑进程可以把它涨到任意大。现在换成计数式 `Writable`（`createRollingLog`），写入跨过 5 MB 就把当前文件改名为 `opencode.log.previous` 并重开；启动时那个已有的大文件也照样轮转（先关流再改名 —— Windows 拒绝重命名打开中的文件）。`OPENCODE_BRIDGE_DEBUG=1` 下运行时日志含完整请求/响应，所以这条是隐私相关的，不只是磁盘。
- **删掉一条从不执行的校验**（`lib/handoff.js` / `lib/adapter.js`）：`validateAction()` 只被测试引用，真实路径上的信封校验全在 `lib/protocol.js` 的 `decode`，文件头却宣称「A translation is not trusted」由它落实 —— 留着会让人以为有第二道防线。同时删掉 `lib/adapter.js` 里无调用者的 `invalidate()`。
- 小修（`lib/runtime.js`）：删掉 `tunnelledSocket` 前重复的孤儿注释；`LOOPBACK_BYPASS` 声明上移到它唯一的使用点之前（原来在首次使用的函数之后，靠「调用发生在初始化之后」侥幸不炸）；下载解包失败时不再残留 `<target>.extract`；`freePort()` 补注释说明「探测端口 → 子进程绑定」之间存在竞态（Windows 没有 fd 传递，输掉竞态表现为启动健康检查失败，不修实现）。
- **测试不再硬编码作者机器的路径**（7 个文件）：原来 `test/client-declaration.test.mjs`、`client-registry-probe.mjs`、`profile-load-check.mjs`、`diagnose-probe.mjs`、`diagnose-variant.mjs`、`e2e-shim.mjs`、`proxy-live.mjs` 写死了 `D:/DSH/DSH Desktop/...` 与 `D:\DSH\_diag-ocxb`，只有作者那台机器能跑。现在改读 `DSH_APP_MODULES`（宿主 `<app>/node_modules`）、`DSH_HOME`、`OPENCODE_BRIDGE_LIVE_DIR`、`OPENCODE_BRIDGE_DIAG_DIR`，缺宿主模块时打印 `skipped: set DSH_APP_MODULES …` 并 **exit 0**（不是假绿：跳过与通过写在不同输出里）；`diagnose-probe.mjs` 也不再硬编码运行时版本号，改成遍历实际存在的 `runtime/*`。

### 新增

- **清除本机数据**（新路由 `POST /plugins/dsh-opencode-bridge/runtime/uninstall`、新模块 `lib/purge.js`、设置页「本机数据」卡片）：卸载插件本身是宿主的活儿（设置 → 插件 → 卸载），但插件下到磁盘上的东西没人清 —— 本机实测 **251 MB**（`runtime/opencode.exe` 173 MB + 运行时状态 78 MB + 日志）。新按钮删掉 `runtime/`、`opencode/`、`capture/`、`opencode.log*`，返回释放的字节数。三条安全设计：①**两次点击**，第一次 `{dryRun: true}` 只报体积（「将删除约 210.0 MB」），确认后才真删，删完 `phase` 回到 `stopped`，状态文案提示点「重启」会重新下载；②删除前先 `releaseRuntime()`（Windows 上跑着的 exe 删不掉，半删的运行时目录比没有更糟）；③**逐项 `lstat`，遇到符号链接/junction 只删链接本身、绝不进入**（2026-10-14 踩过 `fs.rmSync` 顺穿 junction 删掉别处 9 个包目录），并且数据目录里没有本插件的 `opencode/` 或 `runtime/` 标志子目录时**整体拒绝**（`code: 'not_plugin_dir'`，状态 400）—— `dataDir` 是用户可配的，不能变成一个「删我随手填的路径」按钮。插件卸载后这套数据不会被自动清除，需要先点这个按钮（README 的卸载步骤会写）。

### 测试

- 新增 `test/purge.test.js`：4 个用例 —— 没有标志子目录的目录必须被拒且文件留着；dry run 必须报对体积（含文件数）且一个字节都不删；真删只删自己的条目、外来文件（`keep.txt`、`other/`）必须留着、`before` 钩子必须在删除**之前**跑；目录里的 junction 必须只被 unlink（`outside/precious.txt` 活着，且 `measure()` 对链接计 0 字节）。反向验证：去掉标志检查 → 3 条失败；把安全遍历换成 `fs.rmSync(recursive)` → 未触发（Node 的 `rmSync` 在这里没顺穿 junction），改测「把 `lstatSync` 换成 `statSync`」（即真的会跟着链接走）→ 3 条失败；忽略 dryRun → 5 条失败。
- 新增 `test/shim-limits.test.js`：9 MB 对话请求必须 200 并真的调到模型；40 MB 必须 413 且文案带 `32 MB`；带图片的抓包记录里必须没有 base64 而留有对话文本；预置 40 条后一次请求把目录压到 ≤20 条且最新那条仍在。反向验证：上限改回 8 MB → 前两条失败；去掉 `Content-Length` 早拒 → 第四条按 30 秒超时失败（实证了原来的挂死）；去掉脱敏 / 去掉清理各失败一条。
- 新增 `test/log-rotation.test.js`：写 6 MB 后当前文件 <5 MB 且 `.previous` 恰好 5 MB；启动时已有 6 MB 的文件在**本次首个写入**就轮转；已有 5 MB−100 KB 再写 200 KB 时 `.previous` 是 5 MB−100 KB、当前是 200 KB。反向验证：删掉写入路径里的 `if (bytes > cap) await roll()` → 5 条失败。
- 扩展 `test/client-render.test.mjs`：伪宿主给 `/runtime/uninstall` 回一个 210 MB 的体积，然后**点两次按钮** —— 第一次必须只出现「确认删除」且没有发出 `{dryRun:false}`，第二次必须真的发出并显示「已清除」。反向验证：把第一次调用的 `dryRun` 改成 `false` → 「the first click deletes nothing」立刻失败。

- 新增 `test/web-status-guard.test.js`：起一个真实 HTTP 服务器，用伪造的 `Host`/`Origin`/`Content-Type` 打五条路由 —— 回环 Host + 同源 Origin（页面路径）、无 Origin（curl 路径）、隧道 Host、跨站 Origin、同一主机不同端口、`text/plain` 写、缺 Host、非回环 socket 来源。反向验证：把 `route()` 里那两行守卫换成 `const denial = null`，两条端到端用例立刻失败（helper 单测仍过 —— 失败的正是「守卫有没有真的接上」）。
- 新增 `test/probe-async.test.js`：用一个**永不 settle** 的 `done` 调 `probeRouteResult`，断言拿到的是完整对象而不是 promise —— 谁把「等整轮跑完」写回来，这条就失败（反向验证：把 helper 改回 `async … await started.done`，测试立即报 `actual: [Promise], expected: [Object]`）。
- 更新 `test/probe-smoke.mjs`（活体冒烟，需真实运行时）：POST 计时并断言 <5 秒返回且带 `pending: true`，然后按页面同样的方式轮询 `status` 直到 `probe.running === false` 再核对 `lastResult`。
- 新增 `test/restart-recovery.test.js`：把 `dataDir` 指向一个「父路径是普通文件」的路径，启动在第一次 `mkdir` 就失败、不需要网络。断言失败后 `phase` 是 `error`（修复前是 `stopped`）、`POST /runtime/restart` 报的是真实原因而不是「插件已卸载」，且重跑后页面仍停在可重试的 `error` 态。
- 新增 `test/host-modules-fallback.mjs`：`@deepseek-ai/dsh-llm` / `dsh-llm-pi-ai` 由宿主在运行时提供，普通 checkout 里没有装；只有当正常解析失败时才用最小桩替代，真实安装不受影响。
- 新增 `test/backend-timeouts.test.js`：一个假运行时（`/message` 永不响应、`/event` 挂住不结束、`/permission` 计数）覆盖 M3/M4 —— 400 毫秒上限下断言 `code='message_timeout'` / 状态 504 / 文案带秒数与环境变量名 / 会话仍被 `DELETE` 清理；非法值回落 300 秒；`watchEvents()` 把事件流标活、`stopEvents()` 标死；许可计数在「流死 → 流活对账 → 缓存优先 → 流断兜底」各阶段恰好各加一次。反向验证：去掉上限（改回 `signal, null)`）该用例按超时失败、去掉原因包装 / 去掉缓存短路 / 去掉重连对账各失败一条。⚠️ `node --test` 在「测试超时」下只打印 `✖` 而没有 `fail N` 汇总行，用正则数 fail 会把它误判成绿灯。

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
- **代理字段现在能在设置界面里填**：`Config` 的 `proxyUrl` / `proxyRuntime` 改为 `volatile()`（`dsh-settings` 的 `volatileForm()` 只会列出声明了 volatile 的字段）。只加 volatile 还不够——DSH 里没有任何东西会替第三方插件渲染配置表单（插件管理页的 `plugins.row.config` / `plugins.bundle.config` 槽位无人占用，第三方没有「配置」按钮），所以表单由本插件自己的 client 半边用 `@deepseek-ai/dsh-client-ui-primitives` 的 `SettingsFormModel` / `SettingsForm` 渲染，读 `ctx.get('configForms').get('llm-opencode-bridge')`。入口：**设置 → OpenCode Bridge → 出站代理卡片**。宿主没提供 `configForms` 时降级为无表单页面（不崩、不影响原有功能）。`configForms` **故意不写进 client 的 `inject`**：某条宿主线没有该服务时，`apply` 会被 inject 卡死、整页消失。
- 代理改动**保存即生效，不用重启插件**：`configureProxy()` 会在启动、重启与读取状态前重新读取字段当前值，`volatile` 包装由 `lib/runtime.js` 的 `fieldValue()` 解开。（改 `lib/client.js` 仍需重启 DSH。）
- 设置页状态行在**没有表单**（宿主缺 `configForms`）且未配置代理时，补上填写位置提示（中英双语）。

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
