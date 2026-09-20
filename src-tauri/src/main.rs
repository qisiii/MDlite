use arboard::Clipboard;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::{Path, PathBuf}, sync::Mutex, time::{SystemTime, UNIX_EPOCH}};
use tauri::{menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder}, AppHandle, Emitter, Manager, Runtime, State, WebviewWindow};
#[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
use tauri::RunEvent;
use tauri_plugin_clipboard_manager::ClipboardExt;
#[cfg(target_os = "macos")]
use objc2::sel;
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSPrintInfo, NSPrintJobDisposition, NSPrintJobSavingURL, NSPrintSaveJob};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSObjectProtocol, NSString, NSURL};
#[cfg(target_os = "macos")]
use objc2_web_kit::WKWebView;

mod app_config;
use app_config::APP_NAME;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MarkdownDocument {
  path: String,
  relative_path: String,
  content: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MarkdownFolder {
  path: String,
  relative_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MarkdownWorkspace {
  documents: Vec<MarkdownDocument>,
  folders: Vec<MarkdownFolder>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClipboardPaste {
  kind: String,
  content: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PdfExportResult {
  path: String,
  error: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RecentEntry {
  kind: String,
  path: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct WorkspaceRootSession {
  path: String,
  kind: String,
  documents: Vec<String>,
  closed_documents: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct WorkspaceSession {
  roots: Vec<WorkspaceRootSession>,
  expanded_folders: Vec<String>,
  active_root: Option<String>,
  current_path: Option<String>,
  selected_folder: Option<String>,
}

const RECENT_LIMIT: usize = 5;

#[derive(Default)]
struct OpenedMarkdownFiles {
  state: Mutex<OpenedMarkdownFileState>,
}

#[derive(Default)]
struct OpenedMarkdownFileState {
  paths: Vec<String>,
  frontend_ready: bool,
}

fn append_error_log(app: &tauri::AppHandle, category: &str, detail: &str) -> Result<String, String> {
  let log_dir = app.path().app_log_dir().map_err(|error| format!("无法定位日志目录：{}", error))?;
  fs::create_dir_all(&log_dir).map_err(|error| format!("无法创建日志目录：{}", error))?;
  let log_path = log_dir.join("errors.log");
  let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|error| error.to_string())?.as_millis();
  let safe_detail = detail.replace(['\r', '\n'], " ").chars().take(2_000).collect::<String>();
  let mut file = fs::OpenOptions::new().create(true).append(true).open(&log_path).map_err(|error| format!("无法写入日志：{}", error))?;
  writeln!(file, "{} category={} detail={}", timestamp, category, safe_detail).map_err(|error| format!("无法写入日志：{}", error))?;
  Ok(log_path.to_string_lossy().to_string())
}

#[tauri::command]
fn report_error(app: tauri::AppHandle, category: String, detail: String) -> Result<String, String> {
  let category = category.chars().filter(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | ':' | '.')).take(80).collect::<String>();
  if category.is_empty() { return Err("日志类别无效".into()); }
  append_error_log(&app, &category, &detail)
}

#[tauri::command]
fn copy_markdown_text(app: tauri::AppHandle, text: String) -> Result<(), String> {
  if text.is_empty() { return Err("没有可复制的内容".into()); }
  app.clipboard().write_text(text).map_err(|error| format!("无法写入系统剪贴板：{}", error))
}

#[tauri::command]
fn read_clipboard_text(app: tauri::AppHandle) -> Result<String, String> {
  app.clipboard().read_text().map_err(|error| format!("无法读取系统剪贴板文字：{}", error))
}

fn is_markdown(path: &Path) -> bool {
  path.extension().and_then(|extension| extension.to_str()).map(|extension| matches!(extension.to_ascii_lowercase().as_str(), "md" | "markdown")).unwrap_or(false)
}

fn read_document(path: &Path, root: &Path) -> Result<MarkdownDocument, String> {
  let content = fs::read_to_string(path).map_err(|error| format!("无法读取 {}：{}", path.display(), error))?;
  let relative_path = path.strip_prefix(root).unwrap_or(path).to_string_lossy().replace('\\', "/");
  Ok(MarkdownDocument { path: path.to_string_lossy().to_string(), relative_path, content })
}

fn read_folder(path: &Path, root: &Path) -> MarkdownFolder {
  MarkdownFolder { path: path.to_string_lossy().to_string(), relative_path: path.strip_prefix(root).unwrap_or(path).to_string_lossy().replace('\\', "/") }
}

fn collect_markdown(dir: &Path, root: &Path, documents: &mut Vec<MarkdownDocument>, folders: &mut Vec<MarkdownFolder>) -> Result<(), String> {
  for entry in fs::read_dir(dir).map_err(|error| format!("无法读取目录 {}：{}", dir.display(), error))? {
    let path = entry.map_err(|error| error.to_string())?.path();
    if path.is_dir() { folders.push(read_folder(&path, root)); collect_markdown(&path, root, documents, folders)?; }
    else if is_markdown(&path) { documents.push(read_document(&path, root)?); }
  }
  Ok(())
}

#[tauri::command]
fn load_markdown_folder(folder_path: String) -> Result<MarkdownWorkspace, String> {
  let root = PathBuf::from(folder_path).canonicalize().map_err(|error| format!("目录无效：{}", error))?;
  if !root.is_dir() { return Err("请选择目录".into()); }
  let mut documents = Vec::new(); let mut folders = Vec::new(); collect_markdown(&root, &root, &mut documents, &mut folders)?;
  documents.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
  folders.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
  Ok(MarkdownWorkspace { documents, folders })
}

#[tauri::command]
fn read_markdown_file(path: String) -> Result<MarkdownDocument, String> {
  let path = PathBuf::from(path).canonicalize().map_err(|error| format!("文件无效：{}", error))?;
  if !path.is_file() || !is_markdown(&path) { return Err("请选择 Markdown 文件".into()); }
  let root = path.parent().unwrap_or(Path::new("")); read_document(&path, root)
}

#[tauri::command]
fn save_markdown_file(path: String, content: String) -> Result<(), String> {
  let path = PathBuf::from(path).canonicalize().map_err(|error| format!("文件无效：{}", error))?;
  if !path.is_file() || !is_markdown(&path) { return Err("只能保存已打开的 Markdown 文件".into()); }
  fs::write(&path, content).map_err(|error| format!("无法保存 {}：{}", path.display(), error))
}

#[tauri::command]
fn save_markdown_file_as(path: String, content: String) -> Result<MarkdownDocument, String> {
  let requested_path = PathBuf::from(path);
  let parent = requested_path.parent().ok_or("无法定位保存目录")?.canonicalize().map_err(|error| format!("保存目录无效：{}", error))?;
  if !parent.is_dir() { return Err("请选择有效的保存目录".into()); }
  let file_name = requested_path.file_name().and_then(|name| name.to_str()).ok_or("文件名无效")?;
  let mut file_name = safe_name(file_name)?;
  if !is_markdown(Path::new(&file_name)) { file_name.push_str(".md"); }
  let target = parent.join(file_name);
  fs::write(&target, content).map_err(|error| format!("无法保存 {}：{}", target.display(), error))?;
  read_document(&target, &parent)
}

#[tauri::command]
fn save_html_export(path: String, content: String) -> Result<(), String> {
  let requested_path = PathBuf::from(path);
  let parent = requested_path.parent().ok_or("无法定位导出目录")?.canonicalize().map_err(|error| format!("导出目录无效：{}", error))?;
  if !parent.is_dir() { return Err("请选择有效的导出目录".into()); }
  let file_name = requested_path.file_name().and_then(|name| name.to_str()).ok_or("文件名无效")?;
  let mut file_name = safe_name(file_name)?;
  if !matches!(Path::new(&file_name).extension().and_then(|extension| extension.to_str()).map(|extension| extension.to_ascii_lowercase()), Some(ref extension) if extension == "html" || extension == "htm") { file_name.push_str(".html"); }
  fs::write(parent.join(file_name), content).map_err(|error| format!("无法导出 HTML：{}", error))
}

fn pdf_export_target(path: String) -> Result<PathBuf, String> {
  let requested_path = PathBuf::from(path);
  let parent = requested_path.parent().ok_or("无法定位导出目录")?.canonicalize().map_err(|error| format!("导出目录无效：{}", error))?;
  if !parent.is_dir() { return Err("请选择有效的导出目录".into()); }
  let file_name = requested_path.file_name().and_then(|name| name.to_str()).ok_or("文件名无效")?;
  let mut file_name = safe_name(file_name)?;
  if !matches!(Path::new(&file_name).extension().and_then(|extension| extension.to_str()).map(|extension| extension.to_ascii_lowercase()), Some(ref extension) if extension == "pdf") { file_name.push_str(".pdf"); }
  Ok(parent.join(file_name))
}

#[cfg(target_os = "macos")]
unsafe fn export_webview_pdf(webview: *mut std::ffi::c_void, target: &Path) -> Result<(), String> {
  let webview = unsafe { &*(webview.cast::<WKWebView>()) };
  if !webview.respondsToSelector(sel!(printOperationWithPrintInfo:)) { return Err("当前 macOS 版本不支持 PDF 导出".into()); }
  let shared_info = NSPrintInfo::sharedPrintInfo();
  let settings = shared_info.dictionary();
  let target_path = NSString::from_str(&target.to_string_lossy());
  let target_url = NSURL::fileURLWithPath(&target_path);
  settings.insert(&*NSPrintJobSavingURL, &*target_url);
  settings.insert(&*NSPrintJobDisposition, &*NSPrintSaveJob);
  shared_info.setJobDisposition(&NSPrintSaveJob);
  let operation = webview.printOperationWithPrintInfo(&shared_info);
  operation.setShowsPrintPanel(false);
  operation.setShowsProgressPanel(false);
  if !operation.runOperation() || !target.is_file() { return Err("macOS 未能生成 PDF".into()); }
  Ok(())
}

#[tauri::command]
fn export_pdf(window: WebviewWindow, path: String) -> Result<String, String> {
  let target = pdf_export_target(path)?;
  let target_string = target.to_string_lossy().to_string();
  #[cfg(target_os = "macos")]
  {
    let app = window.app_handle().clone();
    let event_path = target_string.clone();
    window.with_webview(move |webview| {
      let error = unsafe { export_webview_pdf(webview.inner(), &target) }.err();
      let _ = app.emit("pdf-export-finished", PdfExportResult { path: event_path, error });
    }).map_err(|error| error.to_string())?;
    Ok(target_string)
  }
  #[cfg(not(target_os = "macos"))]
  {
    let _ = window;
    Err("PDF 导出目前仅支持 macOS".into())
  }
}

fn safe_name(name: &str) -> Result<String, String> {
  let value = name.trim();
  if value.is_empty() || value == "." || value == ".." || value.contains('/') || value.contains('\\') { return Err("名称不能为空，且不能包含路径分隔符".into()); }
  Ok(value.to_string())
}

#[tauri::command]
fn create_markdown_folder(parent_path: String, name: String) -> Result<MarkdownFolder, String> {
  let parent = PathBuf::from(parent_path).canonicalize().map_err(|error| format!("目标目录无效：{}", error))?;
  if !parent.is_dir() { return Err("请选择有效的目标目录".into()); }
  let folder = parent.join(safe_name(&name)?);
  fs::create_dir(&folder).map_err(|error| format!("无法新建文件夹：{}", error))?;
  Ok(MarkdownFolder { path: folder.to_string_lossy().to_string(), relative_path: folder.file_name().unwrap_or_default().to_string_lossy().to_string() })
}

#[tauri::command]
fn create_markdown_file(parent_path: String, name: String) -> Result<MarkdownDocument, String> {
  let parent = PathBuf::from(parent_path).canonicalize().map_err(|error| format!("目标目录无效：{}", error))?;
  if !parent.is_dir() { return Err("请选择有效的目标目录".into()); }
  let mut file_name = safe_name(&name)?;
  if !is_markdown(Path::new(&file_name)) { file_name.push_str(".md"); }
  let path = parent.join(&file_name);
  if path.exists() { return Err(format!("{} 已存在", file_name)); }
  let title = file_name.trim_end_matches(".markdown").trim_end_matches(".md");
  let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&path).map_err(|error| format!("无法新建 Markdown 文档：{}", error))?;
  file.write_all(format!("# {}\n\n", title).as_bytes()).map_err(|error| format!("无法写入 Markdown 文档：{}", error))?;
  read_document(&path, &parent)
}

fn image_mime(path: &Path) -> Option<&'static str> {
  match path.extension().and_then(|extension| extension.to_str()).map(|extension| extension.to_ascii_lowercase())?.as_str() {
    "png" => Some("image/png"), "jpg" | "jpeg" => Some("image/jpeg"), "gif" => Some("image/gif"),
    "webp" => Some("image/webp"), "svg" => Some("image/svg+xml"), "bmp" => Some("image/bmp"), _ => None,
  }
}

fn image_extension(mime: &str) -> Result<&'static str, String> {
  match mime {
    "image/png" => Ok("png"), "image/jpeg" => Ok("jpg"), "image/gif" => Ok("gif"), "image/webp" => Ok("webp"),
    "image/svg+xml" => Ok("svg"), "image/bmp" => Ok("bmp"), _ => Err("只支持 PNG、JPEG、GIF、WebP、SVG 或 BMP 图片".into()),
  }
}

fn crc32(bytes: &[u8]) -> u32 {
  let mut value = 0xffff_ffffu32;
  for byte in bytes {
    value ^= *byte as u32;
    for _ in 0..8 { value = if value & 1 == 1 { (value >> 1) ^ 0xedb8_8320 } else { value >> 1 }; }
  }
  !value
}

fn adler32(bytes: &[u8]) -> u32 {
  const MOD: u32 = 65_521;
  let (mut a, mut b) = (1u32, 0u32);
  for byte in bytes { a = (a + *byte as u32) % MOD; b = (b + a) % MOD; }
  (b << 16) | a
}

fn append_png_chunk(output: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
  output.extend_from_slice(&(data.len() as u32).to_be_bytes());
  output.extend_from_slice(kind); output.extend_from_slice(data);
  let mut checksum_data = Vec::with_capacity(kind.len() + data.len());
  checksum_data.extend_from_slice(kind); checksum_data.extend_from_slice(data);
  output.extend_from_slice(&crc32(&checksum_data).to_be_bytes());
}

fn write_rgba_png(path: &Path, width: u32, height: u32, rgba: &[u8]) -> Result<(), String> {
  if width == 0 || height == 0 { return Err("剪贴板图片尺寸无效".into()); }
  let stride = width.checked_mul(4).ok_or("剪贴板图片宽度无效")? as usize;
  let expected = stride.checked_mul(height as usize).ok_or("剪贴板图片尺寸无效")?;
  if rgba.len() != expected { return Err("剪贴板图片像素数据不完整".into()); }
  let mut scanlines = Vec::with_capacity(expected + height as usize);
  for row in rgba.chunks_exact(stride) { scanlines.push(0); scanlines.extend_from_slice(row); }
  // PNG allows DEFLATE stored blocks. It is slightly larger than compressed PNG, but avoids another native dependency.
  let mut compressed = vec![0x78, 0x01];
  for (index, chunk) in scanlines.chunks(65_535).enumerate() {
    compressed.push(if (index + 1) * 65_535 >= scanlines.len() { 1 } else { 0 });
    let length = chunk.len() as u16; compressed.extend_from_slice(&length.to_le_bytes()); compressed.extend_from_slice(&(!length).to_le_bytes()); compressed.extend_from_slice(chunk);
  }
  compressed.extend_from_slice(&adler32(&scanlines).to_be_bytes());
  let mut png = Vec::with_capacity(compressed.len() + 64);
  png.extend_from_slice(b"\x89PNG\r\n\x1a\n");
  let mut header = Vec::with_capacity(13); header.extend_from_slice(&width.to_be_bytes()); header.extend_from_slice(&height.to_be_bytes()); header.extend_from_slice(&[8, 6, 0, 0, 0]);
  append_png_chunk(&mut png, b"IHDR", &header); append_png_chunk(&mut png, b"IDAT", &compressed); append_png_chunk(&mut png, b"IEND", &[]);
  fs::write(path, png).map_err(|error| format!("无法保存剪贴板图片：{}", error))
}

#[tauri::command]
fn read_markdown_image(markdown_path: String, source: String) -> Result<String, String> {
  let markdown_path = PathBuf::from(markdown_path).canonicalize().map_err(|error| format!("Markdown 文件无效：{}", error))?;
  let root = markdown_path.parent().ok_or("无法定位 Markdown 所在目录")?.canonicalize().map_err(|error| error.to_string())?;
  let image_path = root.join(source).canonicalize().map_err(|error| format!("无法读取图片：{}", error))?;
  if !image_path.starts_with(&root) { return Err("图片必须位于当前 Markdown 所在目录或其子目录中".into()); }
  let mime = image_mime(&image_path).ok_or("不支持的图片格式")?;
  let bytes = fs::read(&image_path).map_err(|error| format!("无法读取图片：{}", error))?;
  Ok(format!("data:{};base64,{}", mime, STANDARD.encode(bytes)))
}

#[tauri::command]
fn save_markdown_image(markdown_path: String, image_data: String) -> Result<String, String> {
  let markdown_path = PathBuf::from(markdown_path).canonicalize().map_err(|error| format!("Markdown 文件无效：{}", error))?;
  let root = markdown_path.parent().ok_or("无法定位 Markdown 所在目录")?;
  let (header, encoded) = image_data.split_once(',').ok_or("图片数据格式无效")?;
  let mime = header.strip_prefix("data:").and_then(|value| value.strip_suffix(";base64")).ok_or("只接受图片数据")?;
  let extension = image_extension(mime)?;
  let bytes = STANDARD.decode(encoded).map_err(|_| "图片编码无效")?;
  let image_dir = root.join("images"); fs::create_dir_all(&image_dir).map_err(|error| format!("无法创建图片目录：{}", error))?;
  let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|error| error.to_string())?.as_millis();
  let image_path = image_dir.join(format!("image-{}.{}", stamp, extension));
  fs::write(&image_path, bytes).map_err(|error| format!("无法保存图片：{}", error))?;
  Ok(image_path.strip_prefix(root).map_err(|error| error.to_string())?.to_string_lossy().replace('\\', "/"))
}

#[tauri::command]
fn import_markdown_image(markdown_path: String, source_path: String) -> Result<String, String> {
  let markdown_path = PathBuf::from(markdown_path).canonicalize().map_err(|error| format!("Markdown 文件无效：{}", error))?;
  let root = markdown_path.parent().ok_or("无法定位 Markdown 所在目录")?;
  copy_markdown_image(root, &PathBuf::from(source_path))
}

fn copy_markdown_image(root: &Path, source_path: &Path) -> Result<String, String> {
  let source_path = source_path.canonicalize().map_err(|error| format!("无法读取图片：{}", error))?;
  let extension = image_mime(&source_path).ok_or("只支持 PNG、JPEG、GIF、WebP、SVG 或 BMP 图片")?.split('/').last().unwrap_or("png").replace("svg+xml", "svg").replace("jpeg", "jpg");
  let image_dir = root.join("images"); fs::create_dir_all(&image_dir).map_err(|error| format!("无法创建图片目录：{}", error))?;
  let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|error| error.to_string())?.as_millis();
  let image_path = image_dir.join(format!("image-{}.{}", stamp, extension));
  fs::copy(&source_path, &image_path).map_err(|error| format!("无法导入图片：{}", error))?;
  Ok(image_path.strip_prefix(root).map_err(|error| error.to_string())?.to_string_lossy().replace('\\', "/"))
}

