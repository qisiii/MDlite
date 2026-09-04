import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const packagePath = new URL("../package.json", import.meta.url);
const changelogPath = new URL("../CHANGELOG.md", import.meta.url);
const bumpKinds = new Set(["patch", "minor", "major"]);
const args = process.argv.slice(2);
const bumpKind = bumpKinds.has(args[0]) ? args.shift() : "patch";
const note = args.join(" ").trim().replace(/\s*\n\s*/g, " ");

if (!note) {
  throw new Error(`请提供本次更新说明。示例：npm run release:${bumpKind} -- "修复查找定位"`);
}

const packageConfig = JSON.parse(readFileSync(packagePath, "utf8"));
const versionMatch = /^(\d+)\.(\d+)\.(\d+)$/.exec(packageConfig.version);
if (!versionMatch) throw new Error(`仅支持标准三段式版本号，当前为：${packageConfig.version}`);

let [major, minor, patch] = versionMatch.slice(1).map(Number);
if (bumpKind === "major") { major += 1; minor = 0; patch = 0; }
if (bumpKind === "minor") { minor += 1; patch = 0; }
if (bumpKind === "patch") patch += 1;
const nextVersion = `${major}.${minor}.${patch}`;

packageConfig.version = nextVersion;
writeFileSync(packagePath, `${JSON.stringify(packageConfig, null, 2)}\n`);

const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
});
const date = formatter.formatToParts(new Date()).reduce((result, part) => {
  if (part.type !== "literal") result[part.type] = part.value;
  return result;
}, {});
const releaseDate = `${date.year}-${date.month}-${date.day}`;
const changelog = readFileSync(changelogPath, "utf8");
const heading = "本文件记录已对外构建的 MDLite 版本。未明确要求发版时，功能修改仅保留在工作目录，不调整版本号或生成安装包。\n";
if (!changelog.startsWith(`# 更新日志\n\n${heading}`)) throw new Error("CHANGELOG.md 的文件头不符合预期，已停止写入。");
const entry = `\n## [${nextVersion}] - ${releaseDate}\n\n- ${note}\n`;
writeFileSync(changelogPath, changelog.replace(heading, `${heading}${entry}`));

console.log(`版本已从 ${versionMatch[0]} 升级至 ${nextVersion}，正在构建安装包。`);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const buildResult = spawnSync(npmCommand, ["run", "tauri", "build"], { stdio: "inherit" });
if (buildResult.error) throw buildResult.error;
if (buildResult.status !== 0) process.exit(buildResult.status ?? 1);
