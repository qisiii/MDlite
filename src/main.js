import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { marked } from "marked";
import mermaid from "mermaid";
import { basicSetup, EditorView } from "codemirror";
import { EditorState } from "@codemirror/state";
import { undo, redo } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { closeSearchPanel, findNext, findPrevious, getSearchQuery, openSearchPanel, replaceAll, replaceNext, search, SearchQuery, setSearchQuery } from "@codemirror/search";
import { autocompletion, snippetCompletion } from "@codemirror/autocomplete";
import "highlight.js/styles/github-dark.css";
import "./style.css";

const APP_VERSION = __APP_VERSION__;
const APP_NAME = __APP_NAME__;
const ui = Object.fromEntries(["appVersion", "saveState", "fileTree", "fileCount", "recentList", "editor", "currentPath", "dirtyMark", "preview", "previewState", "workspace", "documentOutline", "outlineToggle", "themeToggle", "mermaidModal", "modalCanvas", "modalZoom", "findReplaceModal", "findText", "replaceText", "findStatus", "createModal", "createTitle", "createName", "createTarget", "reloadModal", "reloadFileName", "reloadMessage"].map(id => [id, document.getElementById(id)]));
const state = { roots: new Map(), docs: new Map(), recentDocuments: [], selectedFolder: null, activeRoot: null, expandedFolders: new Set(), current: null, dirty: false, mermaidSequence: 0, fullscreen: null, createKind: null, pasteShortcutToken: null, findPasteToken: null, previewMatch: null, reloadCheckPromise: null, reloadConflict: null, restoringSession: false, sessionSaveQueue: Promise.resolve(), themeTimer: null };
let editorView = null;
let selectionFormatMenu = null;
let folderContextMenu = null;
mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral" });
const SANITIZE_CONFIG = {
  ALLOWED_TAGS: ["a", "blockquote", "br", "code", "del", "div", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "img", "input", "li", "ol", "p", "pre", "span", "strong", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul"],
  ALLOWED_ATTR: ["align", "alt", "checked", "class", "colspan", "data-feishu-table", "disabled", "href", "rowspan", "scope", "src", "start", "title", "type"],
  ALLOW_ARIA_ATTR: false,
  ALLOW_DATA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  FORBID_ATTR: ["style"],
  FORBID_TAGS: ["script", "style", "template"]
};
DOMPurify.addHook("uponSanitizeAttribute", (_node, data) => {
  if (data.attrName === "src" && /^data:/i.test(data.attrValue) && !/^data:image\/(?:bmp|gif|jpe?g|png|webp);base64,/i.test(data.attrValue)) data.keepAttr = false;
});
marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }) {
      const language = (lang || "").trim().split(/\s+/, 1)[0].toLowerCase();
      if (language === "mermaid") return `<div class="mermaid-box"><div class="mermaid">${escapeHtml(text)}</div></div>\n`;
      const safeLanguage = /^[a-z0-9_+-]+$/i.test(language) ? language : "";
      let contents = escapeHtml(text);
      let highlighted = false;
      if (safeLanguage && hljs.getLanguage(safeLanguage)) {
        try { contents = hljs.highlight(text, { language: safeLanguage, ignoreIllegals: true }).value; highlighted = true; }
        catch (error) { void reportAppError("code-highlight", error); }
      }
      const classes = [safeLanguage && `language-${safeLanguage}`, highlighted && "hljs"].filter(Boolean).join(" ");
      return `<pre><code${classes ? ` class="${classes}"` : ""}>${contents}</code></pre>\n`;
    },
    html({ text }) { return text.replace(/<table\b/gi, '<table data-feishu-table="true"'); }
  }
});
ui.appVersion.textContent = `v${APP_VERSION}`;

async function reportAppError(category, error) {
  try { return await tauriInvoke("report_error", { category, detail: String(error) }); }
  catch { return ""; }
}
function clipboardDescription(event, files, text, html) {
  const types = [...(event.clipboardData?.types || [])].join(",") || "none";
  const items = [...(event.clipboardData?.items || [])].map(item => `${item.kind}:${item.type || "unknown"}`).join(",") || "none";
  return `types=${types}; items=${items}; imageFiles=${files.length}; textLength=${text.length}; htmlImage=${/<img\\b/i.test(html)}; hasDocument=${Boolean(state.current?.path)}`;
}
async function invoke(command, args) {
  try { return await tauriInvoke(command, args); }
  catch (error) {
    if (command !== "report_error") void reportAppError(`invoke:${command}`, error);
    throw error;
  }
}
window.addEventListener("error", event => {
  const detail = event.error?.stack || `${event.message || "未知前端异常"} at ${event.filename || ""}:${event.lineno || 0}:${event.colno || 0}`;
  void reportAppError("frontend-error", detail);
});
window.addEventListener("unhandledrejection", event => { void reportAppError("unhandled-rejection", event.reason?.stack || event.reason || "未知 Promise 异常"); });

