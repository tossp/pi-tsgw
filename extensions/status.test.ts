import { deepStrictEqual, match, strictEqual } from "node:assert";
import {
	catalogDiagnostics,
	catalogLabel,
	searchLabel,
	type CatalogStatus,
} from "./status.ts";
import { DEFAULT_GATEWAY_MODEL_CACHE_TTL_MS as TTL } from "./models/gateway-catalog.ts";
import { applyBuiltinSearchTool, builtinSearchSupport } from "./models/web-search.ts";

const STORED_AT = Date.parse("2026-01-02T03:04:05.000Z");
const NOW = STORED_AT + 1_000;
const OPTIONS = {
	credentialConfigured: true,
	rootConfigured: true,
	traceEnabled: false,
};
const BASE: CatalogStatus = Object.freeze({
	count: 42,
	source: "network",
	storedAt: STORED_AT,
	loading: false,
});

function testCatalogLabels(): void {
	// 加载优先于配置警告，配置警告优先于错误/静态/过期状态。
	for (const source of ["static", "cache", "network"] as const) {
		for (const storedAt of [undefined, STORED_AT, NOW - TTL]) {
			for (const error of [undefined, "目录刷新失败"]) {
				for (const loading of [false, true]) {
					for (const credential of [false, true]) {
						for (const root of [false, true]) {
							const state = { ...BASE, source, storedAt, error, loading };
							const expected = loading
								? "⏳ TSGW"
								: !credential || !root
									? "⚠️ TSGW · 42"
									: error || source === "static" || storedAt !== STORED_AT
										? "🟡 TSGW · 42"
										: "🟢 TSGW · 42";
							strictEqual(catalogLabel(state, credential, root, NOW), expected);
						}
					}
				}
			}
		}
	}
	strictEqual(catalogLabel({ ...BASE, count: 0 }, true, true, NOW), "🟢 TSGW · 0");
	strictEqual(catalogLabel({ ...BASE, error: "" }, true, true, NOW), "🟢 TSGW · 42");
}

function testTtlAndTimestamps(): void {
	for (const source of ["cache", "network"] as const) {
		const state = Object.freeze({ ...BASE, source });
		for (const [age, fresh] of [
			[-1, true], // 时钟回拨，与目录缓存保持一致。
			[0, true],
			[TTL - 1, true],
			[TTL, false],
			[TTL + 1, false],
		] as const) {
			const now = STORED_AT + age;
			strictEqual(
				catalogLabel(state, true, true, now),
				`${fresh ? "🟢" : "🟡"} TSGW · 42`,
			);
			const diagnostics = catalogDiagnostics(state, OPTIONS, now);
			match(diagnostics, new RegExp(`缓存状态：${fresh ? "新鲜" : "过期"}`));
			match(diagnostics, /真实获取时间：2026-01-02T03:04:05\.000Z/);
		}
	}

	// 缺失/无效时间不得冒充新鲜目录，也不应使 ISO 格式化抛错。
	for (const storedAt of [undefined, NaN, Infinity, -Infinity, -1, 1e20]) {
		const state = { ...BASE, storedAt };
		strictEqual(catalogLabel(state, true, true, NOW), "🟡 TSGW · 42");
		const diagnostics = catalogDiagnostics(state, OPTIONS, NOW);
		match(diagnostics, /真实获取时间：未知/);
		match(diagnostics, /缓存状态：未知/);
	}
	const epoch = { ...BASE, storedAt: 0 };
	strictEqual(catalogLabel(epoch, true, true, TTL - 1), "🟢 TSGW · 42");
	strictEqual(catalogLabel(epoch, true, true, TTL), "🟡 TSGW · 42");
	match(catalogDiagnostics(epoch, OPTIONS, 0), /1970-01-01T00:00:00\.000Z/);

	// 静态目录没有真实获取时间，即使调用者意外携带 storedAt。
	const staticState = { ...BASE, source: "static" as const };
	match(catalogDiagnostics(staticState, OPTIONS, NOW), /真实获取时间：未知/);
	match(catalogDiagnostics(staticState, OPTIONS, NOW), /缓存状态：未知/);

	const originalNow = Date.now;
	try {
		Date.now = () => NOW;
		strictEqual(catalogLabel(BASE, true, true), catalogLabel(BASE, true, true, NOW));
		strictEqual(catalogDiagnostics(BASE, OPTIONS), catalogDiagnostics(BASE, OPTIONS, NOW));
		Date.now = () => STORED_AT + TTL;
		strictEqual(catalogLabel(BASE, true, true), "🟡 TSGW · 42");
		match(catalogDiagnostics(BASE, OPTIONS), /缓存状态：过期/);
	} finally {
		Date.now = originalNow;
	}
}

