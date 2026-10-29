/** 只判断稳定版宿主基线，不读取宿主运行时或用户配置。 */
function supportsStablePi12(version: string): boolean {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:\+.*)?$/.exec(version);
	if (!match) return false;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	return major > 1 || (major === 1 && minor >= 2);
}

/** 图片目录与适配器以 Pi 1.2 稳定版为已验证登记基线。 */
export function supportsImageModels(version: string): boolean {
	return supportsStablePi12(version);
}

/** 分类目录与桥接沿用插件的 Pi 1.2 稳定版基线。 */
export function supportsClassifierModels(version: string): boolean {
	return supportsStablePi12(version);
}
