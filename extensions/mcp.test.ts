import { deepStrictEqual, equal, match } from "node:assert/strict";
import { test } from "node:test";
import registerTsgw from "./index.ts";
import { TS_OHT_NAME, TS_OHT_URL, TS_TOOL_NAME, TS_TOOL_URL } from "./mcp.ts";
import { createPi, FakePi, withAgentDir } from "./test-support.test.ts";

const toolRegistration = { name: TS_TOOL_NAME, config: { url: TS_TOOL_URL, exposure: "codemode" } };
const registration = (url: string) => [
	{ name: TS_OHT_NAME, config: { url, exposure: "codemode" } }, toolRegistration,
];

test("无配置时入口仅登记两个内置 codemode 端点，不附带认证配置", async () => {
	const pi = await createPi();
	equal(TS_OHT_NAME, "ts_oht");
	equal(TS_OHT_URL, "https://xn--oht.cc/mcp");
	equal(TS_TOOL_NAME, "ts_tool");
	equal(TS_TOOL_URL, "https://mcp.tossp.com/mm/ts/mcp");
	deepStrictEqual(pi.mcpServers, registration(TS_OHT_URL));
	equal(pi.providers.length, 1);
});

test("tsgw.mcpUrl 仅覆盖 ts_oht，独立于模型网关和固定的 ts_tool", async () => {
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
			deepStrictEqual(pi.mcpServers, [toolRegistration]);
			equal(pi.providers.length, 1, "无效的可选 MCP 配置不得禁用模型提供方");
		}
		equal(errors.length, 11);
		for (const error of errors) equal(error, "TSGW：mcpUrl 无效；已跳过 ts_oht 注册。");
	} finally { console.error = original; }
});

test("单个或全部 MCP 登记抛错时仍尝试另一个服务，不输出宿主异常且保留 provider", async () => {
	const original = console.error;
	const errors: string[] = [];
	console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
	try {
		for (const failed of [[TS_OHT_NAME], [TS_TOOL_NAME], [TS_OHT_NAME, TS_TOOL_NAME]]) {
			errors.length = 0;
			const pi = new FakePi();
			const attempts: string[] = [];
			const register = pi.registerMcpServer;
			pi.registerMcpServer = (name, config) => {
				attempts.push(name);
				if (failed.includes(name)) throw new Error("private URL/token in host error");
				register(name, config);
			};
			await withAgentDir(undefined, async () => registerTsgw(pi));
			deepStrictEqual(attempts, [TS_OHT_NAME, TS_TOOL_NAME]);
			deepStrictEqual(pi.mcpServers, registration(TS_OHT_URL).filter(({ name }) => !failed.includes(name)));
			deepStrictEqual(errors, failed.map(name => `TSGW：宿主无法登记 ${name}；已跳过，请检查 Pi MCP 支持或同名扩展。`));
			equal(pi.providers.length, 1);
		}
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
		match(errors[0]!, /宿主无法注册 MCP 服务器；已跳过 ts_oht、ts_tool 注册/);
	} finally { console.error = original; }
});
