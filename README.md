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

需要发版时，使用下面的命令即可自动递增版本、写入更新日志并构建当前系统的安装包：

```bash
npm run release:patch -- "修复查找定位"
npm run release:minor -- "新增文件夹管理"
npm run release:major -- "不兼容的配置调整"
```

其中 `patch`、`minor`、`major` 分别对应补丁、小版本和大版本升级；更新说明必填，确保更新日志可读。

macOS 在 Mac 上构建；Windows 安装包应在 Windows 环境或 CI 的 Windows runner 上原生构建。不要把一个平台的构建产物当作另一个平台可执行文件。

项目内的 `.cargo/config.toml` 仅将 Rust 依赖下载切换到 rsproxy 镜像，不影响机器的全局 Cargo 配置。`.github/workflows/build-desktop.yml` 会在 macOS runner 输出 `.dmg`，在 Windows runner 输出 `.exe`/`.msi`。
