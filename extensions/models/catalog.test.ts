import { deepStrictEqual, equal, strictEqual, throws } from "node:assert";
import {
	DEFAULT_ROOT,
	filterModels,
	modelsForRoot,
	normalizeRoot,
	PROVIDER_ID,
} from "./catalog.ts";

const ROOT = "https://aih.example.com";

function testCatalogConcatenation(): void {
	const models = modelsForRoot(ROOT);
	const ids = models.map(({ id }) => id);

	// 11 家供应商分片拼接，共 65 个模型（原 59 + Grok 6）。
	equal(ids.length, 65);
	// id 全局唯一。
	equal(new Set(ids).size, ids.length);

	// 供应商覆盖：每家至少一个模型。
	for (const prefix of [
		"deepseek-",
		"glm-",
		"mimo-",
		"minimax-",
		"kimi-",
		"longcat-",
		"qwen",
		"gpt-",
		"gemini-",
		"claude-",
	]) {
		equal(
			ids.some((id) => id.startsWith(prefix)),
			true,
			`expected a model with prefix ${prefix}`,
		);
	}

	// 拼接顺序保持目录顺序（deepseek → … → claude → grok）。
	equal(ids[0], "deepseek-v4-flash");
	equal(ids[ids.length - 1], "grok-4.20-fast");

	// 模型 baseUrl 按协议端点派生。
	const deepseek = models.find(({ id }) => id === "deepseek-v4-flash");
	strictEqual(deepseek?.baseUrl, `${ROOT}/v1`);
	const gemini = models.find(({ id }) => id === "gemini-flash");
	strictEqual(gemini?.baseUrl, `${ROOT}/gemini`);
	const claude = models.find(({ id }) => id === "claude-fable-5");
	strictEqual(claude?.baseUrl, `${ROOT}/anthropic`);
}

function testFilterModels(): void {
	const all = modelsForRoot(ROOT);

	// 无过滤条件：原样返回（新数组，元素不变）。
	const untouched = filterModels(all);
	equal(untouched.length, all.length);
	strictEqual(untouched[0], all[0]);

	// 白名单精确匹配。
	deepStrictEqual(
		filterModels(all, { include: ["glm-5.2"] }).map(({ id }) => id),
		["glm-5.2"],
	);

	// 白名单前缀通配。
	deepStrictEqual(
		filterModels(all, { include: ["gpt-5.6-*"] }).map(({ id }) => id),
		["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
	);
	// 黑名单精确匹配。
	const excluded = filterModels(all, { exclude: ["claude-sonnet"] });
	equal(
		excluded.some(({ id }) => id === "claude-sonnet"),
		false,
	);
	equal(excluded.length, all.length - 1);

	// 黑名单前缀通配。
	const noGemini = filterModels(all, { exclude: ["gemini-*"] });
	equal(
		noGemini.some(({ id }) => id.startsWith("gemini-")),
		false,
	);

	// 黑白名单并存：黑名单优先于白名单。
	const both = filterModels(all, {
		include: ["glm-*", "claude-*"],
		exclude: ["glm-5.1", "claude-sonnet"],
	});
	equal(
		both.some(({ id }) => id.startsWith("glm-")),
		true,
	);
	equal(
		both.some(({ id }) => id.startsWith("claude-")),
		true,
	);
	equal(
		both.some(({ id }) => id === "glm-5.1"),
		false,
	);
	equal(
		both.some(({ id }) => id === "claude-sonnet"),
		false,
	);
}

function testNormalizeRoot(): void {
	strictEqual(normalizeRoot(), DEFAULT_ROOT);
	strictEqual(
		normalizeRoot("https://gw.example.com/v1"),
		"https://gw.example.com",
	);
	strictEqual(
		normalizeRoot("https://gw.example.com/v1/"),
		"https://gw.example.com",
	);
	strictEqual(
		normalizeRoot("https://gw.example.com/"),
		"https://gw.example.com",
	);
	strictEqual(
		normalizeRoot("https://gw.example.com/base/v1"),
		"https://gw.example.com/base",
	);
	throws(() => normalizeRoot("ftp://gw.example.com"), /http or https/);
	throws(() => normalizeRoot("not-a-url"), /not a valid URL/);
	equal(PROVIDER_ID, "tsgw");
}

testCatalogConcatenation();
testFilterModels();
testNormalizeRoot();
console.log("catalog.test.ts: all assertions passed");
