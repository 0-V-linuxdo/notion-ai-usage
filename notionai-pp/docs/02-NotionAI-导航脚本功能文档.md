# [NotionAI] Notion 风格的导航目录 功能文档

> 对象：`0-V-linuxdo/Notion-style-AI-Navigator` 仓库 `Site_JS/[NotionAI] Notion 风格的导航目录.user.js`（`[20261004] v1.0.1`，376 行）及其依赖的核心库 `core/ai-navigator-core.js`（`NotionStyleNavigator` v1.0.1，1284 行）。
> 用途：NotionAI++ 净室重写的行为规格。编号 `N-x.y` 供逐条验收。

注意：站点脚本的 `@require` 指向 `…/raw/refs/heads/0-V-linuxdo-patch-1/notion-style-ai-navigator2.js`，该文件不在 `main` 分支；本文按 `main` 上的 `core/ai-navigator-core.js`（同一 `PromptNavigator` API）描述核心行为。核心是外部 URL 依赖，网络不可达时整个导航不会出现，这是一处可靠性风险。

---

## 1. 定位与运行环境

| 项 | 规格 |
| --- | --- |
| 作用 | 在 Notion AI 对话页右侧加悬浮目录，在「用户提问」与「AI 回复」之间跳转 |
| 匹配 | `notion.so`、`www.notion.so`、`*.notion.so`、`app.notion.com`（`@match` + `@include` 正则） |
| 启用路由 | 仅 pathname 匹配 `^/(ai|chat)(/|$)`；其它路由清空标记、目录为空 |
| 授权 | `GM_registerMenuCommand`、`GM_getValue`、`GM_setValue`；默认隔离世界运行，无 `@run-at`（document-end） |
| 依赖 | `@require` 核心库，轮询 100ms 直到 `window.NotionStyleNavigator` 可用 |

---

## 2. 消息识别（站点适配层）

### N-1 标记方式

脚本不直接把元素交给核心，而是给识别出的消息元素打属性，核心再用选择器取：

- `role="article"`（原本没有 role 时附加 `data-nsan-role-set="1"`，清理时还原）
- `data-author="user" | "assistant"`
- `data-nsan-article="1"`、`data-nsan-owner="nsan"`
- 核心选择器：`[data-nsan-owner='nsan'][data-nsan-article='1']`

每次扫描先清空全部旧标记再重标（N-1.1）。不在 `nav, aside, header, footer, form, [role=textbox], [contenteditable=true]` 内，不标 `body` 与 `#notion-app`（N-1.2）。

### N-2 识别规则（按顺序）

- N-2.1 页面根：可见的 `#notion-app / main / [role=main]` 中第一个不在 nav/aside/header/footer 内的，否则 body。
- N-2.2 若存在 `[data-message-author-role]`（且其内无按钮）：`user/human` → user，`assistant` → assistant。
- N-2.3 主路径「复制按钮定位」：遍历根内所有 `button, [role=button]`（排除 nav/aside/header/footer/form/pre/code/kbd 内的），用 aria-label + title + data-testid + class + 文本判断：
  - 匹配 `copy (response|answer)` / `复制(回复|回答|响应)` → 助手；
  - 匹配 `copy (text|message|prompt)` / `复制(文本|消息|提示词|问题)` → 用户。
- N-2.4 用户气泡：从按钮向上最多 8 层，每层看 **前一个兄弟元素**：不在 chrome 内、不包含按钮、文本 ≥2、高度 16 ~ 0.9×视口、不是日期行 / steps 行 / chrome 行 → 即为提问气泡（复制按钮位于日期行之后）。
- N-2.5 助手正文：从按钮向上最多 10 层，找到高度 ≥36 且子元素 ≥2 的祖先；取其中不含按钮的子元素作为内容，再取内容直接子元素里「文本 ≥8、高 ≥24、非 steps/日期/chrome」的 **最后一个**；若它内部还含复制按钮则继续上找。即跳过 `N steps / Thought` 折叠块，只取最终正文。
- N-2.6 噪声行正则（用于文本清洗与摘要）：
  - chrome：`Notion AI`、`New agent`、`Share chat`、`Start new chat`、`Pin chat`、`Give context`、`Settings`、`Ask anything`、`Do anything with AI…`、`Copied to clipboard`、`Undo`、`Show changes`、`Submit AI message` 等；
  - 日期：`Today/Yesterday`、`Oct 7, 2026 at 3:03 AM`、`3:03 AM`、`2026-10-07 12:00`、`10月7日`、`今天/昨天`；
  - steps / 思考：`N steps`、`Thought for …`、`思考…`；
  - research 过程：`noodling`、`contemplating`、`Found N results`、`Searched the web`、`Loaded … skill`、`Loading web page:` 等。
