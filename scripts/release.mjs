import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryPath = fileURLToPath(new URL("../", import.meta.url));
const packagePath = resolve(repositoryPath, "package.json");
const changelogPath = resolve(repositoryPath, "CHANGELOG.md");
const releaseFiles = [
  "package.json",
  "package-lock.json",
  "CHANGELOG.md",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
  "src-tauri/tauri.conf.json",
  "src-tauri/src/app_config.rs",
];
const bumpKinds = new Set(["patch", "minor", "major"]);
const args = process.argv.slice(2);
const bumpKind = bumpKinds.has(args[0]) ? args.shift() : "patch";
const note = args.join(" ").trim().replace(/\s*\n\s*/g, " ");

function runGit(args, capture = false) {
  const result = spawnSync("git", args, {
    cwd: repositoryPath,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture ? (result.stderr || result.stdout || "").trim() : "";
    throw new Error(`Git 命令执行失败：git ${args.join(" ")}${detail ? `\n${detail}` : ""}`);
  }
  return (result.stdout || "").trim();
}

function assertTagMissing(tagName) {
  const result = spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/tags/${tagName}`], { cwd: repositoryPath });
  if (result.error) throw result.error;
  if (result.status === 0) throw new Error(`Git tag ${tagName} 已存在，已停止发布。`);
  if (result.status !== 1) throw new Error(`无法检查 Git tag ${tagName}。`);
}

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
const tagName = `v${nextVersion}`;

const gitRoot = runGit(["rev-parse", "--show-toplevel"], true);
if (resolve(gitRoot) !== resolve(repositoryPath)) throw new Error(`发布脚本必须在独立 Git 仓库根目录运行，当前仓库根为：${gitRoot}`);
const branch = runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], true);
const worktreeStatus = runGit(["status", "--porcelain=v1", "--untracked-files=all"], true);
if (worktreeStatus) throw new Error(`发布前必须提交或清理工作区改动：\n${worktreeStatus}`);
if (!runGit(["config", "--get", "user.name"], true) || !runGit(["config", "--get", "user.email"], true)) throw new Error("请先配置 Git user.name 和 user.email。 ");
assertTagMissing(tagName);

const originalReleaseFiles = new Map(releaseFiles.map(path => [path, readFileSync(resolve(repositoryPath, path))]));
function restoreReleaseFiles() {
  originalReleaseFiles.forEach((content, path) => writeFileSync(resolve(repositoryPath, path), content));
}

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
const buildResult = spawnSync(npmCommand, ["run", "tauri", "build"], { cwd: repositoryPath, stdio: "inherit" });
if (buildResult.error || buildResult.status !== 0) {
  restoreReleaseFiles();
  console.error("安装包构建失败，版本文件已恢复，未创建 commit 或 tag。");
  if (buildResult.error) throw buildResult.error;
  process.exit(buildResult.status ?? 1);
}

runGit(["add", "--", ...releaseFiles]);
const unstagedFiles = runGit(["diff", "--name-only"], true);
const untrackedFiles = runGit(["ls-files", "--others", "--exclude-standard"], true);
if (unstagedFiles || untrackedFiles) throw new Error(`构建产生了发布清单之外的改动，已停止提交和打 tag：\n${[unstagedFiles, untrackedFiles].filter(Boolean).join("\n")}`);
runGit(["commit", "-m", `release: ${tagName}`]);
const committedPackage = JSON.parse(runGit(["show", "HEAD:package.json"], true));
if (committedPackage.version !== nextVersion) throw new Error(`发布提交中的版本不是 ${nextVersion}，未创建 tag。`);
if (runGit(["status", "--porcelain=v1", "--untracked-files=all"], true)) throw new Error("发布提交后工作区仍有改动，未创建 tag。");
runGit(["tag", "-a", tagName, "-m", `MDLite ${tagName}\n\n${note}`]);
console.log(`发布完成：已创建 release commit 和 annotated tag ${tagName}。`);
console.log(`确认无误后推送：git push origin ${branch} --follow-tags`);