function setSaveState(text, kind = "") { ui.saveState.textContent = text; ui.saveState.className = kind; }
function setDirty(value) { state.dirty = value; ui.dirtyMark.textContent = value ? "● 未保存" : ""; }
function automaticTheme(now = new Date()) { const hour = now.getHours(); return hour >= 7 && hour < 18 ? "light" : "dark"; }
function configureMermaidTheme(theme) {
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: theme === "dark" ? "dark" : "neutral" });
}
function applyTheme(theme) {
  const changed = document.documentElement.dataset.theme !== theme;
  const dark = theme === "dark";
  document.documentElement.dataset.theme = theme;
  configureMermaidTheme(theme);
  ui.themeToggle.textContent = dark ? "☀" : "☾";
  ui.themeToggle.title = dark ? "切换到日间模式" : "切换到夜间模式";
  ui.themeToggle.setAttribute("aria-label", ui.themeToggle.title);
  ui.themeToggle.setAttribute("aria-pressed", String(dark));
  if (changed && state.current && !state.fullscreen) void renderPreview();
}
function scheduleAutomaticTheme() {
  window.clearTimeout(state.themeTimer);
  const now = new Date(), next = new Date(now);
  if (now.getHours() < 7) next.setHours(7, 0, 0, 0);
  else if (now.getHours() < 18) next.setHours(18, 0, 0, 0);
  else { next.setDate(next.getDate() + 1); next.setHours(7, 0, 0, 0); }
  state.themeTimer = window.setTimeout(() => { applyTheme(automaticTheme()); scheduleAutomaticTheme(); }, Math.max(0, next.getTime() - now.getTime()) + 50);
}
function editorValue() { return editorView?.state.doc.toString() || ""; }
function editorSelection() {
  const selection = editorView?.state.selection.main;
  return { start: selection?.from || 0, end: selection?.to || 0 };
}
function editorHasFocus() { return Boolean(editorView?.hasFocus); }
function focusEditor() { editorView?.focus(); }
function replaceEditorSelection(text, selectionMode = "end") {
  if (!editorView) return;
  const { start, end } = editorSelection();
  const selection = selectionMode === "select"
    ? { anchor: start, head: start + text.length }
    : { anchor: start + text.length };
  editorView.dispatch({ changes: { from: start, to: end, insert: text }, selection });
}
function replaceEditorRange(from, to, insert, anchor = from, head = anchor) {
  if (!editorView) return;
  editorView.dispatch({ changes: { from, to, insert }, selection: { anchor, head }, scrollIntoView: true });
  focusEditor();
}
function toggleSelectedWrapper(open, close = open) {
  const { start, end } = editorSelection();
  if (!editorView || start === end) return;
  const doc = editorView.state.doc;
  const selected = doc.sliceString(start, end);
  const italicConflict = open === "*" && (selected.startsWith("**") || selected.endsWith("**"));
  const wrapped = !italicConflict && selected.length >= open.length + close.length && selected.startsWith(open) && selected.endsWith(close);
  const outerFrom = start - open.length;
  const outerTo = end + close.length;
  const outerItalicConflict = open === "*" && ((outerFrom > 0 && doc.sliceString(outerFrom - 1, outerFrom) === "*") || (outerTo < doc.length && doc.sliceString(outerTo, outerTo + 1) === "*"));
  const outerWrapped = !outerItalicConflict && outerFrom >= 0 && outerTo <= doc.length && doc.sliceString(outerFrom, start) === open && doc.sliceString(end, outerTo) === close;
  if (wrapped) {
    const insert = selected.slice(open.length, selected.length - close.length);
    replaceEditorRange(start, end, insert, start, start + insert.length);
  } else if (outerWrapped) {
    replaceEditorRange(outerFrom, outerTo, selected, outerFrom, outerFrom + selected.length);
  } else {
    const insert = `${open}${selected}${close}`;
    replaceEditorRange(start, end, insert, start + open.length, start + open.length + selected.length);
  }
}
function selectedLineRange() {
  if (!editorView) return null;
  const { start, end } = editorSelection();
  if (start === end) return null;
  const doc = editorView.state.doc;
  const lastPosition = end > start && doc.lineAt(end).from === end ? end - 1 : end;
  return { from: doc.lineAt(start).from, to: doc.lineAt(lastPosition).to };
}
function toggleSelectedLinePrefix(prefix, targetPattern, groupPattern = targetPattern) {
  const range = selectedLineRange();
  if (!range || !editorView) return;
  const selected = editorView.state.doc.sliceString(range.from, range.to);
  const lines = selected.split("\n");
  const contentLines = lines.filter(line => line.trim());
  const remove = contentLines.length > 0 && contentLines.every(line => targetPattern.test(line));
  const insert = lines.map(line => {
    if (!line.trim()) return line;
    return remove ? line.replace(targetPattern, "") : `${prefix}${line.replace(groupPattern, "")}`;
  }).join("\n");
  replaceEditorRange(range.from, range.to, insert, range.from, range.from + insert.length);
}
function linkSelectedText() {
  const { start, end } = editorSelection();
  if (!editorView || start === end) return;
  const selected = editorView.state.doc.sliceString(start, end);
  const insert = `[${selected}](https://)`;
  const urlStart = start + selected.length + 3;
  replaceEditorRange(start, end, insert, urlStart, urlStart + 8);
}
function codeBlockSelectedText() {
  const { start, end } = editorSelection();
  if (!editorView || start === end) return;
  const selected = editorView.state.doc.sliceString(start, end);
  const fenced = selected.startsWith("```\n") && selected.endsWith("\n```");
  const insert = fenced ? selected.slice(4, -4) : `\`\`\`\n${selected}\n\`\`\``;
  const innerStart = fenced ? start : start + 4;
  replaceEditorRange(start, end, insert, innerStart, innerStart + (fenced ? insert.length : selected.length));
}
const selectionFormatOptions = [
  { label: "一级标题", mark: "H1", action: () => toggleSelectedLinePrefix("# ", /^#\s+/, /^#{1,6}\s+/) },
  { label: "二级标题", mark: "H2", action: () => toggleSelectedLinePrefix("## ", /^##\s+/, /^#{1,6}\s+/) },
  { label: "加粗", mark: "B", action: () => toggleSelectedWrapper("**") },
  { label: "斜体", mark: "I", action: () => toggleSelectedWrapper("*") },
  { label: "删除线", mark: "S", action: () => toggleSelectedWrapper("~~") },
  { label: "行内代码", mark: "<>", action: () => toggleSelectedWrapper("`") },
  { label: "链接", mark: "↗", action: linkSelectedText },
  { label: "引用", mark: "❯", action: () => toggleSelectedLinePrefix("> ", /^>\s+/) },
  { label: "无序列表", mark: "•", action: () => toggleSelectedLinePrefix("- ", /^[-*+]\s+/, /^(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/) },
  { label: "有序列表", mark: "1.", action: () => toggleSelectedLinePrefix("1. ", /^\d+[.)]\s+/, /^(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/) },
  { label: "待办", mark: "☐", action: () => toggleSelectedLinePrefix("- [ ] ", /^[-*+]\s+\[[ xX]\]\s+/, /^(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/) },
  { label: "代码块", mark: "{ }", action: codeBlockSelectedText },
];
function closeSelectionFormatMenu() {
  selectionFormatMenu?.remove();
  selectionFormatMenu = null;
}
function positionFloatingMenu(menu, clientX, clientY) {
  const gap = 8;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(gap, Math.min(clientX, window.innerWidth - rect.width - gap))}px`;
  menu.style.top = `${Math.max(gap, Math.min(clientY, window.innerHeight - rect.height - gap))}px`;
}
function openSelectionFormatMenu(clientX, clientY) {
  closeSelectionFormatMenu();
  const menu = document.createElement("div");
  menu.className = "mdlite-format-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "快速修改 Markdown 格式");
  const title = document.createElement("div");
  title.className = "mdlite-format-title";
  title.textContent = "快速格式";
  const grid = document.createElement("div");
  grid.className = "mdlite-format-grid";
  const buttons = selectionFormatOptions.map(option => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mdlite-format-item";
    button.setAttribute("role", "menuitem");
    button.innerHTML = `<span class="mdlite-format-mark"></span><span class="mdlite-format-label"></span>`;
    button.querySelector(".mdlite-format-mark").textContent = option.mark;
    button.querySelector(".mdlite-format-label").textContent = option.label;
    button.addEventListener("mousedown", event => event.preventDefault());
    button.addEventListener("click", () => { closeSelectionFormatMenu(); focusEditor(); option.action(); });
    grid.append(button);
    return button;
  });
  const footer = document.createElement("div");
  footer.className = "mdlite-format-footer";
  const cutButton = document.createElement("button");
  cutButton.type = "button";
  cutButton.className = "mdlite-format-command";
  cutButton.setAttribute("role", "menuitem");
  cutButton.innerHTML = "<span>剪切</span><kbd>⌘ X</kbd>";
  cutButton.addEventListener("mousedown", event => event.preventDefault());
  cutButton.addEventListener("click", () => { closeSelectionFormatMenu(); focusEditor(); void cutSelection(); });
  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.className = "mdlite-format-command";
  copyButton.setAttribute("role", "menuitem");
  copyButton.innerHTML = "<span>复制</span><kbd>⌘ C</kbd>";
  copyButton.addEventListener("mousedown", event => event.preventDefault());
  copyButton.addEventListener("click", () => { closeSelectionFormatMenu(); focusEditor(); void copySelection(); });
  footer.append(cutButton, copyButton);
  menu.append(title, grid, footer);
  menu.addEventListener("keydown", event => {
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    const index = items.indexOf(document.activeElement);
    let next = null;
    if (event.key === "Escape") { event.preventDefault(); closeSelectionFormatMenu(); focusEditor(); return; }
    if (event.key === "ArrowDown") next = items[(index + 1) % items.length];
    else if (event.key === "ArrowUp") next = items[(index - 1 + items.length) % items.length];
    else if (event.key === "Home") next = items[0];
    else if (event.key === "End") next = items.at(-1);
    if (next) { event.preventDefault(); next.focus(); }
  });
  document.body.append(menu);
  selectionFormatMenu = menu;
  positionFloatingMenu(menu, clientX, clientY);
  buttons[0]?.focus({ preventScroll: true });
}
function handleEditorContextMenu(event) {
  if (!editorView || !state.current) return;
  const { start, end } = editorSelection();
  const position = editorView.posAtCoords({ x: event.clientX, y: event.clientY });
  if (start === end || position === null || position < start || position > end) { closeSelectionFormatMenu(); return; }
  event.preventDefault();
  openSelectionFormatMenu(event.clientX, event.clientY);
}
const markdownSlashOptions = [
  snippetCompletion("# ${1:标题}", { label: "/标题", detail: "一级标题", type: "keyword", boost: 100 }),
  snippetCompletion("## ${1:标题}", { label: "/二级标题", detail: "二级标题", type: "keyword" }),
  snippetCompletion("**${1:文字}**", { label: "/加粗", detail: "强调文字", type: "keyword" }),
  snippetCompletion("*${1:文字}*", { label: "/斜体", detail: "倾斜文字", type: "keyword" }),
  snippetCompletion("~~${1:文字}~~", { label: "/删除线", detail: "划掉文字", type: "keyword" }),
  snippetCompletion("[${1:链接文字}](${2:https://})", { label: "/链接", detail: "插入超链接", type: "link" }),
  snippetCompletion("![${1:图片说明}](${2:图片地址})", { label: "/图片", detail: "插入图片", type: "link" }),
  snippetCompletion("- [ ] ${1:待办事项}", { label: "/待办", detail: "任务清单", type: "keyword" }),
  snippetCompletion("- [x] ${1:已完成事项}", { label: "/已完成待办", detail: "已完成任务", type: "keyword" }),
  snippetCompletion("- ${1:列表项}", { label: "/无序列表", detail: "项目符号列表", type: "keyword" }),
  snippetCompletion("1. ${1:列表项}", { label: "/有序列表", detail: "编号列表", type: "keyword" }),
  snippetCompletion("> ${1:引用内容}", { label: "/引用", detail: "引用文字", type: "keyword" }),
  snippetCompletion("```\n${1:代码}\n```", { label: "/代码块", detail: "插入代码块", type: "keyword" }),
  snippetCompletion("| ${1:列 1} | ${2:列 2} |\n| --- | --- |\n| ${3:内容} | ${4:内容} |", { label: "/表格", detail: "两列表格", type: "keyword" }),
  snippetCompletion("---", { label: "/分割线", detail: "水平分隔线", type: "keyword" }),
  snippetCompletion("```mermaid\ngraph TD\n  A[开始] --> B[结束]\n```", { label: "/Mermaid", detail: "流程图模板", type: "keyword" }),
];
function markdownSlashCompletion(context) {
  const before = context.matchBefore(/\/[\u4e00-\u9fffA-Za-z0-9_-]*/);
  if (!before) return null;
  const line = context.state.doc.lineAt(context.pos);
  const prefix = line.text.slice(0, context.pos - line.from);
  if (!/^\s*\/[\u4e00-\u9fffA-Za-z0-9_-]*$/.test(prefix)) return null;
  return { from: before.from, options: markdownSlashOptions, validFor: /\/[\u4e00-\u9fffA-Za-z0-9_-]*/ };
}
function searchButton(label, title, action, className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `mdlite-search-button ${className}`.trim();
  button.textContent = label;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.addEventListener("click", action);
  return button;
}
class MarkdownSearchPanel {
  constructor(view) {
    this.view = view;
    this.query = getSearchQuery(view.state);
    this.dom = document.createElement("form");
    this.dom.className = "cm-search mdlite-search-panel";
    this.dom.setAttribute("aria-label", "查找和替换");

    this.searchField = document.createElement("input");
    this.searchField.type = "text";
    this.searchField.placeholder = "查找";
    this.searchField.setAttribute("main-field", "true");
    this.searchField.setAttribute("aria-label", "查找");
    this.replaceField = document.createElement("input");
    this.replaceField.type = "text";
    this.replaceField.placeholder = "替换为";
    this.replaceField.setAttribute("aria-label", "替换为");

    this.caseButton = searchButton("Aa", "区分大小写", () => this.toggle("caseSensitive"), "option");
    this.regexButton = searchButton(".*", "使用正则表达式", () => this.toggle("regexp"), "option");
    this.wordButton = searchButton("词", "全词匹配", () => this.toggle("wholeWord"), "option");
    const navigation = document.createElement("div"); navigation.className = "mdlite-search-actions";
    navigation.append(
      searchButton("↑", "上一处", () => findPrevious(this.view)),
      searchButton("↓", "下一处", () => findNext(this.view)),
      this.caseButton, this.regexButton, this.wordButton,
      searchButton("×", "关闭", () => closeSearchPanel(this.view), "close"),
    );
    const firstRow = document.createElement("div"); firstRow.className = "mdlite-search-row"; firstRow.append(this.searchField, navigation);
    const replacements = document.createElement("div"); replacements.className = "mdlite-search-row mdlite-search-replace";
    replacements.append(
      this.replaceField,
      searchButton("替换", "替换当前匹配项", () => replaceNext(this.view), "text"),
      searchButton("全部替换", "替换所有匹配项", () => replaceAll(this.view), "text primary"),
    );
    this.dom.append(firstRow, replacements);
    this.dom.addEventListener("submit", event => { event.preventDefault(); findNext(this.view); });
    this.dom.addEventListener("keydown", event => this.handleKeydown(event));
    this.searchField.addEventListener("input", () => this.commit());
    this.replaceField.addEventListener("input", () => this.commit());
    this.setQuery(this.query);
  }
  commit() {
    const query = new SearchQuery({
      search: this.searchField.value,
      replace: this.replaceField.value,
      caseSensitive: this.query.caseSensitive,
      regexp: this.query.regexp,
      wholeWord: this.query.wholeWord,
    });
    if (!query.eq(this.query)) { this.query = query; this.view.dispatch({ effects: setSearchQuery.of(query) }); }
  }
  toggle(field) {
    this.query = new SearchQuery({ ...this.query, [field]: !this.query[field] });
    this.view.dispatch({ effects: setSearchQuery.of(this.query) });
  }
  handleKeydown(event) {
    if (event.key === "Escape") { event.preventDefault(); closeSearchPanel(this.view); }
    else if (event.key === "Enter") {
      event.preventDefault();
      if (event.target === this.replaceField) replaceNext(this.view);
      else (event.shiftKey ? findPrevious : findNext)(this.view);
    }
  }
  setQuery(query) {
    this.query = query;
    this.searchField.value = query.search;
    this.replaceField.value = query.replace;
    this.caseButton.classList.toggle("active", query.caseSensitive);
    this.regexButton.classList.toggle("active", query.regexp);
    this.wordButton.classList.toggle("active", query.wholeWord);
    [this.caseButton, this.regexButton, this.wordButton].forEach(button => button.setAttribute("aria-pressed", String(button.classList.contains("active"))));
  }
  update(update) {
    for (const transaction of update.transactions) for (const effect of transaction.effects) if (effect.is(setSearchQuery) && !effect.value.eq(this.query)) this.setQuery(effect.value);
  }
  mount() { this.searchField.select(); }
  get top() { return true; }
}
function createMarkdownEditor(content = "", readOnly = true) {
  closeSelectionFormatMenu();
  editorView?.destroy();
  ui.editor.replaceChildren();
  editorView = new EditorView({
    parent: ui.editor,
    state: EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
        markdown(),
        autocompletion({ override: [markdownSlashCompletion], defaultKeymap: true }),
        search({ top: true, createPanel: view => new MarkdownSearchPanel(view) }),
        EditorState.readOnly.of(readOnly),
        EditorView.lineWrapping,
        EditorView.updateListener.of(update => {
          if (update.selectionSet) closeSelectionFormatMenu();
          if (!update.docChanged || !state.current) return;
          setDirty(true);
          void renderPreview();
        }),
      ],
    }),
  });
  editorView.contentDOM.addEventListener("paste", handleEditorPaste);
  editorView.contentDOM.addEventListener("contextmenu", handleEditorContextMenu);
}
function setEditorDocument(content, readOnly = false) { createMarkdownEditor(content, readOnly); }
function undoEditor() { if (!editorView || !undo(editorView)) setSaveState("没有可撤销的修改"); else setSaveState("已撤销", "ok"); }
function redoEditor() { if (!editorView || !redo(editorView)) setSaveState("没有可恢复的修改"); else setSaveState("已恢复撤销", "ok"); }
function normalisePath(path) { return path.replaceAll("\\", "/"); }
function fileName(path) { return normalisePath(path).split("/").pop(); }
function parentPath(path) { return normalisePath(path).split("/").slice(0, -1).join("/"); }
function relativeToRoot(path, rootPath) {
  const normalPath = normalisePath(path), normalRoot = normalisePath(rootPath || "");
  if (!normalRoot || normalPath === normalRoot) return "";
  return normalPath.startsWith(`${normalRoot}/`) ? normalPath.slice(normalRoot.length + 1) : normalPath;
}
function workspaceForPath(path) {
  const normalPath = normalisePath(path);
  let match = null;
  state.roots.forEach(workspace => {
    const rootPath = normalisePath(workspace.path);
    if ((normalPath === rootPath || normalPath.startsWith(`${rootPath}/`)) && (!match || rootPath.length > match.path.length)) match = workspace;
  });
  return match;
}
function discardWorkspace(rootPath) {
  const path = normalisePath(rootPath), workspace = state.roots.get(path);
  if (!workspace) return;
  state.roots.delete(path);
  workspace.docs.forEach((_, documentPath) => {
    if (![...state.roots.values()].some(item => item.docs.has(documentPath))) state.docs.delete(documentPath);
  });
  if (state.activeRoot === path) state.activeRoot = null;
  if (state.selectedFolder === path || state.selectedFolder?.startsWith(`${path}/`)) state.selectedFolder = null;
}
function createWorkspace(rootPath, kind) {
  const path = normalisePath(rootPath);
  discardWorkspace(path);
  const workspace = { path, kind, docs: new Map(), folders: new Map(), closedDocuments: new Set() };
  state.roots.set(path, workspace);
  return workspace;
}
function addDocument(workspace, document) {
  const path = normalisePath(document.path);
  const current = state.docs.get(path);
  const entry = current ? Object.assign(current, { ...document, path }) : { ...document, path };
  state.docs.set(path, entry); workspace.docs.set(path, entry); workspace.closedDocuments.delete(path);
  return entry;
}
function addFolder(workspace, folder) {
  const path = normalisePath(folder.path);
  workspace.folders.set(path, { ...folder, path });
}
function workspaceSessionSnapshot() {
  return {
    roots: [...state.roots.values()].map(workspace => ({ path: workspace.path, kind: workspace.kind, documents: workspace.kind === "files" ? [...workspace.docs.keys()] : [], closedDocuments: [...workspace.closedDocuments] })),
    expandedFolders: [...state.expandedFolders], activeRoot: state.activeRoot, currentPath: state.current?.path || null, selectedFolder: state.selectedFolder,
  };
}
function persistWorkspaceSession() {
  if (state.restoringSession) return;
  const session = workspaceSessionSnapshot();
  state.sessionSaveQueue = state.sessionSaveQueue.catch(() => {}).then(() => invoke("save_workspace_session", { session })).catch(error => { void reportAppError("workspace-session-save", error); });
}
async function restoreWorkspaceSession() {
  let session;
  try { session = await invoke("load_workspace_session"); }
  catch (error) { void reportAppError("workspace-session-load", error); return; }
  if (!session?.roots?.length) return;
  state.restoringSession = true;
  try {
    for (const root of session.roots) {
      if (root.kind === "folder") await openMarkdownFolder(root.path, { selectCurrent: false, remember: false });
      else if (root.kind === "files") for (const path of root.documents || []) await openMarkdownPath(path, { selectCurrent: false, remember: false });
      const workspace = state.roots.get(normalisePath(root.path));
      for (const path of root.closedDocuments || []) if (workspace?.docs.has(normalisePath(path))) removeDocumentFromWorkspace(workspace, normalisePath(path));
    }
    state.expandedFolders = new Set((session.expandedFolders || []).filter(path => workspaceForPath(path)));
    const root = session.activeRoot && state.roots.get(normalisePath(session.activeRoot));
    const current = session.currentPath && state.docs.get(normalisePath(session.currentPath));
    if (current) await selectDocument(current.path, root?.path || workspaceForPath(current.path)?.path);
    else {
      const first = [...state.docs.values()][0];
      if (first) await selectDocument(first.path, workspaceForPath(first.path)?.path);
    }
    if (session.selectedFolder && workspaceForPath(session.selectedFolder)) state.selectedFolder = normalisePath(session.selectedFolder);
    renderTree();
    if (state.roots.size) setSaveState(`已恢复 ${state.roots.size} 个文档目录`, "ok");
  } finally {
    state.restoringSession = false;
    persistWorkspaceSession();
  }
}
function openParentFolders(path, rootPath) {
  const root = normalisePath(rootPath || workspaceForPath(path)?.path || "");
  if (!root) return;
  const parts = relativeToRoot(path, root).split("/").filter(Boolean); parts.pop();
  state.expandedFolders.add(root);
  let current = root;
  parts.forEach(part => { current += `/${part}`; state.expandedFolders.add(current); });
}
function confirmDiscardChanges() {
  if (!state.dirty && !state.current?.isUntitled) return true;
  const name = state.current?.path ? fileName(state.current.path) : "未命名文档";
  return window.confirm(`${name} 尚未保存。确定要关闭并丢弃修改吗？`);
}

async function rememberRecent(kind, path) {
  if (!path) return;
  try { await invoke("remember_recent", { kind, path }); await loadRecentDocuments(); }
  catch (error) { void reportAppError("recent-history", error); }
}
function renderRecentDocuments() {
  ui.recentList.replaceChildren();
  if (!state.recentDocuments.length) {
    const empty = document.createElement("div"); empty.className = "recent-empty"; empty.textContent = "暂无最近打开的文档";
    ui.recentList.append(empty); return;
  }
  state.recentDocuments.forEach(entry => {
    const button = document.createElement("button"), name = document.createElement("span"), path = document.createElement("span");
    button.type = "button"; button.className = "recent-file"; button.title = entry.path; button.setAttribute("aria-label", `打开最近文档：${fileName(entry.path)}`);
    name.className = "recent-file-name"; name.textContent = fileName(entry.path);
    path.className = "recent-file-path"; path.textContent = parentPath(entry.path);
    button.append(name, path); button.classList.toggle("active", state.current?.path === normalisePath(entry.path));
    button.addEventListener("click", () => openMarkdownPath(entry.path)); ui.recentList.append(button);
  });
}
async function loadRecentDocuments() {
  try { state.recentDocuments = await invoke("load_recent_documents"); renderRecentDocuments(); }
  catch (error) { void reportAppError("recent-history-load", error); }
}
async function selectFolder() {
  const folderPath = await open({ directory: true, multiple: false, title: "选择 Markdown 文档目录" });
  if (!folderPath) return;
  await openMarkdownFolder(folderPath);
}
async function openMarkdownFolder(folderPath, { selectCurrent = true, remember = true } = {}) {
  if (!confirmDiscardChanges()) return;
  try {
    setSaveState("正在读取目录…");
    const workspace = await invoke("load_markdown_folder", { folderPath });
    const rootPath = normalisePath(folderPath), root = createWorkspace(rootPath, "folder");
    workspace.documents.forEach(document => addDocument(root, document));
    workspace.folders.forEach(folder => addFolder(root, folder));
    state.selectedFolder = rootPath; state.expandedFolders.add(rootPath);
    renderTree();
    const first = [...root.docs.values()][0];
    if (first && selectCurrent) await selectDocument(first.path, rootPath);
    if (remember) void rememberRecent("folder", folderPath);
    setSaveState(`已打开 ${workspace.documents.length} 个文件`, "ok");
  } catch (error) { void reportAppError("folder-open", error); setSaveState(`读取目录失败：${error}`, "error"); }
}

async function selectFile() {
  const path = await open({ multiple: false, filters: [{ name: "Markdown", extensions: ["md", "markdown"] }], title: "打开 Markdown 文件" });
  if (!path) return;
  await openMarkdownPath(path);
}

async function openMarkdownPath(path, { selectCurrent = true, remember = true } = {}) {
  if (!confirmDiscardChanges()) return;
  try {
    const document = await invoke("read_markdown_file", { path });
    const rootPath = workspaceForPath(document.path)?.path || parentPath(document.path);
    const root = state.roots.get(normalisePath(rootPath)) || createWorkspace(rootPath, "files");
    addDocument(root, document);
    state.selectedFolder = parentPath(document.path); openParentFolders(document.path, root.path);
    renderTree(); if (selectCurrent) await selectDocument(document.path, root.path); else if (remember) void rememberRecent("file", document.path); setSaveState("文件已打开", "ok");
  } catch (error) { void reportAppError("file-open", error); setSaveState(`打开失败：${error}`, "error"); }
}

async function selectDocument(path, rootPath = null, { skipDiscardConfirm = false } = {}) {
  const doc = state.docs.get(normalisePath(path));
  if (!doc) return;
  const root = rootPath ? state.roots.get(normalisePath(rootPath)) : workspaceForPath(doc.path);
  if (state.current?.path === doc.path) {
    state.activeRoot = root?.path || null;
    state.selectedFolder = parentPath(doc.path); openParentFolders(doc.path, root?.path);
    ui.currentPath.textContent = root ? relativeToRoot(doc.path, root.path) || fileName(doc.path) : doc.relativePath || fileName(doc.path);
    renderTree();
    return;
  }
  if (!skipDiscardConfirm && !confirmDiscardChanges()) return;
  state.current = doc;
  state.activeRoot = root?.path || null;
  state.selectedFolder = parentPath(doc.path); openParentFolders(doc.path, root?.path);
  setEditorDocument(doc.content);
  ui.currentPath.textContent = root ? relativeToRoot(doc.path, root.path) || fileName(doc.path) : doc.relativePath || fileName(doc.path);
  setDirty(false); renderTree(); await renderPreview();
  void rememberRecent("file", doc.path);
}

async function createUntitledDocument() {
  if (!confirmDiscardChanges()) return;
  state.current = { path: null, relativePath: "未命名.md", content: "", isUntitled: true };
  setEditorDocument("");
  ui.currentPath.textContent = "未命名.md";
  setDirty(false); renderTree(); await renderPreview();
  setSaveState("新建了未命名文档；按 ⌘S / Ctrl+S 选择保存目录", "ok");
  focusEditor();
}

function closeFolderContextMenu() {
  folderContextMenu?.remove();
  folderContextMenu = null;
}
function selectTreeFolder(path, summary) {
  state.selectedFolder = path;
  ui.fileTree.querySelectorAll(".tree-folder summary.selected").forEach(item => item.classList.remove("selected"));
  summary.classList.add("selected");
  persistWorkspaceSession();
}
function openFolderContextMenu(folderPath, clientX, clientY) {
  closeSelectionFormatMenu();
  closeFolderContextMenu();
  const menu = document.createElement("div");
  menu.className = "mdlite-folder-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", `文件夹操作：${fileName(folderPath) || folderPath}`);
  const createButton = document.createElement("button");
  createButton.type = "button";
  createButton.className = "mdlite-folder-menu-item";
  createButton.setAttribute("role", "menuitem");
  createButton.innerHTML = '<span class="mdlite-folder-menu-icon">＋</span><span>新建 Markdown 文档</span>';
  createButton.addEventListener("click", () => {
    closeFolderContextMenu();
    openCreate("file", folderPath);
  });
  menu.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    closeFolderContextMenu();
  });
  menu.append(createButton);
  document.body.append(menu);
  folderContextMenu = menu;
  positionFloatingMenu(menu, clientX, clientY);
  createButton.focus({ preventScroll: true });
}
function attachFolderInteractions(summary, folderPath) {
  summary.addEventListener("click", () => selectTreeFolder(folderPath, summary));
  summary.addEventListener("contextmenu", event => {
    event.preventDefault();
    event.stopPropagation();
    selectTreeFolder(folderPath, summary);
    openFolderContextMenu(folderPath, event.clientX, event.clientY);
  });
}
function renderTree() {
  closeFolderContextMenu();
  renderRecentDocuments();
  ui.fileTree.replaceChildren();
  const renderNode = (node, container, workspace) => {
    [...node.folders.entries()].sort(([left], [right]) => left.localeCompare(right, "zh-CN")).forEach(([name, folder]) => {
      const details = document.createElement("details"); details.className = "tree-folder"; details.open = state.expandedFolders.has(folder.path);
      const summary = document.createElement("summary"); summary.innerHTML = `<span class="folder-chevron"></span><svg class="folder-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="#8ed0f5" d="M2.5 7.3A2.3 2.3 0 0 1 4.8 5h5l1.7 2h7.7a2.3 2.3 0 0 1 2.3 2.3v8.9a2.3 2.3 0 0 1-2.3 2.3H4.8a2.3 2.3 0 0 1-2.3-2.3V7.3Z"/><path fill="#4ca9df" d="M2.5 9.3h19v8.9a2.3 2.3 0 0 1-2.3 2.3H4.8a2.3 2.3 0 0 1-2.3-2.3V9.3Z"/></svg><span class="folder-name"></span>`; summary.querySelector(".folder-name").textContent = name; summary.title = folder.path;
      if (state.selectedFolder === folder.path) summary.classList.add("selected");
      attachFolderInteractions(summary, folder.path);
      details.addEventListener("toggle", () => { if (details.open) state.expandedFolders.add(folder.path); else state.expandedFolders.delete(folder.path); persistWorkspaceSession(); });
      const children = document.createElement("div"); children.className = "tree-children"; renderNode(folder, children, workspace);
      details.append(summary, children); container.append(details);
    });
    node.files.sort((left, right) => relativeToRoot(left.path, workspace.path).localeCompare(relativeToRoot(right.path, workspace.path), "zh-CN")).forEach(doc => {
      const row = document.createElement("div"); row.className = "tree-file-row";
      const button = document.createElement("button"); button.type = "button"; button.className = "tree-file"; button.innerHTML = `<svg class="file-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="#fff" stroke="#b5becb" d="M5 2.5h9l5 5V21.5H5z"/><path fill="#dce3ec" d="M14 2.5v5h5z"/><path stroke="#5e6d80" stroke-width="1.5" stroke-linecap="round" d="M8 12h8M8 15h8M8 18h5"/></svg><span class="file-name"></span>`; button.querySelector(".file-name").textContent = fileName(doc.path); button.title = doc.path;
      if (state.current?.path === doc.path && state.activeRoot === workspace.path) { row.classList.add("active"); button.classList.add("active"); } button.addEventListener("click", () => selectDocument(doc.path, workspace.path));
      const close = document.createElement("button"); close.type = "button"; close.className = "tree-close"; close.textContent = "×"; close.title = `关闭 ${fileName(doc.path)}`; close.setAttribute("aria-label", close.title); close.addEventListener("click", event => { event.stopPropagation(); closeDocument(doc.path, workspace.path); });
      row.append(button, close); container.append(row);
    });
  };
  state.roots.forEach(workspace => {
    const root = { path: workspace.path, folders: new Map(), files: [] };
    const ensureFolder = (relativePath, absolutePath) => {
      let node = root, currentPath = workspace.path;
      relativePath.split("/").filter(Boolean).forEach(part => {
        currentPath = `${currentPath}/${part}`;
        if (!node.folders.has(part)) node.folders.set(part, { path: currentPath, folders: new Map(), files: [] });
        node = node.folders.get(part); if (absolutePath && currentPath === absolutePath) node.path = absolutePath;
      });
      return node;
    };
    workspace.folders.forEach(folder => ensureFolder(relativeToRoot(folder.path, workspace.path), folder.path));
    workspace.docs.forEach(doc => {
      const parts = relativeToRoot(doc.path, workspace.path).split("/");
      ensureFolder(parts.slice(0, -1).join("/")).files.push(doc);
    });
    const details = document.createElement("details"); details.className = "tree-folder tree-root"; details.open = state.expandedFolders.has(workspace.path);
    const summary = document.createElement("summary"); summary.innerHTML = `<span class="folder-chevron"></span><svg class="folder-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="#8ed0f5" d="M2.5 7.3A2.3 2.3 0 0 1 4.8 5h5l1.7 2h7.7a2.3 2.3 0 0 1 2.3 2.3v8.9a2.3 2.3 0 0 1-2.3 2.3H4.8a2.3 2.3 0 0 1-2.3-2.3V7.3Z"/><path fill="#4ca9df" d="M2.5 9.3h19v8.9a2.3 2.3 0 0 1-2.3 2.3H4.8a2.3 2.3 0 0 1-2.3 2.3V9.3Z"/></svg><span class="folder-name"></span>`; summary.querySelector(".folder-name").textContent = fileName(workspace.path) || workspace.path; summary.title = workspace.path;
    const close = document.createElement("button"); close.type = "button"; close.className = "tree-close"; close.textContent = "×"; close.title = `关闭 ${fileName(workspace.path) || workspace.path}`; close.setAttribute("aria-label", close.title); close.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); closeWorkspace(workspace.path); }); summary.append(close);
    if (state.selectedFolder === workspace.path) summary.classList.add("selected");
    attachFolderInteractions(summary, workspace.path);
    details.addEventListener("toggle", () => { if (details.open) state.expandedFolders.add(workspace.path); else state.expandedFolders.delete(workspace.path); persistWorkspaceSession(); });
    const children = document.createElement("div"); children.className = "tree-children"; renderNode(root, children, workspace);
    details.append(summary, children); ui.fileTree.append(details);
  });
  ui.fileCount.textContent = state.docs.size ? `(${state.docs.size})` : "";
  persistWorkspaceSession();
}