fn paste_markdown_image(app: &tauri::AppHandle, markdown_path: &str) -> Result<String, String> {
  let markdown_path = PathBuf::from(markdown_path).canonicalize().map_err(|error| format!("Markdown 文件无效：{}", error))?;
  let root = markdown_path.parent().ok_or("无法定位 Markdown 所在目录")?;
  match app.clipboard().read_image() {
    Ok(image) => {
      let width = image.width(); let height = image.height(); let rgba = image.rgba().to_vec();
      let image_dir = root.join("images"); fs::create_dir_all(&image_dir).map_err(|error| format!("无法创建图片目录：{}", error))?;
      let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|error| error.to_string())?.as_millis();
      let image_path = image_dir.join(format!("image-{}.png", stamp));
      write_rgba_png(&image_path, width, height, &rgba)?;
      Ok(image_path.strip_prefix(root).map_err(|error| error.to_string())?.to_string_lossy().replace('\\', "/"))
    }
    Err(image_error) => {
      let mut clipboard = Clipboard::new().map_err(|error| format!("无法访问系统剪贴板：{}", error))?;
      let source_path = clipboard.get().file_list().map_err(|file_error| format!("剪贴板不是可读取的图片，也不是图片文件：图片读取失败（{}）；文件读取失败（{}）", image_error, file_error))?
        .into_iter().find(|path| image_mime(path).is_some()).ok_or("剪贴板文件中没有 PNG、JPEG、GIF、WebP、SVG 或 BMP 图片")?;
      copy_markdown_image(root, &source_path)
    }
  }
}

