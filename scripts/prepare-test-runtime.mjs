#!/usr/bin/env node
// 由根 package.json imports 生成 dist/package.json，供编译后测试按最近的包清单解析别名。
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(projectRoot, "dist");
const sourcePackagePath = path.join(projectRoot, "package.json");
const distPackagePath = path.join(distDir, "package.json");

const fail = (message) => {
  throw new Error(`prepare-test-runtime: ${message}`);
};

const sourcePackage = JSON.parse(await readFile(sourcePackagePath, "utf8"));
const imports = sourcePackage.imports;
if (imports === null || typeof imports !== "object" || Array.isArray(imports)) {
  fail("根 package.json 缺少 imports 对象");
}

const distDirStat = await stat(distDir).catch(() => null);
if (!distDirStat?.isDirectory()) {
  fail("dist 目录不存在，请先运行 tsc");
}

const distImports = {};
for (const [specifier, target] of Object.entries(imports)) {
  if (!specifier.endsWith("/*")) {
    fail(`不支持的 imports 键 ${specifier}：仅支持通配符别名`);
  }
  if (
    typeof target !== "string" ||
    !target.startsWith("./") ||
    !target.endsWith(".ts") ||
    !target.includes("*")
  ) {
    fail(`不支持的 imports 目标 ${String(target)}：仅支持 ./ 开头且含 * 的 .ts 目标`);
  }
  const jsTarget = `${target.slice(0, -3)}.js`;
  const emittedDirectory = path.join(distDir, jsTarget.slice(0, jsTarget.lastIndexOf("*")));
  const emittedStat = await stat(emittedDirectory).catch(() => null);
  if (!emittedStat?.isDirectory()) {
    fail(`编译产物目录 ${path.relative(projectRoot, emittedDirectory)} 不存在，无法映射 ${specifier}`);
  }
  distImports[specifier] = jsTarget;
}

await writeFile(
  distPackagePath,
  `${JSON.stringify({ type: "module", imports: distImports }, null, 2)}\n`,
);
console.log(
  `已生成 ${path.relative(projectRoot, distPackagePath)}：${Object.keys(distImports).length} 个 imports 映射`,
);