- N-2.7 去重：同作者且清洗后前 160 字符相同的只保留第一个；嵌套标记只保留最外层。

### N-3 扫描触发

- N-3.1 `MutationObserver(documentElement, childList+subtree)`，180ms 防抖重扫。
- N-3.2 SPA：包装 `history.pushState / replaceState`，监听 `popstate`，触发重扫。
- N-3.3 核心每次 `queryMessages()` 前强制同步 `scan()`。

---

## 3. 目录 UI（核心库）

### N-4 结构与位置

- 容器 `#prompt-nav-container`：`position:fixed; top:10rem; right:1.25rem; z-index:9999`（≤640px 宽时 `top:5rem; right:.5rem`），挂在 body。
- 指示器 `#prompt-nav-indicator`：每条消息一条 1.25rem×2px 横线（间距 1rem），当前项变长到 1.75rem 并发光；最大高度 `100vh - 12rem`，超出时整列平移使当前项居中。
- 菜单 `#prompt-nav-menu`：宽 18rem，圆角 .75rem，阴影；默认透明隐藏，**鼠标悬停容器**时淡入并从右侧滑入，同时指示器隐藏。
- 每项：`❓`（用户）/ `🤖`（助手）emoji + 摘要（清洗后合并成一行，超过 60 字符截断加 `...`），单行省略。当前项加粗高亮。
- 主题：html/body 的 `dark`/`theme-dark` class 或 `data-theme=dark`，或系统暗色 → 暗色变量；监听 class/data-theme 与媒体查询变化。

### N-5 行为

- N-5.1 构建：消息列表变化（数量或任一元素引用不同）才整体重建，否则只更新高亮；500ms 防抖；初始化延迟（站点设为 1200ms）。
- N-5.2 高亮：滚动（capture，100ms 节流）时，取 **顶部 < 0.4×视口高** 的最后一条为当前项；都不满足时高亮第一项。
- N-5.3 点击跳转：找到消息的可滚动祖先（overflow-y auto/scroll，否则 documentElement），平滑滚动使目标顶部距容器顶部 30px；滚动结束 150ms 后施加定位效果。
- N-5.4 站点覆盖：跳转与高亮目标优先取消息内第一个可见的 `.markdown` / `[class*=message]` 子元素。
- N-5.5 定位效果（`GM_setValue('prompt-nav-effect-mode')`，默认 `border`）：
  - `none` 仅滚动；`border` 金色 2px outline + 扩散环 2s；`pulse` 蓝色脉冲 2s；`fade` 背景淡入淡出 1.5s；`jiggle` 水平抖动 400ms。
- N-5.6 设置：油猴菜单「⚙️ 导航效果设置」打开模态框（单选 + 预览按钮，选择即保存；点遮罩或 Esc 关闭；预览 2.5s 或按下指针结束）。

---

## 4. 已知问题（重写需改进）

| 问题 | 说明 |
| --- | --- |
| 依赖外部 `@require` | 指向非 main 分支文件；不可达时完全失效 |
| 识别依赖复制按钮文案 | 英文/中文 aria-label 一变即失效；当前 DOM 已有稳定属性 `data-agent-chat-user-step-id`（用户回合）可直接使用 |
| 每次 query 都清空并重打标记 | 打标记本身触发 MutationObserver，频繁重扫；在 Notion 元素上写 `role=article` 改变了无障碍语义 |
| 全局 `history` 补丁 | 每个脚本各包一层，且不释放 |
| 只看 `/ai`、`/chat` | 符合预期，但目录在路由离开时仅清空，不隐藏容器样式 |
| 目录对流式回复 | 回复中途正文元素会替换，导致整表频繁重建 |

## 5. Tabbit 实测（2026-10-07，`app.notion.com/chat?t=…`）

- 对话容器：一个纵向列，子元素依次为「用户回合」「助手回合」交替。
- 用户回合：`div[data-agent-chat-user-step-id=<uuid>]` → 气泡（内含 `contenteditable=false` 的 `[data-content-editable-leaf]`）+ 元信息行（时间戳 + `aria-label="Copy text"` 按钮）。
- 助手回合：用户回合的下一个兄弟；内部为若干 `role=button aria-expanded` 的「N steps」折叠条、可选的中间说明，以及最后的正文列；底部动作行含 `aria-label="Copy response"`、`Save to private pages`。
- 输入框：`[data-notion-chat-input-container=true]` 容器内，`div[role=textbox][contenteditable=true][placeholder="Do anything with AI…"]`；可视外框是其祖先中 `border-radius:16px`、有背景与描边阴影的元素。
