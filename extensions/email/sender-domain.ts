import { domainToASCII } from "node:url";

/** 统一配置与发件地址的 IDN 比较；拒绝 URL 片段、通配符和隐式子域匹配。 */
export function normalizeFromDomain(value: string): string | undefined {
	if (/[\s@/:\\?#%\u0000-\u001f\u007f]/.test(value)) return undefined;
	const domain = domainToASCII(value).toLowerCase();
	if (!domain || domain.length > 253 || domain.split(".").some(label =>
		!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return undefined;
	return domain;
}
