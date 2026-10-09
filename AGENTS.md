# AGENTS.md — pi-tsgw

这是我们维护项目时给后续会话的工作约定。只记录开发边界、维护入口、验证和发布方式；版本快照、审查报告和临时待办不放在这里。使用说明见 `README.md`，实现以源码和测试为准。

## 项目与维护入口

`pi-tsgw` 是公开的 MIT Pi 扩展，为 TOSSP AIH gateway 注册 `tsgw` provider。负责对话模型目录、厂商请求改写、内置联网、追踪与会话状态；响应解析复用 Pi，不提供独立搜索工具。

| 改什么 | 从哪里看 |
| --- | --- |
| 依赖、测试命令、包版本 | `package.json`、`package-lock.json` |
| 配置、provider 注册、生命周期、命令、追踪 | `extensions/index.ts` |
| 模型规格、价格、thinking 策略 | `extensions/models/vendors/*.ts` |
| 目录拼接、过滤与请求调度 | `extensions/models/catalog.ts`、`operations.ts` |
| 网络目录与缓存 | `extensions/models/gateway-catalog.ts` 及缓存辅助模块 |
| 内置联网与状态 | `extensions/models/web-search.ts`、`extensions/status.ts` |
| 编译、打包、发布 | `tsconfig*.json`、`.npmignore`、`.github/workflows/publish.yml` |

## 开发边界

- Pi 运行时集成集中在入口；模型模块只使用 Pi 类型。目录拼接、过滤、请求改写、状态格式化保持纯逻辑；网络/磁盘缓存独立，不自行读取 Pi 配置。
- 厂商策略写在对应 vendor 分片；`operations.ts` 只汇总调度，不新增模型族 switch。共享工具在 `_tools.ts`；公共 compat 在 `vendors/_protocols.ts`，厂商特例留在分片。
- 复用宿主的 Completions、Responses、Anthropic、Google adapter；不复制 stream/response 实现，不引入通用 JSON Patch、消息历史或 token-limit 改写。
- 新增运行时依赖、协议或公共接口前先确认必要性。新能力以 Pi 架构为基础，能力模块可独立复用，MCP 只是可能的调用接口。
- 请求改写必须 copy-on-write，非普通对象和非 tsgw 请求原样返回；保留非目标字段及引用，用冻结输入测试。此限制不妨碍目录模块构造自己的 HTTP URL/header。
- 不为顺手优化扩大任务范围；不覆盖已有改动。源码原则上不超过 500 行，按职责拆分，不机械碎片化。

## 配置与安全

- 配置从 `getAgentDir()` 下的 `settings.json` 顶层 `tsgw` 在初始化时读取，不假称支持项目配置合并或热加载。新增配置同步更新 README 和配置测试。
- 凭据交给 Pi：启动目录查询使用 `readStoredCredential()`，刷新使用宿主传入的 credential，推理声明 `$TSGW_API_KEY`；不另建凭据解析或优先级规则，不假定两条目录凭据路径完全等价。
- 默认地址 `https://aih.example.com` 是占位符。真实网关地址、内部价格、密钥、令牌和敏感原始响应不得进入仓库、诊断或普通日志。
- 保留公开标识 `tsgw`、`TSGW_API_KEY`、`AH-*` 及产品名 TOSSP AIH gateway；不恢复旧的 `AIH_*` 命名。
- 追踪默认关闭，既有同名头按大小写不敏感方式保留。当前请求匹配检查 hostname，不应宣传成完整 origin/path 安全校验。

## 模型与缓存