#[tauri::command]
fn paste_markdown_clipboard(app: tauri::AppHandle, markdown_path: String) -> Result<ClipboardPaste, String> {
  match paste_markdown_image(&app, &markdown_path) {
    Ok(content) => Ok(ClipboardPaste { kind: "image".into(), content }),
    Err(image_error) => match app.clipboard().read_text() {
      Ok(content) if !content.is_empty() => Ok(ClipboardPaste { kind: "text".into(), content }),
      _ => {
        let _ = append_error_log(&app, "clipboard-paste", &image_error);
        Err(image_error)
      }
    }
  }
}

fn recent_history_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
  Ok(app.path().app_data_dir().map_err(|error| format!("无法定位应用数据目录：{}", error))?.join("recent-history.txt"))
}

fn read_recent_entries<R: Runtime>(app: &AppHandle<R>) -> Vec<RecentEntry> {
  let Ok(path) = recent_history_path(app) else { return Vec::new(); };
  let Ok(content) = fs::read_to_string(path) else { return Vec::new(); };
  content.lines().filter_map(|line| {
    let (kind, path) = line.split_once('\t')?;
    if matches!(kind, "file" | "folder") && !path.is_empty() { Some(RecentEntry { kind: kind.into(), path: path.into() }) } else { None }
  }).filter(|entry| Path::new(&entry.path).exists()).take(RECENT_LIMIT).collect()
}

