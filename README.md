# pi-tsgw

自用的 Pi 扩展，为 TOSSP AIH gateway 提供模型目录、请求适配、联网搜索、图片生成与编辑、分类模型及配套工作流，并提供可选的 IMAP／SMTP 邮件组件。以 MIT 许可证公开。

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

## 可选邮件配置

邮件能力需要 Pi 1.2+。在宿主用户目录新增独立的 `tsgw-email.json`（权限 `0600`），然后 `/reload`；文件不存在就不注册邮件能力。以下地址与密码均为占位内容，`imap`、`smtp` 都支持任意多个自定义 ID：

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
  },
  "defaultSmtp": "outbound"
}
```

`implicit` 表示连接即 TLS；`starttls` 必须成功升级 TLS，均校验证书。SMTP 可选 `fromName` 和 `envelopeFrom`；未配置后者时信封发件人跟随最终 From。邮件工具统一 `tsgw_email_` 前缀，通过 codemode 的 `describeNamespace("tsgw_email")` 按需发现，不直接声明或内联到模型上下文。无后台同步、磁盘缓存、自动重发、出口切换或发送后存档；读取不自动标已读。附件仅允许当前工作目录或系统临时目录，不允许访问宿主配置目录，符号链接按真实路径校验。超出读取预算、原始头部不是合法 UTF-8，或 inline 文本附件会被库转换字符集／flowed 格式时，会明确报告，不把截断或改写内容当作完整原文。

开发维护约定见 [AGENTS.md](https://github.com/tossp/pi-tsgw/blob/main/AGENTS.md)。