function escapeHtml(value) { return value.replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]); }
function sanitizeHtml(html) { return DOMPurify.sanitize(html, SANITIZE_CONFIG); }
function renderMarkdown(source) { return marked.parse(source); }
function prepareTaskLists(root) {
  root.querySelectorAll("input").forEach(input => {
    const isReadOnlyTask = input.matches('li > input[type="checkbox"][disabled]');
    if (!isReadOnlyTask) { input.remove(); return; }
    input.parentElement.classList.add("task-list-item");
    input.closest("ul,ol")?.classList.add("task-list");
  });
}
function processRawCells(root) {
  root.querySelectorAll("table[data-feishu-table] td, table[data-feishu-table] th").forEach(cell => {
    if (cell.innerHTML.trim()) cell.innerHTML = sanitizeHtml(renderMarkdown(cell.innerHTML));
  });
}
function prepareMermaidBlocks(root) {
  root.querySelectorAll(".mermaid-box > .mermaid").forEach(diagram => {
    const button = document.createElement("button");
    button.type = "button"; button.className = "fullscreen-chart"; button.dataset.mermaidFullscreen = ""; button.textContent = "全屏查看";
    diagram.before(button);
  });
}
function wrapTables(root) { root.querySelectorAll("table").forEach(table => { const wrap = document.createElement("div"); wrap.className = "table-wrap"; table.before(wrap); wrap.append(table); }); }
function headingId(text) {
  return text.toLowerCase().trim().replace(/[\s_]+/g, "-").replace(/[^\w\u4e00-\u9fff-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
}
function addHeadingIds(root) {
  const used = new Map();
  root.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach(heading => {
    const base = headingId(heading.textContent) || "section", index = used.get(base) || 0;
    used.set(base, index + 1); heading.id = index ? `${base}-${index}` : base;
  });
}
function renderDocumentOutline() {
  const headings = [...ui.preview.querySelectorAll("h1,h2,h3,h4,h5,h6")];
  ui.documentOutline.replaceChildren();
  if (!headings.length) {
    const empty = document.createElement("div"); empty.className = "outline-empty"; empty.textContent = "当前文档没有标题。";
    ui.documentOutline.append(empty);
    return;
  }
  const baseLevel = Math.min(...headings.map(heading => Number(heading.tagName.slice(1))));
  headings.forEach(heading => {
    const button = document.createElement("button");
    button.type = "button"; button.className = "outline-item";
    button.style.setProperty("--outline-depth", String(Math.max(0, Number(heading.tagName.slice(1)) - baseLevel)));
    button.textContent = heading.textContent.trim() || "未命名标题";
    button.title = button.textContent;
    button.addEventListener("click", () => {
      heading.scrollIntoView({ behavior: "smooth", block: "start" });
      ui.documentOutline.querySelectorAll(".outline-item.active").forEach(item => item.classList.remove("active"));
      button.classList.add("active");
    });
    ui.documentOutline.append(button);
  });
}
function setDocumentOutlineCollapsed(collapsed) {
  const pane = ui.preview.closest(".preview-pane");
  pane.classList.toggle("outline-collapsed", collapsed);
  ui.outlineToggle.innerHTML = collapsed
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 5-7 7 7 7M20 5l-7 7 7 7"/></svg>';
  ui.outlineToggle.title = collapsed ? "展开目录" : "收起目录";
  ui.outlineToggle.setAttribute("aria-label", ui.outlineToggle.title);
  ui.outlineToggle.setAttribute("aria-expanded", String(!collapsed));
}
async function hydrateLocalImages() {
  if (!state.current?.path) return;
  const images = [...ui.preview.querySelectorAll("img[src]")];
  await Promise.all(images.map(async image => {
    const source = image.getAttribute("src") || "";
    if (!source || /^(https?:|data:|blob:)/i.test(source)) return;
    try { image.src = await invoke("read_markdown_image", { markdownPath: state.current.path, source: decodeURIComponent(source) }); }
    catch { image.alt = `${image.alt || "图片"}（无法读取本地图片）`; }
  }));
}
function scrollToAnchor(hash) {
  const id = decodeURIComponent(hash.replace(/^#/, ""));
  if (!id) return false;
  const target = ui.preview.querySelector(`[id="${CSS.escape(id)}"]`);
  if (!target) { setSaveState("未找到链接对应的标题", "error"); return false; }
  target.scrollIntoView({ behavior: "smooth", block: "start" });
  return true;
}

async function renderPreview() {
  if (!state.current) return;
  ui.previewState.textContent = "渲染中…";
  ui.preview.innerHTML = sanitizeHtml(renderMarkdown(editorValue()));
  clearPreviewFindHighlights(); processRawCells(ui.preview); ui.preview.innerHTML = sanitizeHtml(ui.preview.innerHTML); prepareTaskLists(ui.preview); prepareMermaidBlocks(ui.preview); addHeadingIds(ui.preview); renderDocumentOutline(); wrapTables(ui.preview); state.previewMatch = null; await hydrateLocalImages();
  const diagrams = [...ui.preview.querySelectorAll(".mermaid")];
  if (diagrams.length) { diagrams.forEach(node => node.id = `mermaid-${++state.mermaidSequence}`); try { await mermaid.run({ nodes: diagrams }); } catch (error) { void reportAppError("mermaid-render", error); ui.previewState.textContent = "部分 Mermaid 图显示源码"; return; } }
  ui.previewState.textContent = "";
}

function showReloadConflict(diskDocument, manual) {
  state.reloadConflict = { path: normalisePath(diskDocument.path) };
  ui.reloadFileName.textContent = fileName(diskDocument.path);
  ui.reloadMessage.textContent = manual
    ? "磁盘内容与软件中的内容不同。请选择要保留的版本。"
    : `检测到磁盘文件已在其他位置修改${state.dirty ? "，软件中也有未保存的修改" : ""}。请选择要保留的版本。`;
  ui.reloadModal.hidden = false;
  document.body.classList.add("modal-open");
  ui.reloadModal.querySelector('[data-reload-action="software"]').focus();
}
function closeReloadConflict() {
  state.reloadConflict = null;
  ui.reloadModal.hidden = true;
  document.body.classList.remove("modal-open");
}
async function checkDiskVersion(manual = false) {
  const current = state.current;
  if (!current?.path) {
    if (manual) setSaveState("请先打开一个已保存的 Markdown 文件", "error");
    return !manual;
  }
  if (state.reloadConflict) return false;
  if (state.reloadCheckPromise) return state.reloadCheckPromise;
  const checkPromise = (async () => {
    try {
      const diskDocument = await invoke("read_markdown_file", { path: current.path });
      if (state.current !== current || normalisePath(diskDocument.path) !== normalisePath(current.path)) return true;
      const softwareContent = editorValue();
      if (diskDocument.content === softwareContent) {
        const changed = current.content !== diskDocument.content;
        current.content = diskDocument.content;
        if (changed) setDirty(false);
        if (manual) setSaveState("磁盘内容与软件内容一致", "ok");
        else if (changed) setSaveState("已同步磁盘中的修改", "ok");
        return true;
      }
      const changedOnDisk = current.content !== diskDocument.content;
      if (!manual && !changedOnDisk) return true;
      showReloadConflict(diskDocument, manual);
      return false;
    } catch (error) {
      void reportAppError("document-reload-check", error);
      setSaveState(`检查磁盘内容失败：${error}`, "error");
      return false;
    }
  })();
  state.reloadCheckPromise = checkPromise;
  try { return await checkPromise; }
  finally { if (state.reloadCheckPromise === checkPromise) state.reloadCheckPromise = null; }
}
async function resolveReloadConflict(action) {
  const conflict = state.reloadConflict;
  if (!conflict || normalisePath(state.current?.path || "") !== conflict.path) { closeReloadConflict(); return; }
  const buttons = [...ui.reloadModal.querySelectorAll("button")];
  buttons.forEach(button => { button.disabled = true; });
  try {
    if (action === "disk") {
      const diskDocument = await invoke("read_markdown_file", { path: conflict.path });
      if (normalisePath(state.current?.path || "") !== conflict.path) return;
      state.current.content = diskDocument.content;
      setEditorDocument(diskDocument.content); setDirty(false);
      closeReloadConflict(); await renderPreview(); setSaveState("已重新载入磁盘内容", "ok");
    } else if (action === "software") {
      const softwareContent = editorValue();
      await invoke("save_markdown_file", { path: conflict.path, content: softwareContent });
      if (normalisePath(state.current?.path || "") !== conflict.path) return;
      state.current.content = softwareContent; setDirty(false); closeReloadConflict(); setSaveState("已用软件内容覆盖磁盘文件", "ok");
    }
  } catch (error) {
    void reportAppError("document-reload-resolve", error);
    ui.reloadMessage.textContent = `处理失败：${error}`;
    setSaveState(`处理文件冲突失败：${error}`, "error");
  } finally {
    buttons.forEach(button => { button.disabled = false; });
  }
}

async function saveCurrent() {
  if (!state.current) return false;
  if (state.current.path && !state.dirty) return true;
  if (state.current.path && !await checkDiskVersion()) return false;
  try {
    setSaveState("保存中…");
    if (!state.current.path) {
      const destination = await save({ defaultPath: state.current.relativePath || "未命名.md", filters: [{ name: "Markdown", extensions: ["md", "markdown"] }], title: "保存 Markdown 文档" });
      if (!destination) { setSaveState("已取消保存", ""); return false; }
      const document = await invoke("save_markdown_file_as", { path: destination, content: editorValue() });
      const savedPath = normalisePath(document.path);
      const root = workspaceForPath(savedPath) || createWorkspace(parentPath(savedPath), "files");
      state.current = addDocument(root, document);
      state.activeRoot = root.path; state.selectedFolder = parentPath(savedPath); openParentFolders(savedPath, root.path); renderTree();
    } else {
      await invoke("save_markdown_file", { path: state.current.path, content: editorValue() });
      state.current.content = editorValue();
    }
    setDirty(false); setSaveState("已保存", "ok"); return true;
  } catch (error) { void reportAppError("document-save", error); setSaveState(`保存失败：${error}`, "error"); return false; }
}
async function closeCurrentDocument() {
  if (!state.current) return;
  if (!state.current.path) {
    if (!confirmDiscardChanges()) return;
    state.current = null; state.activeRoot = null; setDirty(false); clearDocumentView("文档已关闭"); return;
  }
  await closeDocument(state.current.path, state.activeRoot || workspaceForPath(state.current.path)?.path);
}
function removeDocumentFromWorkspace(workspace, path) {
  workspace.docs.delete(path);
  if (workspace.kind === "folder") workspace.closedDocuments.add(path);
  if (![...state.roots.values()].some(item => item.docs.has(path))) state.docs.delete(path);
  if (workspace.kind === "files" && workspace.docs.size === 0) discardWorkspace(workspace.path);
}
function firstOpenDocument() {
  for (const workspace of state.roots.values()) {
    const document = [...workspace.docs.values()][0];
    if (document) return { document, workspace };
  }
  return null;
}
function clearDocumentView(message) {
  setEditorDocument("", true); ui.currentPath.textContent = "请选择 Markdown 文件";
  ui.preview.innerHTML = '<div class="empty">预览会显示在这里。</div>'; renderDocumentOutline(); ui.previewState.textContent = ""; renderTree(); setSaveState(message, "ok");
}
async function closeDocument(path, rootPath) {
  const documentPath = normalisePath(path), workspace = rootPath && state.roots.get(normalisePath(rootPath));
  if (!workspace?.docs.has(documentPath)) return;
  const closingCurrent = state.current?.path === documentPath && state.activeRoot === workspace.path;
  if (closingCurrent && !confirmDiscardChanges()) return;
  removeDocumentFromWorkspace(workspace, documentPath);
  if (!closingCurrent) { renderTree(); setSaveState("文档已关闭", "ok"); return; }
  state.current = null; state.activeRoot = null; setDirty(false);
  const next = firstOpenDocument();
  if (next) { await selectDocument(next.document.path, next.workspace.path); setSaveState("文档已关闭", "ok"); return; }
  clearDocumentView("文档已关闭");
}
async function closeWorkspace(rootPath) {
  const path = normalisePath(rootPath), workspace = state.roots.get(path);
  if (!workspace) return;
  const closingCurrent = state.activeRoot === path;
  if (closingCurrent && !confirmDiscardChanges()) return;
  discardWorkspace(path);
  if (!closingCurrent) { renderTree(); setSaveState("文档目录已关闭", "ok"); return; }
  state.current = null; state.activeRoot = null; setDirty(false);
  const next = firstOpenDocument();
  if (next) { await selectDocument(next.document.path, next.workspace.path); setSaveState("文档目录已关闭", "ok"); return; }
  clearDocumentView("文档目录已关闭");
}

function isPreviewMode() { return ui.workspace.dataset.mode === "preview"; }
function mountFindReplace() {
  const previewContent = ui.preview.closest(".preview-content");
  previewContent.insertBefore(ui.findReplaceModal, ui.preview);
  ui.findReplaceModal.dataset.preview = "true";
  ui.findReplaceModal.setAttribute("aria-label", "预览查找");
}
function setMode(mode) {
  ui.workspace.dataset.mode = mode;
  if (!ui.findReplaceModal.hidden && mode !== "preview") closeFindReplace();
  document.querySelectorAll("[data-mode]").forEach(button => button.classList.toggle("active", button.dataset.mode === mode));
}
function openFindReplace() {
  if (!state.current) { setSaveState("请先打开一个 Markdown 文件", "error"); return; }
  if (!isPreviewMode()) {
    openSearchPanel(editorView);
    return;
  }
  mountFindReplace();
  ui.findReplaceModal.hidden = false;
  ui.findText.focus();
  ui.findText.select();
  updateFindStatus();
}
function closeFindReplace() { clearPreviewFindHighlights(); ui.findReplaceModal.hidden = true; }
function openCreate(kind, targetFolder = state.selectedFolder) {
  const parentPath = targetFolder && normalisePath(targetFolder);
  const workspace = parentPath && workspaceForPath(parentPath);
  if (!workspace || !parentPath) { setSaveState("请先打开一个 Markdown 文档目录", "error"); return; }
  closeFolderContextMenu();
  state.selectedFolder = parentPath;
  state.createKind = kind;
  ui.createTitle.textContent = kind === "file" ? "新建 Markdown 文档" : "新建文件夹";
  ui.createName.placeholder = kind === "file" ? "例如：接口说明" : "例如：接口文档";
  const relative = relativeToRoot(parentPath, workspace.path); ui.createTarget.textContent = `将在 ${relative ? relative : "当前文档根目录"} 中创建。`;
  ui.createName.value = ""; ui.createModal.hidden = false; ui.createName.focus();
}
function closeCreate() { ui.createModal.hidden = true; state.createKind = null; }
async function createEntry() {
  const name = ui.createName.value.trim(), parentPath = state.selectedFolder;
  if (!name || !state.createKind || !parentPath) return;
  if (state.createKind === "file" && !confirmDiscardChanges()) return;
  try {
    const workspace = workspaceForPath(parentPath);
    if (!workspace) throw new Error("未找到创建位置所属的文档目录");
    if (state.createKind === "folder") {
      const folder = await invoke("create_markdown_folder", { parentPath, name });
      const path = normalisePath(folder.path); addFolder(workspace, folder); state.expandedFolders.add(parentPath); state.selectedFolder = path; renderTree(); setSaveState("文件夹已创建", "ok");
    } else {
      const document = addDocument(workspace, await invoke("create_markdown_file", { parentPath, name }));
      state.expandedFolders.add(parentPath); openParentFolders(document.path, workspace.path);
      closeCreate();
      await selectDocument(document.path, workspace.path, { skipDiscardConfirm: true });
      setSaveState("Markdown 文档已创建", "ok");
      return;
    }
    closeCreate();
  } catch (error) { void reportAppError("create-entry", error); ui.createTarget.textContent = `创建失败：${error}`; }
}
function findOccurrences(source, text) {
  if (!text) return 0;
  let count = 0, position = 0;
  while ((position = source.indexOf(text, position)) !== -1) { count += 1; position += text.length; }
  return count;
}
function updateFindStatus(message = "") {
  const query = ui.findText.value, content = ui.preview.textContent;
  ui.findStatus.textContent = message || (query ? `预览中找到 ${findOccurrences(content, query)} 处（区分大小写）。` : "在预览中查找（区分大小写）。");
}
function previewTextEntries() {
  const walker = document.createTreeWalker(ui.preview, NodeFilter.SHOW_TEXT), entries = [];
  let node, offset = 0;
  while ((node = walker.nextNode())) {
    if (!node.nodeValue || node.parentElement?.closest("script,style")) continue;
    entries.push({ node, start: offset, end: offset + node.nodeValue.length }); offset += node.nodeValue.length;
  }
  return { entries, content: entries.map(entry => entry.node.nodeValue).join("") };
}
function previewTextPoint(entries, index, preferPrevious = false) {
  const entry = entries.find(item => preferPrevious ? index > item.start && index <= item.end : index >= item.start && index < item.end) || entries.at(-1);
  return [entry.node, Math.max(0, Math.min(entry.node.nodeValue.length, index - entry.start))];
}
function clearPreviewFindHighlights() {
  if (!CSS.highlights) return;
  CSS.highlights.delete("mdlite-find"); CSS.highlights.delete("mdlite-find-current");
}
function previewRange(entries, start, end) {
  const [startNode, startOffset] = previewTextPoint(entries, start);
  const [endNode, endOffset] = previewTextPoint(entries, end, true);
  const range = document.createRange(); range.setStart(startNode, startOffset); range.setEnd(endNode, endOffset); return range;
}
function highlightPreviewMatches(entries, content, query, activeRange) {
  if (!CSS.highlights || typeof Highlight === "undefined") return false;
  const ranges = []; let index = 0;
  while ((index = content.indexOf(query, index)) !== -1) { ranges.push(previewRange(entries, index, index + query.length)); index += query.length; }
  CSS.highlights.set("mdlite-find", new Highlight(...ranges));
  CSS.highlights.set("mdlite-find-current", new Highlight(activeRange));
  return true;
}
function findFocusTarget() {
  if (document.activeElement === ui.findText || document.activeElement === ui.replaceText) return document.activeElement;
  return ui.findReplaceModal.contains(document.activeElement) ? ui.findText : null;
}
function findPreviewMatch(direction = 1) {
  const query = ui.findText.value;
  if (!query) { updateFindStatus("请输入要查找的文字。"); return false; }
  const { entries, content } = previewTextEntries();
  if (!entries.length) { updateFindStatus("预览中没有可查找的文字。"); return false; }
  const activeInput = findFocusTarget();
  const current = state.previewMatch?.query === query ? state.previewMatch.index : direction > 0 ? -query.length : content.length;
  const anchor = direction > 0 ? Math.max(0, current + query.length) : current - 1;
  let position = direction > 0 ? content.indexOf(query, anchor) : (anchor < 0 ? -1 : content.lastIndexOf(query, anchor));
  const wrapped = position === -1;
  if (wrapped) position = direction > 0 ? content.indexOf(query) : content.lastIndexOf(query);
  if (position === -1) { updateFindStatus("预览中没有匹配内容。"); return false; }
  const range = previewRange(entries, position, position + query.length), selection = window.getSelection();
  selection.removeAllRanges(); if (!highlightPreviewMatches(entries, content, query, range)) selection.addRange(range);
  range.startContainer.parentElement?.scrollIntoView({ behavior: "smooth", block: "center" });
  state.previewMatch = { query, index: position };
  updateFindStatus(`${wrapped ? "已回到" : "定位到"}预览第 ${findOccurrences(content.slice(0, position + query.length), query)} / ${findOccurrences(content, query)} 处。`);
  activeInput?.focus();
  return true;
}
function findMatch(direction = 1) {
  return findPreviewMatch(direction);
}
function imageFile(file) { return file && (file.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(file.name)); }
function readAsDataUrl(file) {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
}
async function reportImageError(category, error) {
  return reportAppError(category, error);
}
async function insertImage(file) {
  if (!state.current?.path || !imageFile(file)) { setSaveState("请先保存当前文档，再插入图片", "error"); return; }
  try {
    setSaveState("正在保存图片…");
    const relativePath = await invoke("save_markdown_image", { markdownPath: state.current.path, imageData: await readAsDataUrl(file) });
    insertImageMarkdown(relativePath, file.name || "粘贴图片"); setSaveState("图片已保存到 images/", "ok");
  } catch (error) { const logPath = await reportImageError("image-save", error); setSaveState(`图片保存失败：${error}${logPath ? `（日志：${logPath}）` : ""}`, "error"); }
}
async function insertImages(files) { for (const file of files) await insertImage(file); }
async function selectImages() {
  if (!state.current?.path) { setSaveState("请先保存当前文档，再插入图片", "error"); return; }
  const paths = await open({ multiple: true, filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"] }], title: "插入图片" });
  if (!paths) return;
  for (const path of Array.isArray(paths) ? paths : [paths]) await importImagePath(path);
}
function insertImageMarkdown(relativePath, name) {
  const alt = name.replace(/\.[^.]+$/, "").replace(/[\[\]\\]/g, "") || "图片";
  const { start, end } = editorSelection(), value = editorValue();
  const before = start && !value.slice(0, start).endsWith("\n") ? "\n" : "";
  const after = end < value.length && !value.slice(end).startsWith("\n") ? "\n" : "";
  replaceEditorSelection(`${before}![${alt}](${encodeURI(relativePath).replace(/#/g, "%23")})${after}`);
}
async function importImagePath(sourcePath) {
  if (!state.current?.path || !/\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(sourcePath)) return;
  try {
    setSaveState("正在导入图片…");
    const relativePath = await invoke("import_markdown_image", { markdownPath: state.current.path, sourcePath });
    insertImageMarkdown(relativePath, fileName(sourcePath)); setSaveState("图片已保存到 images/", "ok");
  } catch (error) { const logPath = await reportImageError("image-import", error); setSaveState(`图片导入失败：${error}${logPath ? `（日志：${logPath}）` : ""}`, "error"); }
}
async function pasteClipboardContent(fallbackText = "") {
  if (!state.current?.path) {
    void reportAppError("clipboard-paste-precondition", "尝试粘贴内容时当前文档尚未保存");
    if (fallbackText) { insertPlainText(fallbackText); return; }
    setSaveState("请先保存当前文档，再粘贴内容", "error"); return;
  }
  try {
    setSaveState("正在读取剪贴板…");
    const clipboard = await invoke("paste_markdown_clipboard", { markdownPath: state.current.path });
    if (clipboard.kind === "text") { insertPlainText(clipboard.content); setSaveState("已粘贴文字", "ok"); return; }
    insertImageMarkdown(clipboard.content, "粘贴图片.png"); setSaveState("图片已保存到 images/", "ok");
  }
  catch (error) {
    if (fallbackText) { insertPlainText(fallbackText); return; }
    const logPath = await reportImageError("clipboard-paste", error);
    setSaveState(`未能读取剪贴板内容：${error}${logPath ? `（日志：${logPath}）` : ""}`, "error");
  }
}
function insertPlainText(text) {
  if (!text) return;
  replaceEditorSelection(text);
}
async function copySelection() {
  const { start, end } = editorSelection();
  const editorText = editorValue().slice(start, end);
  const previewText = window.getSelection?.().toString() || "";
  const text = editorHasFocus() ? editorText : previewText;
  if (!text) { setSaveState("请先选中要复制的内容", "error"); return; }
  try { await invoke("copy_markdown_text", { text }); setSaveState("已复制选中内容", "ok"); }
  catch (error) { void reportAppError("copy-selection", error); setSaveState(`复制失败：${error}`, "error"); }
}
async function cutSelection() {
  if (!editorView || !state.current) { setSaveState("请先打开要编辑的文档", "error"); return; }
  const { start, end } = editorSelection();
  const text = editorValue().slice(start, end);
  if (!text) { setSaveState("请先选中要剪切的内容", "error"); return; }
  try {
    await invoke("copy_markdown_text", { text });
    replaceEditorRange(start, end, "", start);
    setSaveState("已剪切选中内容", "ok");
  } catch (error) {
    void reportAppError("cut-selection", error);
    setSaveState(`剪切失败：${error}`, "error");
  }
}

function openFullscreen(box) {
  const diagram = box?.querySelector(".mermaid"), svg = diagram?.querySelector("svg"); if (!diagram || !svg) return;
  const viewBox = (svg.getAttribute("viewBox") || "").split(/[ ,]+/).map(Number), width = viewBox[2] || Number(svg.getAttribute("width")), height = viewBox[3] || Number(svg.getAttribute("height"));
  if (!width || !height) return;
  state.fullscreen = { diagram, parent: diagram.parentNode, next: diagram.nextSibling, width, height, zoom: 1 };
  ui.modalCanvas.append(diagram); ui.mermaidModal.hidden = false; document.body.classList.add("modal-open"); applyFullscreenZoom(1);
}
function applyFullscreenZoom(next, clientX = null, clientY = null) {
  if (!state.fullscreen) return; const zoom = Math.max(.5, Math.min(4, next)), svg = ui.modalCanvas.querySelector("svg");
  const diagram = ui.modalCanvas.querySelector(".mermaid"), previousZoom = state.fullscreen.zoom, previousBounds = diagram?.getBoundingClientRect();
  const localX = previousBounds && clientX !== null ? (clientX - previousBounds.left) / previousZoom : null;
  const localY = previousBounds && clientY !== null ? (clientY - previousBounds.top) / previousZoom : null;
  state.fullscreen.zoom = zoom; svg.style.maxWidth = "none"; svg.style.width = `${Math.round(state.fullscreen.width * zoom)}px`; svg.style.height = `${Math.round(state.fullscreen.height * zoom)}px`; ui.modalZoom.textContent = `${Math.round(zoom * 100)}%`;
  if (localX === null || localY === null) return;
  window.requestAnimationFrame(() => {
    if (!state.fullscreen || state.fullscreen.zoom !== zoom || !diagram) return;
    const bounds = diagram.getBoundingClientRect();
    ui.modalCanvas.scrollLeft += bounds.left + localX * zoom - clientX;
    ui.modalCanvas.scrollTop += bounds.top + localY * zoom - clientY;
  });
}
function closeFullscreen() { if (!state.fullscreen) return; const { diagram, parent, next } = state.fullscreen; parent.insertBefore(diagram, next); state.fullscreen = null; ui.modalCanvas.classList.remove("panning"); ui.mermaidModal.hidden = true; document.body.classList.remove("modal-open"); }

ui.outlineToggle.addEventListener("click", () => setDocumentOutlineCollapsed(!ui.preview.closest(".preview-pane").classList.contains("outline-collapsed")));
ui.themeToggle.addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
function handleEditorPaste(event) {
  state.pasteShortcutToken = null;
  const files = [...(event.clipboardData?.files || [])].filter(imageFile);
  if (!files.length) files.push(...[...(event.clipboardData?.items || [])].filter(item => item.kind === "file" && item.type.startsWith("image/")).map(item => item.getAsFile()).filter(imageFile));
  const text = event.clipboardData?.getData("text/plain") || "";
  const html = event.clipboardData?.getData("text/html") || "";
  const clipboardTypes = [...(event.clipboardData?.types || [])];
  const shouldTryImage = files.length || clipboardTypes.some(type => type.startsWith("image/")) || /<img\b/i.test(html) || !text;
  event.preventDefault();
  if (shouldTryImage) {
    void reportAppError("clipboard-paste-event", clipboardDescription(event, files, text, html));
    if (files.length) { insertImages(files); return; }
    pasteClipboardContent(text); return;
  }
  if (text) { insertPlainText(text); return; }
}
function queuePasteShortcutFallback() {
  const token = Symbol("paste-shortcut");
  state.pasteShortcutToken = token;
  window.setTimeout(() => {
    if (state.pasteShortcutToken !== token || !editorHasFocus()) return;
    state.pasteShortcutToken = null;
    void reportAppError("clipboard-shortcut-fallback", "⌘V / Ctrl+V 未触发 WebView paste 事件，改用原生剪贴板读取");
    pasteClipboardContent();
  }, 180);
}
createMarkdownEditor();
getCurrentWindow().onDragDropEvent(event => {
  const pane = ui.editor.closest(".editor-pane");
  if (event.payload.type === "enter" || event.payload.type === "over") pane.classList.add("dragging");
  else if (event.payload.type === "leave") pane.classList.remove("dragging");
  else if (event.payload.type === "drop") {
    pane.classList.remove("dragging"); const paths = event.payload.paths.filter(path => /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(path));
    if (paths.length) paths.forEach(importImagePath); else { reportImageError("image-drop", "拖入内容不是支持的图片格式"); setSaveState("请拖入 PNG、JPEG、GIF、WebP、SVG 或 BMP 图片", "error"); }
  }
});
ui.preview.addEventListener("click", event => {
  const chart = event.target.closest("[data-mermaid-fullscreen]");
  if (chart) { openFullscreen(chart.closest(".mermaid-box")); return; }
  const link = event.target.closest("a[href]");
  if (!link || !state.current) return;
  const href = link.getAttribute("href") || "";
  if (/^(https?:|mailto:|tel:)/i.test(href)) return;
  if (href.startsWith("#")) { event.preventDefault(); scrollToAnchor(href); return; }
  const workspace = state.activeRoot ? state.roots.get(state.activeRoot) : workspaceForPath(state.current.path);
  const currentRelativePath = workspace ? relativeToRoot(state.current.path, workspace.path) : state.current.relativePath || fileName(state.current.path);
  const targetUrl = new URL(href, `https://local-preview/${currentRelativePath}`);
  const targetPath = decodeURIComponent(targetUrl.pathname.slice(1));
  if (!/\.(md|markdown)$/i.test(targetPath)) return;
  event.preventDefault();
  const target = workspace && [...workspace.docs.values()].find(doc => relativeToRoot(doc.path, workspace.path) === targetPath);
  if (target) selectDocument(target.path, workspace.path).then(() => { if (targetUrl.hash) scrollToAnchor(targetUrl.hash); });
  else setSaveState("未在当前目录中找到链接的 Markdown 文件", "error");
});
ui.mermaidModal.addEventListener("click", event => { const action = event.target.dataset.modalAction; if (event.target === ui.mermaidModal || action === "close") closeFullscreen(); else if (action === "in") applyFullscreenZoom(state.fullscreen.zoom + .25); else if (action === "out") applyFullscreenZoom(state.fullscreen.zoom - .25); });
ui.modalCanvas.addEventListener("wheel", event => {
  if (!state.fullscreen || !event.deltaY) return;
  event.preventDefault();
  const step = Math.min(.25, Math.max(.05, Math.abs(event.deltaY) * .002));
  applyFullscreenZoom(state.fullscreen.zoom + (event.deltaY < 0 ? step : -step), event.clientX, event.clientY);
}, { passive: false });
ui.modalCanvas.addEventListener("dblclick", () => applyFullscreenZoom(1));
ui.modalCanvas.addEventListener("pointerdown", event => {
  if (!state.fullscreen || event.button !== 0) return;
  state.fullscreen.pan = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, scrollLeft: ui.modalCanvas.scrollLeft, scrollTop: ui.modalCanvas.scrollTop };
  ui.modalCanvas.setPointerCapture(event.pointerId); ui.modalCanvas.classList.add("panning"); event.preventDefault();
});
ui.modalCanvas.addEventListener("pointermove", event => {
  const pan = state.fullscreen?.pan;
  if (!pan || pan.pointerId !== event.pointerId) return;
  ui.modalCanvas.scrollLeft = pan.scrollLeft - (event.clientX - pan.clientX);
  ui.modalCanvas.scrollTop = pan.scrollTop - (event.clientY - pan.clientY);
});
function stopFullscreenPan(event) {
  const pan = state.fullscreen?.pan;
  if (!pan || pan.pointerId !== event.pointerId) return;
  if (ui.modalCanvas.hasPointerCapture(event.pointerId)) ui.modalCanvas.releasePointerCapture(event.pointerId);
  delete state.fullscreen.pan; ui.modalCanvas.classList.remove("panning");
}
ui.modalCanvas.addEventListener("pointerup", stopFullscreenPan);
ui.modalCanvas.addEventListener("pointercancel", stopFullscreenPan);
ui.findReplaceModal.addEventListener("click", event => {
  const action = event.target.dataset.findAction;
  if (action === "close") closeFindReplace();
  else if (action === "next") { findMatch(1); ui.findText.focus(); }
  else if (action === "previous") { findMatch(-1); ui.findText.focus(); }
});
ui.createModal.addEventListener("click", event => { const action = event.target.dataset.createAction; if (event.target === ui.createModal || action === "close") closeCreate(); else if (action === "confirm") createEntry(); });
ui.reloadModal.addEventListener("click", event => { const action = event.target.dataset.reloadAction; if (action) resolveReloadConflict(action); });
ui.createName.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); createEntry(); } });
ui.findText.addEventListener("input", () => { clearPreviewFindHighlights(); state.previewMatch = null; updateFindStatus(); });
async function pasteIntoFindInput(input) {
  try {
    const text = await invoke("read_clipboard_text");
    if (!text) return;
    input.setRangeText(text, input.selectionStart, input.selectionEnd, "end");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  } catch (error) { void reportAppError("find-paste", error); updateFindStatus(`无法粘贴：${error}`); }
}
function queueFindPasteFallback(input) {
  const token = Symbol("find-paste");
  state.findPasteToken = token;
  window.setTimeout(() => {
    if (state.findPasteToken !== token || document.activeElement !== input) return;
    state.findPasteToken = null;
    pasteIntoFindInput(input);
  }, 180);
}
function isImeComposing(event) { return event.isComposing || event.key === "Process" || event.keyCode === 229; }
function handleFindInputKeydown(event, input) {
  if (isImeComposing(event)) return;
  const shortcut = event.metaKey || event.ctrlKey;
  if (shortcut && event.key.toLowerCase() === "v") queueFindPasteFallback(input);
  if (event.key === "ArrowDown") { event.preventDefault(); findMatch(1); }
  if (event.key === "ArrowUp") { event.preventDefault(); findMatch(-1); }
}
[ui.findText, ui.replaceText].forEach(input => input.addEventListener("paste", () => { state.findPasteToken = null; }));
ui.findText.addEventListener("keydown", event => { if (isImeComposing(event)) return; handleFindInputKeydown(event, ui.findText); if (event.key === "Enter") { event.preventDefault(); findMatch(event.shiftKey ? -1 : 1); } });
ui.replaceText.addEventListener("keydown", event => { if (isImeComposing(event)) return; handleFindInputKeydown(event, ui.replaceText); });
document.querySelectorAll("[data-mode]").forEach(button => button.addEventListener("click", () => setMode(button.dataset.mode)));
document.addEventListener("pointerdown", event => {
  if (selectionFormatMenu && !selectionFormatMenu.contains(event.target)) closeSelectionFormatMenu();
  if (folderContextMenu && !folderContextMenu.contains(event.target)) closeFolderContextMenu();
});
document.addEventListener("scroll", () => { closeSelectionFormatMenu(); closeFolderContextMenu(); }, true);
window.addEventListener("blur", () => { closeSelectionFormatMenu(); closeFolderContextMenu(); });
window.addEventListener("resize", () => { closeSelectionFormatMenu(); closeFolderContextMenu(); });
listen("menu-action", event => {
  if (state.reloadConflict) return;
  switch (event.payload) {
    case "open-folder": selectFolder(); break;
    case "open-file": selectFile(); break;
    case "close-document": closeCurrentDocument(); break;
    case "insert-image": selectImages(); break;
    case "paste-image": pasteClipboardContent(); break;
    case "cut-selection": cutSelection(); break;
    case "copy-selection": copySelection(); break;
    case "undo": undoEditor(); break;
    case "redo": redoEditor(); break;
    case "new-markdown": state.selectedFolder ? openCreate("file") : createUntitledDocument(); break;
    case "new-folder": openCreate("folder"); break;
    case "save": saveCurrent(); break;
    case "reload": checkDiskVersion(true); break;
    case "find-replace": openFindReplace(); break;
    case "about": window.alert(`${APP_NAME}\nv${APP_VERSION}`); break;
    case "mode-edit": setMode("edit"); break;
    case "mode-split": setMode("split"); break;
    case "mode-preview": setMode("preview"); break;
  }
});
getCurrentWindow().onFocusChanged(event => { if (event.payload) checkDiskVersion(); }).catch(error => { void reportAppError("focus-listener", error); });
listen("open-markdown-file", event => { openMarkdownPath(event.payload); });
listen("open-recent-item", event => {
  if (event.payload?.kind === "folder") openMarkdownFolder(event.payload.path);
  else if (event.payload?.kind === "file") openMarkdownPath(event.payload.path);
});
document.addEventListener("keydown", event => {
  const shortcut = event.metaKey || event.ctrlKey, key = event.key.toLowerCase();
  if (isImeComposing(event)) return;
  if (state.reloadConflict && shortcut) { event.preventDefault(); return; }
  if (event.key === "Escape") { if (!ui.findReplaceModal.hidden) closeFindReplace(); else closeFullscreen(); }
  if (shortcut && key === "v" && editorHasFocus()) queuePasteShortcutFallback();
  if (shortcut && key === "s") { event.preventDefault(); saveCurrent(); }
  if (shortcut && (key === "f" || key === "h") && isPreviewMode()) { event.preventDefault(); openFindReplace(); }
});
applyTheme(automaticTheme());
scheduleAutomaticTheme();
void loadRecentDocuments();
void restoreWorkspaceSession();
