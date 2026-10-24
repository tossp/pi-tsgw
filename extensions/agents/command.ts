import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { installStandardAgents } from "./install.ts";

function report(ctx: ExtensionCommandContext, message: string, level: "info" | "error"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
	else process.stderr.write(`${message}\n`);
}

/** 仅显式命令写入代理目录，不在启动或重载事件中同步。 */
export function registerAgentInstallCommand(pi: ExtensionAPI): void {
	pi.registerCommand("insagent", {
		description: "覆盖安装 TSGW 标准子代理、清理旧定义、停用内置代理并重载当前会话",
		handler: async (args, ctx) => {
			if (args.trim()) {
				report(ctx, "用法：/insagent（不接收参数）。", "error");
				return;
			}
			await ctx.waitForIdle();
			let result;
			try {
				result = installStandardAgents(getAgentDir());
			} catch (error) {
				report(ctx, `TSGW 子代理安装未完成：${error instanceof Error ? error.message : "文件操作失败"}。` +
					"可能已有部分文件更新；未自动重载，修复后可重新执行 /insagent。", "error");
				return;
			}
			report(ctx, `已写入 ${result.installed.length} 个 TSGW 子代理，清理 ${result.removed.length} 个旧定义：` +
				`${result.directory}。已停用 Pi Web 内置代理，正在重载当前会话；其他已打开的主会话需各自重载。`, "info");
			// 重载使旧上下文失效，之后不再访问 ctx 或旧运行器。
			await ctx.reload();
		},
	});
}
