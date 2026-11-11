# pi-tsgw

自用的 Pi 扩展，为 TOSSP AIH gateway 提供模型目录、请求适配、联网搜索、图片生成与编辑、分类模型及配套工作流，并提供可选的 IMAP／SMTP 邮件与 DAV 日历、联系人组件。以 MIT 许可证公开。

## 安装

需要 Pi 1.2.0 或以上稳定版。

```bash
pi install npm:pi-tsgw
```

也可使用 `pi install git:github.com/tossp/pi-tsgw`，安装后执行 `/reload`。

## 最小配置

在 Pi 用户目录的 `settings.json` 中设置网关地址（默认目录为 `~/.pi/agent`）：

```json
{
  "tsgw": {
    "baseUrl": "https://aih.example.com"
  }
}
```

将占位地址替换为实际网关地址，通过 `/login` 选择 `tsgw` 配置密钥，然后执行 `/reload`。
使用 `/tsgw` 查看目录状态，`/tsgw-refresh` 强制刷新。

`/insagent` 显式安装标准子代理：覆盖当前定义，删除已退出清单的 `tsgw-*.md`，在代理目录的 `settings.json` 中启用 Agent 并停用 Pi Web 内置代理，最后自动重载当前会话；其他自定义代理和无关设置保留。

## 工具入口

图片、上传、代理搜索、邮件及 DAV 工具均为 `deferred` 注册，通过 codemode 按需发现和调用，不默认声明完整工具 schema。使用 `describeNamespace("tsgw_images")`、`describeNamespace("tsgw_upload")`、`describeNamespace("tsgw_search")` 、`describeNamespace("tsgw_email")` 或 `describeNamespace("tsgw_dav")` 查看对应能力。用法见[图片技能](skills/tsgw-image-generation/SKILL.md)、[上传技能](skills/tsgw-upload/SKILL.md)、[搜索技能](skills/tsgw-search/SKILL.md)、[邮件技能](skills/tsgw-email/SKILL.md)及[DAV 技能](skills/tsgw-dav/SKILL.md)。

图片工具固定登记已接入的两款模型，不受 `tsgw.includeModels` / `excludeModels` 或网关模型目录缺席影响；仍复用宿主认证，由实际调用确认上游支持，失败不自动重试或换模型。

本地上传工具名为 `tsgw_upload_local_file`，不再提供旧名 `upload_local_file`；已有调用需更新。代理搜索仍遵守当前模型及可用目录限制，不因切换模型或刷新目录自动激活。

## 可选邮件配置

邮件能力需要 Pi 1.2+，工具始终通过 codemode 按需发现；调用缺配置时会提示所需字段。在宿主用户目录配置统一的 `tsgw.json`（权限 `0600`），顶层按 `imap`、`smtp` 等协议类型分组，每组为 ID 到配置的映射；不同类型可使用同名 ID，IMAP 与 SMTP 可独立配置。以下地址与密码均为占位内容：

```json
{
  "imap": {
    "inbound": {
      "host": "imap.example.invalid",
      "port": 993,
      "tls": "implicit",
      "user": "<登录账号>",
      "password": "<应用密码>",
      "trashMailbox": "<回收站完整路径>",
      "junkMailbox": "<垃圾邮件箱完整路径>"
    }
  },
  "smtp": {
    "outbound": {
      "host": "smtp.example.invalid",
      "port": 587,
      "tls": "starttls",
      "user": "<登录账号>",
      "password": "<应用密码>",
      "fromAddress": "sender@example.invalid",
      "allowSenderOverride": false
    }
  }
}
```

发信未指定 SMTP 时默认使用 `smtp` 组按对象枚举顺序注册的首项，显式指定账户优先，失败不切换；文件中不再配置 `defaultSmtp`。旧 `tsgw-email.json` 不再读取，不会自动迁移或删除；迁移时保留原账户字段，并通过账户工具返回的 `defaultSmtp` 核对默认身份；纯数字 ID 按对象枚举规则排序，必要时显式指定 SMTP。首次配置可在提示后重试；已加载账户的修改通过 `/reload` 生效，不在启动时连接服务。密码仅在本地填写，不要贴进聊天。