fn write_recent_entries<R: Runtime>(app: &AppHandle<R>, entries: &[RecentEntry]) -> Result<(), String> {
  let path = recent_history_path(app)?;
  let parent = path.parent().ok_or("无法定位应用数据目录")?;
  fs::create_dir_all(parent).map_err(|error| format!("无法创建应用数据目录：{}", error))?;
  let content = entries.iter().map(|entry| format!("{}\t{}", entry.kind, entry.path.replace(['\r', '\n'], ""))).collect::<Vec<_>>().join("\n");
  fs::write(path, content).map_err(|error| format!("无法保存历史记录：{}", error))
}

fn workspace_session_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
  Ok(app.path().app_data_dir().map_err(|error| format!("无法定位应用数据目录：{}", error))?.join("workspace-session.txt"))
}

fn encode_session_path(path: &str) -> String { STANDARD.encode(path.as_bytes()) }

fn decode_session_path(value: &str) -> Option<String> {
  String::from_utf8(STANDARD.decode(value).ok()?).ok()
}

fn read_workspace_session<R: Runtime>(app: &AppHandle<R>) -> Option<WorkspaceSession> {
  let path = workspace_session_path(app).ok()?;
  let content = fs::read_to_string(path).ok()?;
  let mut session = WorkspaceSession::default();
  for line in content.lines() {
    let fields = line.split('\t').collect::<Vec<_>>();
    match fields.as_slice() {
      ["root", kind, path] if matches!(*kind, "folder" | "files") => {
        let path = decode_session_path(path)?;
        if Path::new(&path).is_dir() { session.roots.push(WorkspaceRootSession { path, kind: (*kind).into(), documents: Vec::new(), closed_documents: Vec::new() }); }
      }
      ["document", root, path] => {
        let (root, path) = (decode_session_path(root)?, decode_session_path(path)?);
        if is_markdown(Path::new(&path)) && Path::new(&path).is_file() {
          if let Some(entry) = session.roots.iter_mut().find(|entry| entry.path == root && entry.kind == "files") { entry.documents.push(path); }
        }
      }
      ["closed", root, path] => {
        let (root, path) = (decode_session_path(root)?, decode_session_path(path)?);
        if is_markdown(Path::new(&path)) && Path::new(&path).is_file() {
          if let Some(entry) = session.roots.iter_mut().find(|entry| entry.path == root) { entry.closed_documents.push(path); }
        }
      }
      ["expanded", path] => if let Some(path) = decode_session_path(path) { session.expanded_folders.push(path); },
      ["active", path] => session.active_root = decode_session_path(path),
      ["current", path] => session.current_path = decode_session_path(path),
      ["selected", path] => session.selected_folder = decode_session_path(path),
      _ => {}
    }
  }
  (!session.roots.is_empty()).then_some(session)
}

