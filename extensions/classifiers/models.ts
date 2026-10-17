// 厂商型号与规格由 vendor 维护；分类模块只提供能力入口与宿主基线判断。
export {
	TYPESAFE_CLASSIFIER_API as CLASSIFIER_API,
	TYPESAFE_CLASSIFIER_MODEL_IDS as CLASSIFIER_MODEL_IDS,
	typesafeClassifierModels as classifierModelsForRoot,
	type TypeSafeClassifierModelConfig as ClassifierModelConfig,
} from "../models/vendors/typesafe.ts";

/** 分类模型沿用图片门语义：仅 Pi 1.2.0 及以上稳定版本启用，不抬高聊天最低 peer。 */
export function supportsClassifierModels(version: string): boolean {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:\+.*)?$/.exec(version);
	if (!match) return false;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	return major > 1 || (major === 1 && minor >= 2);
}