function testDiagnostics(): void {
	strictEqual(catalogDiagnostics(BASE, OPTIONS, NOW), [
		"目录数量：42",
		"目录来源：网关",
		"目录加载：未进行",
		"真实获取时间：2026-01-02T03:04:05.000Z",
		"（保留网关实际获取时间，不是本轮缓存读取时间）",
		"缓存状态：新鲜",
		"错误：无",
		"配置凭据：存在",
		"网关地址：已设置",
		"追踪开关：关",
		"仅表示目录状态，不代表模型推理健康；不展示密钥或 URL。",
	].join("\n"));

	for (const [source, label] of [
		["static", "内置静态"],
		["cache", "缓存"],
		["network", "网关"],
	] as const) {
		match(catalogDiagnostics({ ...BASE, source }, OPTIONS, NOW), new RegExp(`目录来源：${label}`));
	}
	for (const credentialConfigured of [false, true]) {
		for (const rootConfigured of [false, true]) {
			for (const traceEnabled of [false, true]) {
				const options = Object.freeze({ credentialConfigured, rootConfigured, traceEnabled });
				const state = Object.freeze({ ...BASE, count: 0, loading: true, error: "网关目录请求超时" });
				const text = catalogDiagnostics(state, options, NOW);
				match(text, /目录数量：0/);
				match(text, /目录加载：进行中/);
				match(text, /错误：网关目录请求超时/);
				match(text, new RegExp(`配置凭据：${credentialConfigured ? "存在" : "不存在"}`));
				match(text, new RegExp(`网关地址：${rootConfigured ? "已设置" : "未设置"}`));
				match(text, new RegExp(`追踪开关：${traceEnabled ? "开" : "关"}`));
				// 错误与缓存新鲜度独立展示，不把请求错误假称为缓存过期。
				match(text, /缓存状态：新鲜/);
			}
		}
	}
}

function testBuiltinSearchSupport(): void {
	const gptModels = [
		"gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna",
		"gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5",
	];
	const grokModels = [
		"grok-4.20", "grok-4.5", "grok-4.3-low", "grok-4.3-medium",
		"grok-4.3-high", "grok-4.20-fast",
	];
	const unsupportedModels = [
		"", "gpt-5.6-k3", "gpt-6.1", "gpt-6.1-sol-extra", "GPT-6.1-SOL",
		" gpt-6.1-sol", "gpt-6.1-sol ", "grok-4", "grok-4.20-extra",
		"Grok-4.20", "grok-4.20 ", "claude-sonnet-4.6", "gemini-3-pro",
	];
	const apis = [
		"openai-responses", "openai-completions", "anthropic-messages",
		"google-generative-ai", "", "OpenAI-Responses", "OpenAI-Completions",
		"openai-responses ", " openai-completions", "openai-responses-extra",
		"openai-completions-extra",
	];
	for (const model of [...gptModels, ...grokModels, ...unsupportedModels]) {
		for (const api of apis) {
			const expected = api === "openai-responses" && gptModels.includes(model)
				? "gpt"
				: api === "openai-completions" && grokModels.includes(model)
					? "grok"
					: undefined;
			strictEqual(builtinSearchSupport(model, api), expected, `${model}/${api}`);
			// 查询与实际注入使用同一支持判断；不支持仍返回原对象。
			for (const mode of ["cached", "live"] as const) {
				const input = Object.freeze({ marker: "preserve" });
				const result = applyBuiltinSearchTool(input, model, api, mode);
				if (expected === undefined) {
					strictEqual(result, input);
				} else if (expected === "grok") {
					deepStrictEqual(result, { ...input, search_parameters: { mode: "on" } });
				} else {
					deepStrictEqual(result, {
						...input,
						tools: [{
							type: "web_search",
							search_context_size: "medium",
							external_web_access: mode === "live",
						}],
					});
				}
			}
		}
	}
}

function testSearchLabels(): void {
	for (const mode of ["cached", "live"] as const) {
		strictEqual(searchLabel(mode, undefined), "⚪ 内置联网：不支持");
		strictEqual(searchLabel(mode, "gpt"), mode === "cached"
			? "🟡 内置联网：缓存" : "🟢 内置联网：实时");
		strictEqual(searchLabel(mode, "grok"), "🟢 内置联网：实时");
	}
	strictEqual(searchLabel("cached", builtinSearchSupport("gpt-6.1-sol", "openai-responses")), "🟡 内置联网：缓存");
	strictEqual(searchLabel("cached", builtinSearchSupport("grok-4.20", "openai-completions")), "🟢 内置联网：实时");
	strictEqual(searchLabel("live", builtinSearchSupport("grok-4.20", "openai-responses")), "⚪ 内置联网：不支持");
}

testCatalogLabels();
testTtlAndTimestamps();
testDiagnostics();
testBuiltinSearchSupport();
testSearchLabels();
console.log("status.test.ts: all assertions passed");
