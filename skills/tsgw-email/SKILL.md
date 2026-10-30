---
name: tsgw-email
description: 需要处理电子邮件时读取技能
license: MIT
---

# 邮件工具

通过 codemode 按需发现和调用 `tsgw_email` 命名空间：先用 `describeNamespace("tsgw_email")` 查看工具，再用 `describeTool("tsgw_email_<工具名>")` 读取本次所需工具的说明和参数，按其提示执行。不预加载整套工具 schema。

以下工具均带 `tsgw_email_` 前缀：

| 工具 | 用途 |
| --- | --- |
| `accounts` | 查看 IMAP 账户、SMTP 出口及默认发件身份 |
| `mailboxes` | 查看邮箱文件夹 |
| `list` | 分页列出邮件摘要 |
| `search` | 按条件搜索邮件 |
| `read` | 读取正文及附件清单 |
| `headers` | 读取原始邮件头 |
| `attachment` | 下载指定附件或 MIME 部件 |
| `mark` | 设置已读、未读或星标 |
| `move` | 移动邮件 |
| `trash` | “删除邮件”“移入回收站”“扔进垃圾桶”均使用此工具，不永久删除 |
| `purge` | 用户明确要求“永久删除邮件”时使用，永久删除回收站内指定邮件 |
| `junk` | 标为垃圾邮件／移入垃圾邮件箱；“垃圾桶”指 `trash`，不是此工具 |
| `not_junk` | 从垃圾邮件处理流程移回收件箱 |
| `send` | 发送或回复邮件 |
