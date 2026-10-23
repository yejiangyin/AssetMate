# Codex 订阅连接故障交接（2026-10-23）

## 当前结论

真实连接故障尚未解决。前几轮修正了响应解析、错误分类和诊断能力；本地模拟测试通过不能证明真实 ChatGPT 订阅请求可用。不要继续将错误归因于“思考深度高”，也不要仅延长超时或放宽联网成功判定。

分支：`claude/lucid-dirac-qcy8dl`。本轮修改基于 `a214c1d`；该提交已包含此前云端的 Codex 接入、模型目录、搜索事件及研究进度改动。

## 用户实际反馈

1. 研究长期显示“已请求联网搜索”；原生联网检测显示“服务商未返回可验证的搜索事件或结构化引用”。用户最初观察研究不到 1 分钟，不能据此判定已经死锁。
2. 后续研究失败：`模型返回了空响应（HTTP 200 · no content-type）`。旧实现对 `response.text()` 的异常执行 `.catch(() => "")`，会把超时或读取中断误报为空响应；不能据此断言服务真的返回 0 字节。
3. 修正读取逻辑后，研究实际报 `模型请求超时（180 秒）`。用户确认超时前显示“模型已连接，等待分析或搜索结果”。这一状态由成功收到 HTTP 响应头触发，不能证明已有正文或模型开始推理。
4. 将“测试职责模型”改为低思考、只回复 OK、无搜索、最多 30 秒后，用户仍反馈：`研究 · gpt-6.1-sol: 模型请求超时（30 秒），未能及时完成响应；可重试或降低思考深度`。
5. 该错误没有 HTTP/字节/事件统计，按当时的代码路径，超时发生在进入响应读取之前，可能在凭据准备、刷新后保存，或等待 `/responses` 响应头；尚未区分。
6. 最新用户反馈：同页“获取模型”也失败，显示 `无法连接模型服务；请检查域名权限、CORS 和网络。之前是没问题的`。这说明故障已不局限于研究提示词、搜索工具或 SSE 解析。该文案是对 TypeError/Failed to fetch 等的通用映射，不足以认定一定是 CORS。

最后补充的“请求前阶段诊断”和“登录服务 15 秒独立超时”尚未由用户进行真实复测。

## 已实施的修改

### `src/app/research/providers/openAiCompatible.ts`

- 从实际到达的字节识别 SSE，处理 `Content-Type` 缺失或错误的情形；不再先等待整个 `response.text()` 完成后才识别流。
- 保留读取中断原因；区分用户取消、请求超时和真正的 0 字节响应。
- 用可中断等待约束请求与 body read，防止底层 promise 不响应 AbortSignal 而一直悬挂。
- 遇到终止事件立即结束，不等待服务端关闭连接或确认取消。
- 从最终 `response.output`、搜索完成事件、`action.sources` 中识别真实搜索执行结果。仅有模型正文链接仍不能通过联网检测。
- Responses 联网检测发送 `tool_choice: "required"` 并使用低思考；正常研究保留自动工具选择。
- HTTP 响应头到达后上报 `response_started`，使研究页面能区分连接前后。
- 响应读取超时附带 HTTP 状态、Content-Type、字节数、JSON 事件数及最后事件名，不附带正文、凭据或私有数据。
- 请求前超时区分“获取登录凭据”“凭据已就绪、等待 /responses 响应头”“401 后刷新”等阶段。这个补充需要真实复测。
- Codex 连接诊断仅请求 `Reply with OK only.`，低思考、无搜索、单模型最多 30 秒；不修改用户研究配置。空 SSE 不再被当成连接成功。
- Codex JSON 请求中的 `model`、`stream` 放在最前，参照官方 CLI 对网关增量路由字段的注释。此调整不是已确认的故障根因。

### `src/app/research/providers/codexAuth.ts`

- `/oauth/token` 授权与续期增加 15 秒独立截止时间及中断。
- 即使 fetch 或 body 不响应中断，也会结束等待、释放按 profile 串行的刷新锁，以便后续重试。
- 这修正了一个会让未来请求继续等待悬挂续期任务的代码缺陷；尚未证明本次故障实际发生在续期。

### 研究进度与类型

- `orchestrator.ts` 处理连接完成事件，区分连接、等待分析、思考、检索和输出。
- `pages/research/AIResearchPanel.tsx` 增加累计用时及等待首段输出的说明。
- `types.ts` 增加诊断用的 `requireWebSearch` 请求项和 `response_started` 事件。

## 目前掌握的连接证据与局限

- 在本机命令行对 `https://chatgpt.com/backend-api/codex/models` 做过两次不带账号、Cookie 或 Authorization 的 GET 探测，分别约 0.52 秒与 0.39 秒收到 HTTP 401。早一次探测有 `application/json` 响应头。
- 这只证明这些时刻命令行路径可达；不能证明 Chrome 的网络路径、扩展域名权限、登录令牌或带鉴权的 POST 正常。
- 未获取用户本次真实 `/responses`、`/models` 或 `/oauth/token` 的 Network 日志。
- 自动化浏览器工具拒绝打开 `chrome-extension://` 协议。这是工具访问限制，不能当作 Chrome 正在拦截资产助手的证据；之后没有用替代方式绕过该限制。
- 未改动 manifest 权限，未读取或复制用户真实令牌，未做真实带鉴权的模型调用。

## 验证

- `node --import tsx --test 'src/**/*.test.ts'`：599 项测试通过，117 个 suite。
- `npm run build`：交接提交前重新运行，包含 `tsc --noEmit` 与 Vite 生产构建。
- `git diff --check`：交接提交前运行。
- 新用例覆盖：无 Content-Type 的保持连接流、JSON 回退、终止事件、读取中断、无数据超时、仅有创建事件的超时、真实空响应、搜索事件识别、连接测试不污染研究配置、刷新截止时间与锁释放。
- 测试使用模拟服务响应，不代表真实扩展验收完成。`dist` 是本地构建产物，不作为源码提交。

## 建议接手顺序

1. 先取得一条真实失败请求的证据，区分是 `/oauth/token`、`/models` 还是 `/responses` 失败，以及是否已收到状态码/响应头。最新代码的阶段诊断可作为辅助。诊断记录不要包含 Authorization、Cookie、token 或私有持仓内容。
2. 检查扩展当前实际获准的 host origins、Chrome 的站点访问设置，以及浏览器代理/网络与命令行的差异。不要把通用 CORS 文案直接当作根因。
3. 若 `/models` 恢复但 `/responses` 仍卡住，用同一登录状态和低思考、无搜索的最小请求隔离 POST 路径、模型权限、代理缓冲或订阅端接口差异。
4. 只有真实最小请求通过后，再复测原生搜索与苹果快速检查的完整研究、取消和超时流程。

参考过的官方 CLI 源码：

- https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/endpoint/responses.rs
- https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/common.rs
- https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/sse/responses.rs