- 新增模型前核对网关目录、静态登记和测试，列候选供确认；不自动把全部候选加入用户启用配置，不擅自删旧别名。ID 区分大小写，特别是 `MiniMax-*`。
- 规格、输入能力、价格与 thinking 支持须有明确证据；有国内/国际站时采用国内站。记录来源和必要的档位、汇率、别名说明；上下文窗口不等于最大输出，同族复用不等于逐型号验证。
- 新模型改 vendor；新供应商接入 catalog，有策略则接入 operations。补逐 ID、档位及非目标字段保留测试，不只检查总数量。
- 静态目录与网关目录取交集后再应用用户过滤，不自动登记未知 ID。include 优先于 exclude，但不能突破该交集；两者只支持精确 ID 和尾部 `*` 前缀匹配。
- 缓存按网关与凭据隔离，不存明文凭据。过期/失败回退不得重置 `storedAt`；force 绕过新鲜缓存；迟到请求不得覆盖新缓存。旧格式或不同 scope 的磁盘数据不能直接信任。
- 带 signal 的请求独立取消，不共享调用者 signal；磁盘写入失败不阻断目录使用。入口和底层缓存分别保护乱序，不能互相替代。
- 启动可使用 stale 缓存或回退静态目录；动态刷新失败保留已登记列表。保留 `allowNetwork`、force、signal 和 TTL 语义。

## 生命周期与联网

- 请求体/请求头钩子只读实例私有快照，不访问失效 context；会话退出断开 UI sink，但保留快照供迟到请求。跨 await 的命令和并发刷新保留 revision 防护，不因宿主升级就删除。
- 状态只描述目录新鲜度与登记数，不代表推理健康；诊断不发健康探测请求、不显示敏感值。非 UI 模式不得依赖状态渲染。Pi 核心兼容性和 Pi Web 展示分开验证。
- GPT 内置联网仅 cached/live，默认 live；未配置、旧 off、非法值回退 live，已有 cached 保留。Grok 支持名单内固定实时，不修改 GPT 会话模式。会话控制不写 settings 或历史。
- 内置联网支持由 `builtinSearchSupport` 的精确 ID 与协议共同判断。不覆盖已有搜索工具/字段，不控制 Qwen 策略或外部工具，不宣传成全局联网开关。不恢复独立 `ts_search`。
- GPT reasoning 留给 adapter；Astra/6.1 Sol 的 off/minimal 用显式 null 禁用，不以省略代替。具体映射以 vendor 与测试为准，不把单个带工具请求失败推广到无工具能力。
- 分开报告目录匹配、参数注入、普通文本推理和搜索/工具/引用验证；单测或 HTTP 200 不能替代端点能力验证。

## 验证

使用 npm，不使用 bun。TypeScript 保持 strict、NodeNext 与 `.ts` 源码导入，生产编译排除测试。

```bash
npm ci
npm test
npm exec -- tsc -p tsconfig.json
npm pack --dry-run --json
git diff --check
```

- 改哪个边界就补对应测试。测试隔离 agent-dir、凭据和网络，不读取个人配置、不请求生产网关。检查编译退出码，不把已生成 dist 当作通过。
- 升级 Pi 前读目标版本的 extensions、custom-provider、packages 文档与相关示例；同步 package/lock，跑类型检查、单测与真实宿主集成。不要混淆 legacy `ProviderConfig.refreshModels` 返回列表与完整 `Provider` 的 publish 契约。
- 宿主与开发依赖版本分别核验；不只因本机升级就提高最低 peer 版本。未实测的上游能力与 UI 明确报告，不用模拟结果代替。
- `.npmrc` 的 dev 依赖覆盖配置有历史原因；修改前确认实际 npm 配置与安装结果，不按旧 npm 版本的假设处理。
- 检查打包清单：发布 TS 源码，不包含 dist、测试、规则或开发配置。修改 `package.json.files` 会改变 `.npmignore` 的作用，必须重查。
- 完成时报告关键改动、验证结果与阻塞，检查工作区及 HEAD 与远端 main 的关系；不能为制造干净状态擅自提交或丢弃修改。

## 发布

- 发布流程：提交代码 → 创建版本 tag → 推送代码与 tag → GitHub Actions 自动测试并发布 npm；具体步骤以 `publish.yml` 为准。
- CI 使用 npm Trusted Publishing/OIDC，无需配置长期 `NPM_TOKEN`。`package.json.repository` 与实际 GitHub 仓库保持一致，供发布来源证明使用。
- 未经用户明确要求，不擅自触发发布；获得发布授权后按完整流程执行，不逐步骤重复确认。
- Actions 保持可读主版本引用，不仅为信息性告警改成 SHA pin；安全修改须有具体威胁依据。
