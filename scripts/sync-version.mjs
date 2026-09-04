import { existsSync, readFileSync, writeFileSync } from "node:fs";

const packagePath = new URL("../package.json", import.meta.url);
const packageLockPath = new URL("../package-lock.json", import.meta.url);
const cargoPath = new URL("../src-tauri/Cargo.toml", import.meta.url);
const tauriPath = new URL("../src-tauri/tauri.conf.json", import.meta.url);
const rustConfigPath = new URL("../src-tauri/src/app_config.rs", import.meta.url);
const packageConfig = JSON.parse(readFileSync(packagePath, "utf8"));
const { name, displayName, version, tauri: packageTauri } = packageConfig;
const identifier = packageTauri?.identifier;
if (!name || !displayName || !version || !identifier) throw new Error("package.json 必须配置 name、displayName、version 和 tauri.identifier");

function writeWhenChanged(path, next) {
  if (!existsSync(path) || readFileSync(path, "utf8") !== next) writeFileSync(path, next);
}

const packageLock = JSON.parse(readFileSync(packageLockPath, "utf8"));
if (!packageLock.packages?.[""]) throw new Error("package-lock.json 缺少根包信息");
packageLock.version = version;
packageLock.packages[""].version = version;
writeWhenChanged(packageLockPath, `${JSON.stringify(packageLock, null, 2)}\n`);

const cargo = readFileSync(cargoPath, "utf8");
if (!/^version = ".*"$/m.test(cargo)) throw new Error("未能在 Cargo.toml 中找到版本号");
const nextCargo = cargo.replace(/^name = ".*"$/m, `name = "${name}"`).replace(/^version = ".*"$/m, `version = "${version}"`);
writeWhenChanged(cargoPath, nextCargo);

const tauri = JSON.parse(readFileSync(tauriPath, "utf8"));
tauri.version = version;
tauri.productName = displayName;
tauri.identifier = identifier;
tauri.app.windows = tauri.app.windows.map(windowConfig => ({ ...windowConfig, title: displayName }));
writeWhenChanged(tauriPath, `${JSON.stringify(tauri, null, 2)}\n`);

writeWhenChanged(rustConfigPath, `// 此文件由 scripts/sync-version.mjs 自动生成，请勿手动编辑。\npub const APP_NAME: &str = ${JSON.stringify(displayName)};\n`);
