import assert from "node:assert/strict";
import { test } from "node:test";
import { supportsClassifierModels, supportsImageModels } from "./capabilities.ts";

for (const [name, supports] of [["图片", supportsImageModels], ["分类", supportsClassifierModels]] as const) {
	test(`${name}宿主基线：仅 Pi 1.2.0 及以上稳定版本启用`, () => {
		for (const version of ["0.82.0", "1.0.0", "1.1.9", "1.2.0-beta", "1.2.0-rc.1", "unknown", "1.2", ""]) {
			assert.equal(supports(version), false, version);
		}
		for (const version of ["1.2.0", "1.3.0", "2.0.0", "1.2.0+test"]) {
			assert.equal(supports(version), true, version);
		}
	});
}