fn write_workspace_session<R: Runtime>(app: &AppHandle<R>, session: &WorkspaceSession) -> Result<(), String> {
  let path = workspace_session_path(app)?;
  let parent = path.parent().ok_or("无法定位应用数据目录")?;
  fs::create_dir_all(parent).map_err(|error| format!("无法创建应用数据目录：{}", error))?;
  let mut lines = Vec::new();
  for root in &session.roots {
    if !matches!(root.kind.as_str(), "folder" | "files") || !Path::new(&root.path).is_dir() { continue; }
    lines.push(format!("root\t{}\t{}", root.kind, encode_session_path(&root.path)));
    if root.kind == "files" {
      for document in &root.documents {
        if is_markdown(Path::new(document)) && Path::new(document).is_file() { lines.push(format!("document\t{}\t{}", encode_session_path(&root.path), encode_session_path(document))); }
      }
    }
    for document in &root.closed_documents {
      if is_markdown(Path::new(document)) && Path::new(document).is_file() { lines.push(format!("closed\t{}\t{}", encode_session_path(&root.path), encode_session_path(document))); }
    }
  }
  for folder in &session.expanded_folders { lines.push(format!("expanded\t{}", encode_session_path(folder))); }
  if let Some(path) = &session.active_root { lines.push(format!("active\t{}", encode_session_path(path))); }
  if let Some(path) = &session.current_path { lines.push(format!("current\t{}", encode_session_path(path))); }
  if let Some(path) = &session.selected_folder { lines.push(format!("selected\t{}", encode_session_path(path))); }
  fs::write(path, lines.join("\n")).map_err(|error| format!("无法保存工作区会话：{}", error))
}

