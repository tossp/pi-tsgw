import { deepStrictEqual, equal, match } from "node:assert/strict";
import { test } from "node:test";
import registerTsgw from "./index.ts";
import { TS_OHT_NAME, TS_OHT_URL } from "./mcp.ts";
import { createPi, FakePi, withAgentDir } from "./test-support.test.ts";

const registration = (url: string) => [{ name: TS_OHT_NAME, config: { url, exposure: "codemode" } }];

test("无配置时入口注册内置 ts_oht 端点", async () => {
	const pi = await createPi();
	equal(TS_OHT_NAME, "ts_oht");
	equal(TS_OHT_URL, "https://xn--oht.cc/mcp");
	deepStrictEqual(pi.mcpServers, registration(TS_OHT_URL));
	equal(pi.providers.length, 1);
});

test("tsgw.mcpUrl 独立于模型网关配置覆盖默认值", async () => {
	for (const url of ["https://custom-mcp.invalid/mcp", "https://custom-mcp.invalid/mcp/", "http://localhost:3010/mcp"]) {
		const pi = await createPi({ tsgw: { baseUrl: "https://different-gateway.invalid", mcpUrl: url } });
		deepStrictEqual(pi.mcpServers, registration(url), "为宿主的 OAuth 作用域保留精确 URL");
	}
});

test("显式无效 mcpUrl 绝不回退到公共默认值，也不记录其值", async () => {
	const original = console.error;
	const errors: string[] = [];
	console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
	try {
		for (const mcpUrl of [null, false, 42, {}, [], "", "not-a-url", "file:///tmp/secret", "https://user:secret@private.invalid/mcp", "https://private.invalid/mcp#secret", " https://private.invalid/mcp "]) {
			const pi = await createPi({ tsgw: { mcpUrl } });
			deepStrictEqual(pi.mcpServers, []);
			equal(pi.providers.length, 1, "无效的可选 MCP 配置不得禁用模型提供方");
		}
		equal(errors.length, 11);
		for (const error of errors) equal(error, "TSGW：mcpUrl 无效；已跳过 ts_oht 注册。");
	} finally { console.error = original; }
});

test("不支持 MCP 注册的旧宿主仍可初始化模型提供方", async () => {
	const original = console.error;
	const errors: string[] = [];
	console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
	try {
		const pi = new FakePi();
		Object.defineProperty(pi, "registerMcpServer", { value: undefined });
		await withAgentDir(undefined, async () => registerTsgw(pi));
		deepStrictEqual(pi.mcpServers, []);
		equal(pi.providers.length, 1);
		equal(errors.length, 1);
		match(errors[0]!, /宿主无法注册 MCP 服务器/);
	} finally { console.error = original; }
});