`implicit` 表示连接即 TLS；`starttls` 必须成功升级 TLS，均校验证书。SMTP 可选 `fromName` 和 `envelopeFrom`；未配置后者时信封发件人跟随最终 From。`allowSenderOverride: true` 允许自定义发件地址和名称；可配非空 `allowedFromDomains` 数组限定最终 From 的域（含默认地址），忽略大小写，兼容 Unicode／Punycode，子域须单列；省略则不额外限制域，不影响已有配置。该字段不限制独立的 `envelopeFrom`，也不验证 SPF／DKIM／DMARC 或保证投递成功。邮件工具统一 `tsgw_email_` 前缀，通过 codemode 的 `describeNamespace("tsgw_email")` 按需发现，不直接声明或内联到模型上下文。无后台同步、磁盘缓存、自动重发、出口切换或发送后存档；读取不自动标已读。附件仅允许当前工作目录或系统临时目录，不允许访问宿主配置目录，符号链接按真实路径校验。超出读取预算、原始头部不是合法 UTF-8，或 inline 文本附件会被库转换字符集／flowed 格式时，会明确报告，不把截断或改写内容当作完整原文。

## 可选 DAV 配置

在同一 `tsgw.json` 的 `dav` 组按 ID 添加配置，不创建独立文件：

```json
{
  "dav": {
    "work": {
      "url": "https://dav.example.invalid/",
      "user": "<登录账号>",
      "password": "<应用密码>",
      "timeZone": "Asia/Shanghai"
    }
  }
}
```

`timeZone` 可省略，但事件展开必须在调用时明确时区；不用主机时区推断。密码为本地填写的普通字符串，不支持命令或环境变量占位符。根 URL 的服务发现使用标准 `/.well-known/caldav`／`carddav` 入口，最多跟随三次同源跳转；配置具体服务路径时按原路径发现，不探测其他端口或厂商私有路径。资源读取不跟随跳转，始终校验证书。

通过 codemode 发现 `tsgw_dav`，先 `accounts`，再以明确账户和类型调用 `collections`；列表须传实际集合，详情使用返回的资源 URL。提供账户、集合，日程／待办／日记／联系人的 list/get/create/update/delete，以及多字段 contact_search；创建、修改、删除均须明确授权。更新或删除先读取并核对调用方确认的强 ETag，冲突不重试；日历删除针对整资源，不是某次展开实例。日程读取所选日历全部事件资源，再由库按明确时区与窗口展开过滤，避免服务端时区不同导致漏项；代价是大日历读取量较大。待办与日记只返回已存储组件；正常摘要不包含原文，正常详情用 `raw: true` 取得源文本；解释失败的资源保留原文与诊断，并分别标明资源获取和业务结果的完整性，不当作无匹配或已知空闲。日历可仅凭实际资源 URL 与 `raw: true` 取整资源。读取和搜索超过结果预算会明确失败，不截断原文或列表。创建、更新和无变化候选均检查最终整份资源；源异常修订信息不能借自动刷新掩盖，无法修正或验证则停写。写工具只返回身份、版本与结果，不在内部回读；REMOTE_RESULT_UNKNOWN 表示可能已生效，应先核对目标，不能自动重发。

DAV 业务调用需要 Node.js 24+ 及可选依赖 `davkit`；Node.js 22 或省略 optional 依赖仍可加载插件并发现工具，调用 DAV 时返回环境指导，不影响其他能力，也不会自动安装依赖或改用旧 MCP。注册阶段不读配置或联网；DAV 配置按次调用加载，不自动迁移旧 DAV 凭据、切换账号或重试。

开发维护约定见 [AGENTS.md](https://github.com/tossp/pi-tsgw/blob/main/AGENTS.md)。
