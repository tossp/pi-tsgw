import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("../", import.meta.url));
// 按源码发现测试，避免误跑 dist 中已重命名或删除的旧产物。
const tests = globSync(["index.test.ts", "extensions/**/*.test.ts"], {
  cwd,
  exclude: ["**/*test-support.test.ts", "**/*-fixtures.test.ts", "extensions/upload/live.test.ts"],
}).sort().map(file => `dist/${file.replace(/\.ts$/, ".js")}`);

if (tests.length === 0) throw new Error("未找到测试文件");
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...tests], { cwd, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
