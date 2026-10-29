# pi-tsgw

自用的 Pi 扩展，为 TOSSP AIH gateway 提供模型目录、请求适配、联网搜索、图片生成与编辑、分类模型及配套工作流。以 MIT 许可证公开。

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

开发维护约定见 [AGENTS.md](https://github.com/tossp/pi-tsgw/blob/main/AGENTS.md)。
