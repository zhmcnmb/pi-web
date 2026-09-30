# Pi SDK 0.99.1 兼容性核查

核查日期：2026-09-30。前半记录升级前的兼容性评估；用户随后授权实施，修复范围和验证结果见“修复与验证”节，后续授权的本机打包替换结果见“本机打包与替换”节。服务启动仍不在本次范围。

## 结论

升级前需要适配，不应只修改版本号。已确认四类问题：SDK 本地接口类型、扩展工具暴露策略、Windows PowerShell 设置、新增 OpenAI ChatGPT 登录。嵌套工具事件字段也需要同步保留。

升级前，仓库 `package.json`、实际 `node_modules`、本机全局 `@agegr/pi-web` 内的四个 Pi 包均为 `0.87.1`，不会随单独的 Pi CLI 更新而自动升级。CLI 与 Pi Web 仍共享全局设置和会话文件，因此新版配置不能视作与旧版 SDK 完全隔离。

## 上游版本与依据

- 官方 npm `latest` 为 `0.99.1`；`pi-coding-agent` 发布时间为 `2026-09-29T18:23:26.245Z`。[Registry](https://registry.npmjs.org/@earendil-works/pi-coding-agent/latest)
- 四个包 `pi-coding-agent`、`pi-ai`、`pi-agent-core`、`pi-tui` 均发布 `0.99.1`，Node 要求仍为 `>=22.19.0`。
- 正式 npm 包内 `CHANGELOG.md` 从 `0.87.1` 直接进入 `0.99.0` 和 `0.99.1`，没有按数字跨度推断中间发布版本。[正式发布包](https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-0.99.1.tgz)
- `0.99.0` 包含 MCP/codemode、工具 exposure、嵌套调用、虚拟模型和 OpenAI ChatGPT 登录等主要变更。`0.99.1` 增加模型并修复 CLI bundled OpenAI 登录模块缺失，未解决 Pi Web 宿主缺少 deviceId 的问题。
- 网页搜索索引仍返回 `0.87.1`，本结论以官方 registry 与实际下载的发布包为准。

## 必要适配

### 1. SDK 接口类型阻止升级编译

位置：`lib/pi-types.ts:160`、`:187`、`:188`，调用方为 `lib/rpc-manager.ts:2131`、`:2142` 和 `lib/subagent-runtime.ts:293`。

- `PromptOptions.preflightResult` 从 `(success: boolean) => void` 变为 `(disposition: "started" | "queued" | "handled") => void`。
- `steer()` / `followUp()` 从 `Promise<void>` 变为 `Promise<"queued" | "handled">`。
- 原代码配合新版产生三个 TS2345 错误。只在 TypeScript CompilerHost 内存中调整 preflight 类型后，三个错误转而明确指向 steer 返回值，证明两处都需要更新。
- `rpc-manager.ts:621` 当前真值判断仍会接受新版的三个字符串，不能据此断言普通 prompt 已运行失败。真实阻塞是类型不兼容，同时应明确接收新的 disposition 契约并更新旧 boolean 测试替身。

依据：正式包 `dist/core/agent-session.d.ts` 与 [SDK 文档](https://github.com/earendil-works/pi/blob/v0.99.1/packages/coding-agent/docs/sdk.md)。

### 2. 自动激活全部扩展工具破坏新版 exposure

位置：`lib/rpc-manager.ts:201`，启动、工具切换与 reload 共用该函数；子代理的同类选择在 `lib/subagent-runtime.ts:246`。

新版规定 `codemode` / `deferred` 工具默认不声明给模型，`model-only` 不允许通过嵌套调用访问。现有 `withExtensionTools()` 对 `getAllTools()` 只按名称过滤，再全部激活。

实际 SDK 复现：注册五种 exposure 后，初始 active 中只有 `direct` / `model-only`；调用 Pi Web `setActiveToolSelection(["read"])` 后，`codemode` / `deferred` 也进入 active。`hidden` 被 SDK 自身挡住，未变为可调用。

适配应保留 exposure / defaultActive 语义，并沿现有共享选择函数修复主会话与子会话；不应把所有已注册工具视作必须直接声明的工具。

依据：正式包 `docs/extensions.md` 的 Tool exposure 与 `dist/core/agent-session.js` 工具 loadout 实现。[扩展文档](https://github.com/earendil-works/pi/blob/v0.99.1/packages/coding-agent/docs/extensions.md)

### 3. PowerShell 设置不能直接改写 modifier 列表

位置：`lib/powershell-settings.ts:54`、`:72`、`:94`。

新版 `defaultTools` 支持 `+name` / `-name`。现有读写代码只识别字面量 `powershell` / `bash`，没有使用 SDK 的解析语义。

实际复现：

```text
stored before: ["-bash", "+powershell", "+codemode"]
SDK resolved:  ["read", "edit", "write", "powershell", "codemode"]
Web toggle:    false

writePowerShellToolEnabled(false):
stored after:  ["-bash", "+powershell", "+codemode", "bash"]
SDK resolved:  ["powershell", "codemode"]
```

关闭失败且丢失 `read/edit/write`。修复应在读取时复用 SDK 的有效选择，在写入时正确替换 shell modifier，保留用户其余配置。

依据：正式包 `dist/core/settings-manager.js` 的 `mergeDefaultTools()` / `resolveDefaultTools()` 及 changelog。

### 4. 新增 OpenAI ChatGPT 登录缺少 deviceId

位置：`app/api/auth/login/[provider]/route.ts:120` 附近的 `modelRuntime.login()`。

新版 OpenAI provider 增加 OAuth。该登录要求 `LoginOptions.getDeviceId` 返回本机稳定 UUID，现有路由只传前三个参数。

使用独立空 credential store 调用同样的三参数 `ModelRuntime.login("openai", "oauth", interaction)`，在网络请求和登录 UI 之前即报：

```text
Sign in with ChatGPT requires a device ID (UUID) for this installation
```

应复用 SDK `SettingsManager.getOrCreateDeviceId()`，通过第四个参数提供惰性 getter，并按现有设置写入处理检查保存错误。无需另建凭据目录或复制已有认证。

依据：正式包 `pi-ai/dist/auth/oauth/openai-chatgpt.js`、`SettingsManager.getOrCreateDeviceId()` 和上游 interactive-mode 的实际登录调用。

## 配套调整与可选能力

- `lib/agent-event-wire.ts:99` 精简 `tool_execution_update` 时丢失新版 `parentToolCallId`。实测输入 `outer/1 -> outer` 的父子关联在 SSE 投影后消失。应保留可选字段；子调用不应伪装为独立历史 toolResult，SDK 本来只将 bounded `nestedCalls` 记录在父结果上。
- `lib/rpc-manager.test.mjs:435` 断言用户消息但无 assistant 的会话没有文件。新版明确在首次用户消息时落盘，业务 clone 仍应取消，但测试期望及清理应更新。
- MCP、codemode、tool_search 在 CLI 默认加载，在 SDK 会话中不自动加载。启用它们需要显式注入 `createMcpExtension()` / `createCodemodeExtension()` / `createToolSearchExtension()`，且保持 Chat only、项目 trust、用户扩展优先级及 session_shutdown。是否启用是新增能力的范围决定，不是基本兼容修复的前提。[SDK 示例](https://github.com/earendil-works/pi/blob/v0.99.1/packages/coding-agent/examples/sdk/14-codemode-mcp.ts)
- 会话格式仍为 v3；现有 system 消息过滤、context_edit 忽略、usage 统计、模型 scope、exact system prompt 的受影响测试通过，未发现必须重新设计这些边界的证据。

## 验证记录

评估阶段的所有新版依赖均安装到仓库外独立 snapshot，使用 `--ignore-scripts`。没有修改实际 `package.json` / `package-lock.json` 或全局安装，没有读写真实 credential store，没有发送真实模型请求。

| 检查 | 结果 |
| --- | --- |
| 当前 0.87.1 `tsc --noEmit --incremental false` | 通过 |
| 独立 0.99.1 同项类型检查 | 失败，3 个位置指向 preflight 类型 |
| 只在编译器内存中修正 preflight 类型 | 仍失败，3 个位置指向 steer 返回值 |
| 同一组 159 项受影响测试，0.87.1 | 157 通过，1 失败，1 跳过 |
| 同一组 159 项受影响测试，0.99.1 | 156 通过，2 失败，1 跳过 |
| 六项独立行为探针 | 通过，确认 exposure / preflight / PowerShell / 嵌套字段 / 用户消息落盘 / OpenAI 登录差异 |

两版本共同失败项是 `lib/project-command-env.test.mjs:243`：模拟 Linux 时预期用了宿主 Windows 的 `path.delimiter`。这是既有测试问题，不计为本次 Pi 更新导致的回归。新版新增失败为用户消息即落盘的测试期望，清理处 ENOTEMPTY 掩盖了前面的断言。

第一次全量默认并发测试超出 240 秒工具时限，不能报告为通过；后续限定并发的受影响测试约 5-7 秒完成。未运行 `next build`、浏览器 E2E、真实模型流、真实 OAuth 完整登录或 MCP 服务连接。

独立源副本、SDK 下载与临时依赖已清理；必要失败日志保留在 `temp/pi-0.99.1-compat-20260930/logs/`，用于后续实施时对照。原有七个未提交文件保持不变。

## 修复与验证

源码修复阶段，项目的四个 Pi 直接依赖、锁文件和实际 `node_modules` 同步升级到 `0.99.1`；Pi Web 应用版本仍为 `0.9.3`。此阶段尚未生产构建或替换本机全局安装，后续部署结果见下一节。

已完成：

- `AgentSessionLike` 的 `prompt` / `steer` / `followUp` 直接复用 SDK 方法类型，避免再次维护重复签名；提示预检的三个 disposition 均表示已接收，预检失败仍由 `prompt()` 拒绝返回给 POST。
- 主会话工具预设与 reload 只保留 SDK 当前激活的扩展工具，不再把全部注册工具强行激活。子会话的选择复用现有 selector 边界，尊重 exposure / defaultActive，并保留设置或具体 selector 的明确启用；隐藏工具仍不可激活，控制类子代理工具仍被排除。相同测试还发现并修正了 `ext:<extension>/*` 被外层选择判断误拒的问题。
- PowerShell 读取通过 SDK 解析有效 `defaultTools`；写入替换 shell modifier，同时保留其他 modifier、显式基底和未知配置。覆盖双向切换、纯 modifier、混合列表、幂等写入及非法配置不覆盖。
- OAuth 路由通过惰性 `getDeviceId` 复用 SDK 全局设置中的稳定 UUID；读取或保存错误不能返回登录成功。未请求 device ID 的其他登录不创建设置文件。
- SSE 的嵌套工具进度保留 `parentToolCallId`，不把事件转换成新的历史消息。更新首次用户消息落盘后 clone 仍不创建子会话的测试与文件清理。
- 更新目录刷新测试：新版请求附带 `types=chat,image,classifier`，原替身未命中并意外转发到真实目录站点。新替身使用 URL API 匹配端点、断言查询参数，拒绝意外网络请求；生产刷新逻辑未改。Windows PATH 测试按模拟的 Linux 平台使用 `:`，不再使用宿主分隔符。

验证结果：

| 检查 | 结果 |
| --- | --- |
| `npm ls` 四个直接依赖 | 均为 `0.99.1` |
| `tsc --noEmit --incremental false` | 通过 |
| 修改范围 ESLint | 通过 |
| 相关回归（SDK、RPC、OAuth、PowerShell、目录、会话读写与统计） | 186 项：185 通过，1 跳过，0 失败 |
| 处理既有失败前的全量，`--test-concurrency=2` | 1323 项：1314 通过，7 既有失败，2 跳过，约 37 秒 |
| 用户要求继续后，最终全量测试 | 1324 项：1322 通过，0 失败，2 跳过，约 36 秒 |
| 旧 SDK 独立副本对照剩余失败所在文件 | 59 项：51 通过，8 失败；其中 PATH 已在本轮修正，另外 7 项旧版同样失败 |

该轮剩余七项在旧版与新版均复现，不是 SDK 升级新增的回归。用户要求继续后已完成处理：

- `components/AppShell.file-viewer-state.test.mjs` 的四项断言先统一被读源码的 CRLF/LF，生产查看器未改。
- `components/ChatInput.test.mjs` 与组件统一使用无扩展名的草稿模块导入。实测 Jiti 将 `.ts` 与无扩展名加载成不同实例，原测试把图片写入另一份 Map；生产组件未改。
- `lib/terminal-manager.test.mjs` 等待 Windows ConPTY 异步就绪后再断言 PID，并将租期的模拟时钟测试隔离于原生 PTY 启动超时，保留真实原生启动检查。
- 排查发现 `killTerminal()` 真实 Windows 问题：ConPTY 不接受 `SIGKILL` 等 Unix 信号。关闭和强制关闭现在在 Windows 上使用原生 `kill()`；Unix 的 SIGHUP/SIGKILL 行为保持不变。新增平台终止回归，验证 Windows 不安排 Unix 信号升级。

以上 48 项相关回归及最终全量测试通过；更新 `docs/terminal.md` 说明平台差异。

第一次全量运行将临时目录置于仓库内，使 non-git 用例通过父目录找到主仓库并意外创建 `agent` worktree。已检查创建时间、分支和干净状态，删除本轮创建的 worktree 与分支；最终全量运行使用仓库外的专用临时目录，此用例通过。隔离副本与测试临时目录清理后，仅保留 `temp/pi-0.99.1-fix-20260930/logs/` 中的验证和对照日志。

验证包括真实 SDK 会话构建、工具预设切换和 reload，以及 Windows 原生 PTY 就绪和关闭，但没有启动 Web 服务，因此未做浏览器 E2E。OAuth 通过替身验证宿主参数及稳定 ID 持久化，没有完成真实授权登录；没有发送真实模型请求、修改真实凭据或接入 MCP/codemode 新能力。

## 本机打包与替换

用户随后要求验证通过后直接打包、替换本机安装，不保存旧安装包，服务由用户手动启动。本轮已完成：

- 在仓库外的源码副本运行 `next build <snapshot> --webpack`，生产编译、TypeScript 检查和静态页面生成通过，退出码为 `0`。构建包含会话导出路由的动态依赖警告和 Node 26 的 `module.register()` 弃用警告，均未阻止生成产物。两次先前构建受工具退出信号或运行时限中断，改用独立 Windows 控制台后完成。
- 安装包为 `outputs/agegr-pi-web-0.9.3-pi-0.99.1-20260930.tgz`，包含 698 个文件、`.next/BUILD_ID` 和 `bin/pi-web.js`；不包含 `node_modules`、开发缓存、临时目录、凭据文件或 JS sourcemap。
- 用本地 tarball 离线替换 `C:/Users/Administrator/AppData/Roaming/npm/node_modules/@agegr/pi-web`。首次安装因宽松版本范围选中缓存中的较新 React、React DOM 和 js-yaml，随后通过 `--no-save` 对齐已验证版本；项目依赖声明未改。最终 15 个直接运行依赖全部与源码验证环境一致，四个 Pi 包均为 `0.99.1`，Pi Web 仍为 `0.9.3`。
- 安装目录的 697 个文件与构建副本逐字节一致；`bin/pi-web.js` 只有 npm 对 shebang 的 CRLF 规范化差异。安装后的 `BUILD_ID` 与打包产物一致，为 `Wf04mOBgGcXQ2sHY5wrr-`。
- 全局 `pi-web --help`、安装目录的 SDK ESM 入口加载及前端显示版本检查通过。已安装的原生 PTY 完成启动、输出与无信号关闭检查，确认 shell 进程退出；最初自退出探针未主动清理 ConPTY 资源，改为显式关闭后探针正常结束。
- 30141 无服务监听，没有启动服务、打开浏览器或发布 npm/GitHub Release。开发仓库的 `.next` 未被生产构建覆盖；仓库外源码副本、依赖链接与本轮旧安装备份已清理，新安装包保留在 `outputs/`。

构建、安装与核验记录位于 `temp/pi-web-local-replace-0991-20260930/logs/`。后续提交推送按完整清单单独确认；浏览器、真实模型流和完整 OAuth 登录仍未验证。
