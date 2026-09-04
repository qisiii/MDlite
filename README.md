# MDLite

跨平台桌面编辑器：以原始 `.md` 为唯一数据源，支持目录浏览、源码编辑、实时预览、外部文件变更检测与重载、飞书兼容 HTML 表格内的二次 Markdown 解析，以及 Mermaid 图表全屏缩放。

## 开发

```bash
npm install
npm run tauri dev
```

## 构建

```bash
npm run tauri build
```

## 发布约定

- 日常功能修改默认不升版本、不生成安装包。
- 仅在明确要求“发版”或“打包”时，更新 `package.json` 的版本、补充 [CHANGELOG.md](CHANGELOG.md)，再执行构建。
- 应用名称、包名、Bundle ID 和版本均以 `package.json` 为唯一配置源；构建前会自动同步到 Tauri 与 Rust 配置。
- 发布前必须先提交功能代码并保持 Git 工作区干净；构建成功后，发布脚本会创建 `release: v<版本号>` 提交及同名 annotated tag。

需要发版时，使用下面的命令即可自动递增版本、写入更新日志并构建当前系统的安装包：

```bash
npm run release:patch -- "修复查找定位"
npm run release:minor -- "新增文件夹管理"
npm run release:major -- "不兼容的配置调整"
```

其中 `patch`、`minor`、`major` 分别对应补丁、小版本和大版本升级；更新说明必填，确保更新日志可读。

发布脚本不会自动推送。确认本地安装包无误后，将 release commit 和 tag 一起推送；推送 `v*` tag 会触发 GitHub Actions 构建 macOS 和 Windows 安装包。两个平台都构建成功后，Actions 会自动创建 GitHub Release，以 tag 注释作为发布说明，并上传 `.dmg`、`.exe` 和 `.msi` 安装包：

```bash
git push origin main --follow-tags
```

需要从旧版本重新打包时，可以直接基于 tag 创建临时 worktree，不影响当前开发目录：

```bash
git worktree add ../MDLite-v0.1.15 v0.1.15
cd ../MDLite-v0.1.15
npm ci
npm run tauri build
```

macOS 在 Mac 上构建；Windows 安装包应在 Windows 环境或 CI 的 Windows runner 上原生构建。不要把一个平台的构建产物当作另一个平台可执行文件。

项目内的 `.cargo/config.toml` 仅将 Rust 依赖下载切换到 rsproxy 镜像，不影响机器的全局 Cargo 配置。`.github/workflows/build-desktop.yml` 会在 macOS runner 输出 `.dmg`，在 Windows runner 输出 `.exe`/`.msi`。