#[tauri::command]
fn load_workspace_session(app: AppHandle) -> Option<WorkspaceSession> { read_workspace_session(&app) }

#[tauri::command]
fn save_workspace_session(app: AppHandle, session: WorkspaceSession) -> Result<(), String> { write_workspace_session(&app, &session) }

fn recent_label(entry: &RecentEntry) -> String {
  let path = Path::new(&entry.path);
  let name = path.file_name().unwrap_or_else(|| path.as_os_str()).to_string_lossy();
  let parent = path.parent().map(|value| value.to_string_lossy()).unwrap_or_default();
  let kind = if entry.kind == "folder" { "📁" } else { "📄" };
  if parent.is_empty() { format!("{} {}", kind, name) } else { format!("{} {} — {}", kind, name, parent) }
}

fn build_application_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
  let quit = MenuItemBuilder::with_id("quit", format!("退出 {}", APP_NAME)).accelerator("CmdOrCtrl+Q").build(app)?;
  let app_menu = SubmenuBuilder::new(app, APP_NAME).text("about", format!("关于 {}", APP_NAME)).separator().item(&quit).build()?;
  let new_markdown = MenuItemBuilder::with_id("new-markdown", "新建 Markdown 文档…").accelerator("CmdOrCtrl+N").build(app)?;
  let new_folder = MenuItemBuilder::with_id("new-folder", "新建文件夹…").accelerator("CmdOrCtrl+Shift+N").build(app)?;
  let open_folder = MenuItemBuilder::with_id("open-folder", "打开文档目录…").accelerator("CmdOrCtrl+Shift+O").build(app)?;
  let open_file = MenuItemBuilder::with_id("open-file", "打开单个文件…").accelerator("CmdOrCtrl+O").build(app)?;
  let insert_image = MenuItemBuilder::with_id("insert-image", "插入图片…").accelerator("CmdOrCtrl+Shift+I").build(app)?;
  let paste_image = MenuItemBuilder::with_id("paste-image", "从剪贴板粘贴内容").accelerator("CmdOrCtrl+Shift+V").build(app)?;
  let close_document = MenuItemBuilder::with_id("close-document", "关闭当前文档").accelerator("CmdOrCtrl+W").build(app)?;
  let reload = MenuItemBuilder::with_id("reload", "从磁盘重新载入").accelerator("CmdOrCtrl+R").build(app)?;
  let save = MenuItemBuilder::with_id("save", "保存").accelerator("CmdOrCtrl+S").build(app)?;
  let export_html = MenuItemBuilder::with_id("export-html", "导出 HTML…").accelerator("CmdOrCtrl+Shift+E").build(app)?;
  let export_pdf = MenuItemBuilder::with_id("export-pdf", "导出 PDF…").accelerator("CmdOrCtrl+P").build(app)?;
  let mut recent_menu = SubmenuBuilder::new(app, "历史记录");
  let recent_entries = read_recent_entries(app);
  if recent_entries.is_empty() {
    recent_menu = recent_menu.text("recent-empty", "暂无历史记录");
  } else {
    for (index, entry) in recent_entries.iter().enumerate() {
      let item = MenuItemBuilder::with_id(format!("recent-{}", index), recent_label(entry)).build(app)?;
      recent_menu = recent_menu.item(&item);
    }
  }
  let recent_menu = recent_menu.build()?;
  let undo = MenuItemBuilder::with_id("undo", "撤销").accelerator("CmdOrCtrl+Z").build(app)?;
  let redo = MenuItemBuilder::with_id("redo", "恢复撤销").accelerator("CmdOrCtrl+Shift+Z").build(app)?;
  let cut_selection = MenuItemBuilder::with_id("cut-selection", "剪切选中内容").accelerator("CmdOrCtrl+X").build(app)?;
  let copy_selection = MenuItemBuilder::with_id("copy-selection", "复制选中内容").accelerator("CmdOrCtrl+C").build(app)?;
  let find_replace = MenuItemBuilder::with_id("find-replace", "查找和替换…").accelerator("CmdOrCtrl+F").build(app)?;
  let edit_mode = MenuItemBuilder::with_id("mode-edit", "编辑模式").accelerator("CmdOrCtrl+1").build(app)?;
  let split_mode = MenuItemBuilder::with_id("mode-split", "分栏模式").accelerator("CmdOrCtrl+2").build(app)?;
  let preview_mode = MenuItemBuilder::with_id("mode-preview", "预览模式").accelerator("CmdOrCtrl+3").build(app)?;
  let global_search = MenuItemBuilder::with_id("global-search", "在目录中搜索…").accelerator("CmdOrCtrl+Shift+F").build(app)?;
  let file_menu = SubmenuBuilder::new(app, "文件").item(&new_markdown).item(&new_folder).separator().item(&open_folder).item(&open_file).item(&recent_menu).item(&reload).item(&close_document).separator().item(&insert_image).item(&paste_image).separator().item(&save).item(&export_html).item(&export_pdf).build()?;
  let edit_menu = SubmenuBuilder::new(app, "编辑").item(&undo).item(&redo).separator().item(&cut_selection).item(&copy_selection).separator().item(&find_replace).item(&global_search).build()?;
  let view_menu = SubmenuBuilder::new(app, "视图").item(&edit_mode).item(&split_mode).item(&preview_mode).build()?;
  MenuBuilder::new(app).item(&app_menu).item(&file_menu).item(&edit_menu).item(&view_menu).build()
}

