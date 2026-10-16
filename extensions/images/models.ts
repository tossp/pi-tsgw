// 厂商型号与能力仍由 vendor 维护；图片模块提供能力入口和宿主基线判断。
export {
	OPENAI_IMAGE_API as IMAGE_API,
	OPENAI_IMAGE_MODEL_IDS as IMAGE_MODEL_IDS,
	openaiImageModels as imageModelsForRoot,
	type OpenAIImageModelConfig as ImageModelConfig,
} from "../models/vendors/openai.ts";

/** 混合模型目录和图片实现登记以 Pi 1.2 为已验证基线；旧宿主保持聊天目录。 */
export function supportsImageModels(version: string): boolean {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:\+.*)?$/.exec(version);
	if (!match) return false;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	return major > 1 || (major === 1 && minor >= 2);
}
