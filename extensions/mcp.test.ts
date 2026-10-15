import { deepStrictEqual, equal, match } from "node:assert/strict";
import { test } from "node:test";
import registerTsgw from "./index.ts";
import { TS_OHT_NAME, TS_OHT_URL } from "./mcp.ts";
import { createPi, FakePi, withAgentDir } from "./test-support.test.ts";

const registration = (url: string) => [{ name: TS_OHT_NAME, config: { url, exposure: "codemode" } }];

test("entry registers the built-in ts_oht endpoint without any configuration", async () => {
	const pi = await createPi();
	equal(TS_OHT_NAME, "ts_oht");
	equal(TS_OHT_URL, "https://xn--oht.cc/mcp");
	deepStrictEqual(pi.mcpServers, registration(TS_OHT_URL));
	equal(pi.providers.length, 1);
});

test("tsgw.mcpUrl overrides the default independently of model gateway configuration", async () => {
	for (const url of ["https://custom-mcp.invalid/mcp", "https://custom-mcp.invalid/mcp/", "http://localhost:3010/mcp"]) {
		const pi = await createPi({ tsgw: { baseUrl: "https://different-gateway.invalid", mcpUrl: url } });
		deepStrictEqual(pi.mcpServers, registration(url), "Keep exact URL for the host's OAuth scope");
	}
});

test("invalid explicit mcpUrl never falls back to the public default or logs its value", async () => {
	const original = console.error;
	const errors: string[] = [];
	console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
	try {
		for (const mcpUrl of [null, false, 42, {}, [], "", "not-a-url", "file:///tmp/secret", "https://user:secret@private.invalid/mcp", "https://private.invalid/mcp#secret", " https://private.invalid/mcp "]) {
			const pi = await createPi({ tsgw: { mcpUrl } });
			deepStrictEqual(pi.mcpServers, []);
			equal(pi.providers.length, 1, "Invalid optional MCP must not disable the provider");
		}
		equal(errors.length, 11);
		for (const error of errors) equal(error, "TSGW: invalid mcpUrl; ts_oht registration skipped.");
	} finally { console.error = original; }
});

test("an older host without MCP registration keeps provider initialization available", async () => {
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
		match(errors[0]!, /host cannot register MCP servers/);
	} finally { console.error = original; }
});