fn refresh_application_menu<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
  app.set_menu(build_application_menu(app).map_err(|error| error.to_string())?).map(|_| ()).map_err(|error| error.to_string())
}

#[tauri::command]
fn remember_recent(app: AppHandle, kind: String, path: String) -> Result<(), String> {
  if !matches!(kind.as_str(), "file" | "folder") { return Err("历史记录类型无效".into()); }
  let path = PathBuf::from(path).canonicalize().map_err(|error| format!("历史记录路径无效：{}", error))?;
  if (kind == "file" && (!path.is_file() || !is_markdown(&path))) || (kind == "folder" && !path.is_dir()) { return Err("历史记录路径类型不匹配".into()); }
  let path = path.to_string_lossy().to_string();
  let mut entries = read_recent_entries(&app);
  entries.retain(|entry| entry.path != path);
  entries.insert(0, RecentEntry { kind, path });
  entries.truncate(RECENT_LIMIT);
  write_recent_entries(&app, &entries)?;
  refresh_application_menu(&app)
}

#[tauri::command]
fn load_recent_documents(app: AppHandle) -> Vec<RecentEntry> {
  read_recent_entries(&app).into_iter().filter(|entry| entry.kind == "file").collect()
}

#[tauri::command]
fn take_opened_markdown_files(opened_files: State<OpenedMarkdownFiles>) -> Vec<String> {
  let mut state = opened_files.state.lock().unwrap_or_else(|error| error.into_inner());
  state.frontend_ready = true;
  std::mem::take(&mut state.paths)
}

