import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

/** TypeSafe 是厂商，Jev 是其分类模型系列；厂商目录不混入聊天目录。 */
export const TYPESAFE_CLASSIFIER_API = "typesafe-system-one";
export const TYPESAFE_CLASSIFIER_MODEL_IDS = ["jev-latest", "jev-preview"] as const;
export type TypeSafeClassifierModelConfig = Extract<ProviderModelConfig, { type: "classifier" }>;

const MODEL_NAMES = {
	"jev-latest": "TypeSafe Jev Latest",
	"jev-preview": "TypeSafe Jev Preview",
} as const;

/**
 * TypeSafe 官方来源（2026-10-18）：https://docs.typesafe.ai/models
 * Jev 仅声明文本输入，总请求窗口按 64,000 登记；官方单题窗口为 32K，
 * 不能把总窗口当作每题预算。别名可移动，不推定本网关的底层版本。
 * 公开参考输入价 0.042 USD/Mtok，输出与缓存为 0，仅用于估算，不代表网关实扣。
 */
export function typesafeClassifierModels(root: string): TypeSafeClassifierModelConfig[] {
	const baseUrl = `${root.replace(/\/+$/, "")}/v1`;
	return TYPESAFE_CLASSIFIER_MODEL_IDS.map((id) => ({
		type: "classifier" as const,
		id,
		name: MODEL_NAMES[id],
		api: TYPESAFE_CLASSIFIER_API,
		baseUrl,
		input: ["text"],
		contextWindow: 64_000,
		cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
	}));
}