fn main() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_clipboard_manager::init())
    .plugin(tauri_plugin_opener::init())
    .manage(OpenedMarkdownFiles::default())
    .setup(|app| {
      let _ = append_error_log(&app.handle(), "app-start", &format!("version={}", env!("CARGO_PKG_VERSION")));
      let panic_app = app.handle().clone();
      let default_panic_hook = std::panic::take_hook();
      std::panic::set_hook(Box::new(move |info| {
        let _ = append_error_log(&panic_app, "rust-panic", &info.to_string());
        default_panic_hook(info);
      }));
      // macOS requires an application submenu before the functional menus.
      app.set_menu(build_application_menu(&app.handle())?)?;
      app.on_menu_event(move |app_handle, event| match event.id().0.as_str() {
        "quit" => app_handle.exit(0),
        id if id.starts_with("recent-") => {
          if let Some(index) = id.strip_prefix("recent-").and_then(|value| value.parse::<usize>().ok()) {
            if let Some(entry) = read_recent_entries(app_handle).get(index) { let _ = app_handle.emit("open-recent-item", entry); }
          }
        }
        action => { let _ = app_handle.emit("menu-action", action); }
      });
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![load_markdown_folder, read_markdown_file, save_markdown_file, save_markdown_file_as, save_html_export, export_pdf, create_markdown_folder, create_markdown_file, read_markdown_image, save_markdown_image, import_markdown_image, paste_markdown_clipboard, report_error, copy_markdown_text, read_clipboard_text, remember_recent, load_recent_documents, load_workspace_session, save_workspace_session, take_opened_markdown_files])
    .build(tauri::generate_context!())
    .unwrap_or_else(|error| panic!("启动 {} 失败：{}", APP_NAME, error))
    .run(|app_handle, event| {
      #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
      if let RunEvent::Opened { urls } = event {
        for url in urls {
          if let Ok(path) = url.to_file_path() {
            if is_markdown(&path) {
              let path = path.to_string_lossy().to_string();
              let opened_files = app_handle.state::<OpenedMarkdownFiles>();
              let mut state = opened_files.state.lock().unwrap_or_else(|error| error.into_inner());
              if state.frontend_ready {
                drop(state);
                let _ = app_handle.emit("open-markdown-file", path);
              } else {
                state.paths.push(path);
              }
            }
          }
        }
      }
      #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
      let _ = (app_handle, event);
    });
}
