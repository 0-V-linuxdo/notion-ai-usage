# [Notion AI] Usage 脚本功能文档

> 对象：`0-V-linuxdo/notion-ai-usage` 仓库 `main` 分支 `notion-ai-usage.user.js`，版本 `[20260731] v1.1.3`（机器版本 `20260731.1.1.3`，4332 行，无依赖）。
> 用途：作为 NotionAI++ 净室重写的「行为规格」。本文只描述 **做什么、何时做、边界条件**，不复制实现。编号 `U-x.y` 供重写时逐条对照验收。

---

## 1. 定位与运行环境

| 项 | 规格 |
| --- | --- |
| 作用 | 在 Notion 网页显示 Notion AI 两段用量（滚动 6h/24h 窗口、月度账单窗口）与当前工作区套餐 / 订阅 / Business Trial 状态 |
| 匹配 | `https://app.notion.com/*`、`https://www.notion.so/*`、`https://notion.so/*` |
| 注入时机 | `@run-at document-start`；`@inject-into page`（Violentmonkey）；`@grant unsafeWindow`（AdGuard 进入页面上下文） |
| 根对象 | `unsafeWindow` → `window` → `globalThis` |
| Trusted Types | 若存在 AdGuard 的 `ADG_policyApi.createHTML`，所有 `innerHTML` 经它包装 |
| 单例 | 页面全局旗标 `__notionAiUsageUserscriptV1`，已存在则不再启动 |
| 测试模式 | 无 `document` 且有 `module.exports` 时只导出纯函数（供 `node --test`），不启动 UI |

### U-1 Frame 判定（Tabbit / ChatClub 嵌入）

- U-1.1 当前文档 URL 必须是 https 且 hostname ∈ {app.notion.com, www.notion.so, notion.so}，否则不启动。
- U-1.2 若 `location.ancestorOrigins` 中任一祖先是 Notion 页，则不启动（只在最外层 Notion 文档显示一份）。
- U-1.3 再沿 `parent` 链向上最多 32 层：可访问且是 Notion → 不启动；遇到跨源不可访问的壳（Tabbit、ChatClub）→ 视为合法嵌入边界，**放行**（fail-open）。

---

## 2. 数据来源

### U-2 被观察 / 调用的接口（全部同源 POST JSON）

| 种类 | Path | 用途 |
| --- | --- | --- |
| `current` | `/api/v3/getCreditRateLimitStatus` | 用量主数据（被动观察 + 主动刷新） |
| `legacy` | `/api/v3/getAIUsageEligibility` | 只用来拿 `spaceId` 上下文，不用于主动刷新 |
| `billing` | `/api/v3/getBillingData` | 套餐 / 订阅 / Trial（被动观察 + 主动刷新） |

- U-2.1 URL 判定：以当前页面 href 为 base 解析，**origin 必须同源**，pathname **精确等于**上表之一；否则视为无关请求。
- U-2.2 AI 写操作识别：非 GET、同源、pathname 匹配 `/(runInference|invokeAgent|submitAi|sendAi|createInference)/i` 且不是上表接口 → 成功（2xx）后 4 秒安排一次用量刷新。

### U-3 网络观察（document-start 安装）

- U-3.1 替换 `window.fetch` 为观察包装（函数名保持 `fetch`）；**先调用原生 fetch 并原样返回其 Promise**，观察逻辑全部旁路异步执行，不阻塞、不消费、不替换原响应（读取一律 `response.clone()`）。
- U-3.2 同时 hook `XMLHttpRequest.prototype.open / setRequestHeader / send`，元数据存 `WeakMap`；`loadend` 时读 `response`/`responseText`。原型冻结导致失败时回滚并警告。
- U-3.3 只读取目标请求的正文；**非目标请求的正文绝不读取**。读取方式：`init.body` 为 string / URLSearchParams；或 `Request.clone().text()`；若请求头已带合法 `x-notion-space-id` 则直接不读正文（规避 AdGuard 跨 realm Request 延迟）。
- U-3.4 请求头白名单（只按名逐个读取，不枚举）：`content-type`、`notion-client-version`、`x-notion-active-user-header`、`x-notion-cell`、`x-notion-space-id`，单值 ≤ 512 字符。**永不读取 Cookie / Authorization / token_v2**。
- U-3.5 spaceId 来源：正文 JSON 的 `spaceId`，或 `x-notion-space-id` 头；格式必须是 32 位 hex 或带连字符 UUID。

### U-4 请求配方（recipe）与上下文

- U-4.1 每个目标请求分配递增序号 `sequence`；序号小于已接受的上下文序号的请求被忽略（防乱序）。
- U-4.2 active user：取白名单头 `x-notion-active-user-header`（≤128 字符、无控制字符）。
- U-4.3 **工作区或用户切换**（spaceId 变化，或出现不同的 active user）：上下文版本号 +1，中止所有在途主动请求、清空定时器、清空用量与账单快照、错误、退避、禁用标志，重新开始；配方头重置。
- U-4.4 同一工作区同一用户的稀疏请求（例如 billing / legacy 只带少量头）**合并**进配方，不覆盖已有更全的头。
- U-4.5 每次接受上下文返回冻结的 context token `{sequence, contextVersion, spaceId, activeUserId}`；响应落地前必须重新校验 token 仍匹配当前上下文，否则丢弃。
- U-4.6 主动刷新开始时记录「被动序号」；若期间 Notion 自己的较新响应已被接受，则主动结果丢弃（新数据优先）。失败也只在上下文未变、且期间没有更新的成功时才写错误。

### U-5 首次加载节奏（refresh plan）

- U-5.1 看到 `current` 请求且尚无快照 → 给原生响应 1 秒宽限，1 秒后仍无数据则主动刷新。
- U-5.2 看到 `billing` 请求且无快照 → 0.4 秒后主动刷新用量；看到 `legacy` 且距离上次原生 `current` > 1.5 秒 → 0.4 秒后主动刷新。
- U-5.3 每次接受上下文也安排账单刷新：billing 来源 1.5 秒后，其它 0.25 秒后。
- **缺陷**：只有观察到 Notion 自己的这三类请求后才知道 spaceId；若当前路由（如 `/chat`、普通页面）没有触发它们，脚本会长时间停在「等待 Notion 初始化当前工作区」。

---

## 3. 数据规范化

### U-6 用量 verdict

- U-6.1 在响应对象中有界 BFS 查找 verdict（深度 ≤ 6、节点 ≤ 240、优先键 `creditRateLimitVerdict / creditRateLimitStatus / data / result / value`）。
- U-6.2 合法 verdict：`status ∈ {within_limit, rate_limited, not_applicable}`；非 `not_applicable` 时必须有 `window.used`、`window.limit` 为非负数（数字或数字字符串）。
- U-6.3 快照结构：`{status, rolling:{used,limit,percent,window,resetAt}, monthly:{used,limit,percent,resetAt}|null, limitedBy, enforcement, updatedAt}`。
- U-6.4 `percent = clamp(used/limit*100, 0, 100)`；limit ≤ 0 → 0。
- U-6.5 滚动窗口重置：`within_limit` → `now + resetsInSeconds*1000`；`rate_limited` → 若 `limitedBy==='billing_period'` 且有 `resumesAtMs` 用之，否则 `now + retryAfterSeconds*1000`，再否则 `resumesAtMs`。以 **响应到达客户端的时间** 为基准。
- U-6.6 `rolling.window` 取服务端字符串（≤16 字符，如 `6h`/`24h`），否则 `rolling`。
- U-6.7 月度窗口仅当 `billingPeriodWindow.used/limit/periodEndMs` 均合法且 `periodEndMs > now` 时存在。
- U-6.8 `limitedBy` 仅保留 `rolling` / `billing_period`；`enforcement` 仅保留 `preview`。
- U-6.9 schema 不支持：`current` 来源时写错误「Notion 返回了暂不支持的用量数据结构」，**保留最后有效快照**。

### U-7 账单 / 套餐

- U-7.1 `billingData` 取自 `payload.billingData` 或 `payload.data.billingData`；响应体上限 2 MB（content-length 或文本长度），超限丢弃。
- U-7.2 Trial 两种表示互斥：`subscription.trialEnd`（+ `subscription.startDate`）或 `trial.endDate`（+ `trial.startDate`、`trial.autoConvert`）；两者同时存在 → 视为不支持。
- U-7.3 时间戳必须是严格 ISO-8601（带时区，20–80 字符）。
- U-7.4 若 `billingData.clock.externalId` 存在，以 `clock.now` 作为服务端「现在」（Stripe test clock），本地流逝时间叠加其上。
- U-7.5 Trial 有效条件：结束时间 > 参考现在、开始 ≤ 结束、结束不超过参考现在 + 2×366 天、items 中最高套餐为 `business` → `{kind:'trial', plan:'business', startAt, endAt, autoConvert, usesServerClock, referenceNowAt}`。进行中但套餐未知 / 含未知产品 → 不支持（保留旧值）。
- U-7.6 无 subscription → `{kind:'none', plan:'free'}`。
- U-7.7 套餐等级：free 0 < student 1 < personal 2 < plus 3 < business 4 < enterprise / enterprise_limited 5；取最高。只有 free 且无未知产品 → none；否则未知产品 → `plan:'unknown'`。
- U-7.8 订阅状态白名单：active、trialing、past_due、unpaid、paused、canceled、incomplete、incomplete_expired，其余为 `unknown`。
- U-7.9 当前周期结束：`subscription.currentPeriodEnd`，否则对应 item 的 `currentPeriodEnd`。
- U-7.10 **隐私**：解析后立即只保留上述最小字段；地址、支付方式、发票、余额、dependencies 一律不保留不展示。
- U-7.11 Trial 剩余天数：`ceil((endAt - 参考当天本地 0 点) / 86400000)`；与结束日同一天 → 「今天结束」。Trial 过期后视为无效并强制刷新账单。

---

## 4. 刷新策略

| 规则 | 值 |
| --- | --- |
| U-8.1 用量心跳 | 每 30 秒检查一次；距上次成功/尝试 ≥ 60 秒则刷新；`not_applicable` 时 6 小时 |
| U-8.2 最小间隔 | 成功后 15 秒内不再主动刷新；两次尝试至少间隔 5 秒 |
| U-8.3 账单 | 最多每小时一次；两次尝试至少 15 秒 |
| U-8.4 超时 | 主动请求 12 秒 AbortController |
| U-8.5 失败退避（用量） | 15s 起翻倍，上限 5 分钟；429 带 `retry-after` 时至少等待该时长 |
| U-8.6 401/403 | 用量：禁用主动刷新并提示「请打开原生用量页触发 Notion 自身请求」；账单：禁用账单刷新 |
| U-8.7 账单失败 | 429：`retry-after` 或 60 秒；其它（非超时）：15 分钟 |
| U-8.8 页面隐藏 | `document.hidden` 时不刷新；重新可见立即跑一次心跳 |
| U-8.9 主动请求 | `POST {origin}{path}`，`credentials:'include'`、`cache:'no-store'`，头 = 配方白名单头 + `content-type: application/json`，体 `{"spaceId": …}` |
| U-8.10 定时器合并 | 已有更早的定时器则不再安排更晚的 |

手动刷新按钮同时强制刷新用量与账单（仍受最小间隔约束，按钮禁用态反映冷却）。

---

## 5. 界面

### U-9 宿主

- U-9.1 `div#notion-ai-usage-userscript-host` 挂在 `document.body` 末尾，`attachShadow({mode:'open'})`，样式全部在 Shadow DOM 内，不依赖 Notion 混淆 class，不进入 React 子树。
- U-9.2 `:host` 固定定位 `position:fixed; z-index:2147483646`，`pointer-events:none`，只有胶囊 / 卡片 / 圆环可交互。
- U-9.3 每 2.5 秒 `ensureUi`：宿主被移除则重建；父节点不是 body 则重新 append。
- U-9.4 主题：读取 html/body 的 class 与 `data-theme`/`data-mode` 中的 dark/light 关键字；否则取 `#notion-app`、`.notion-app-inner`、视口中心元素链的背景色亮度（<0.52 为暗）；再否则 body 文字颜色反推；最后 `prefers-color-scheme`。监听 html/body 的 `lang/class/style/data-theme/data-mode` 变化实时更新。
- U-9.5 语言：`<html lang>` 以 `zh` 开头 → 中文，否则英文。

### U-10 三种形态

1. **胶囊（summary）**：状态点 + 摘要文字 + ▾/▴ + 常驻「最小化」按钮。
   - 摘要：`6h% · 月度%`，若有套餐则 `| Business · Active` 或 `| Trial Nd` / `Trial ends today`；Free 不显示套餐段。
   - 无快照：`等待` / `读取中`；`not_applicable`：`不适用`。
   - 状态点：ok 绿、error 红（rate_limited 或错误）、waiting 黄、neutral 灰。
2. **展开卡片（card）**：标题「Notion AI 用量」+ preview 信息图标（仅 `enforcement==='preview'`，悬停/聚焦提示）+ 刷新按钮（Lucide refresh-cw，加载时旋转）；提示区（info/error）；指标行：当前窗口（6 小时）/ 月度用量：百分比 + 进度条（≥70% 黄、≥90% 红）+ 重置文案；套餐行；页脚「N 分钟前更新 — Notion 同源接口」+ 打开原生用量页按钮（当前 URL 加 `?target=aiusage` 跳转）。
3. **最小化圆环（orb）**：两个 20px conic-gradient 圆环（6h、月度），圆内无数字；悬停/键盘聚焦显示原生风格双行浮层「AI 用量 / 6 小时 x% · 月度 y%」；点击恢复为胶囊并聚焦。浮层根据上下空间自动朝上/朝下。

- U-10.1 文案规则：重置时间 ≤ 24h 显示「N 小时 M 分钟后重置」，更远显示本地日期时间；更新时间「刚刚 / N 秒前 / N 分钟前 / N 小时前」。
- U-10.2 rate_limited 提示：按 `limitedBy` 显示「已达到月度额度上限」或「已达到当前滚动窗口的额度上限」。
- U-10.3 错误合并：用量错误、账单错误、位置错误以「；」拼接；有快照时附「（继续显示可用的最后有效数据）」。
- U-10.4 可访问性：所有图标按钮有 `aria-label`/`title`；圆环 `aria-label` 带完整读数；`prefers-reduced-motion` 关闭动画。

### U-11 拖拽与位置

- U-11.1 胶囊与卡片标题栏可拖（4px 阈值；最小化时不可拖）；拖拽中 pointer capture，`pointercancel`/失焦/丢失捕获视为取消并回滚。
- U-11.2 保存「边缘锚点」：`{v:2, xEdge:left|right, xOffset, yEdge:top|bottom, yOffset, side, verticalSide}`，取距离最近的视口边；键 `notion-ai-usage:position:v2`（当前 Notion origin 的 localStorage）。
- U-11.3 窗口缩放 / iframe 变化 / 展开收起 / 文案变宽只重算坐标，**不写回**；只有用户真实拖拽才写。写后读回校验，失败显示位置错误。
- U-11.4 只读兼容旧键：v1 绝对坐标 `notion-ai-usage:position:v1`、scoped v2 `…:v2:top|embedded|embedded-<64hex>`（embedded-hash 优先）。
- U-11.5 展开时卡片若下方空间不够自动向上展开（`verticalSide`）。
- U-11.6 跨标签页 `storage` 事件同步位置；拖拽进行中则延后到结束再应用，且仅当仍是最新值。
- U-11.7 拖拽结束后 500ms 内抑制一次 click，避免拖完误展开。
- U-11.8 偏好键：`notion-ai-usage:expanded:v1`、`notion-ai-usage:minimized:v1`（'1'/'0'）。

### U-12 最小化停靠输入框（问题高发区）

- U-12.1 最小化时，圆环停靠在 Notion AI 输入框（composer）**内部底部居中**：水平居中并夹在左右内边距（`min(6, max(2, 宽/8))`）内；`top = 底边 - 圆环高 - 7px`，夹在 `[top+min(4,…), bottom-高-4]`；再夹进视口。停靠坐标 **从不写入位置键**。
- U-12.2 composer 定位：枚举 `textarea`、`[role=textbox][contenteditable]`、`[contenteditable=true|plaintext-only]` 以及当前焦点元素；过滤不可见（`aria-hidden`/`inert`/display/visibility/opacity/content-visibility）、宽 < 180、高 > 240、底部在视口上 35% 以内的。
- U-12.3 资格：编辑器属性文本（aria-label、placeholder、data-placeholder、data-testid、id、class）命中 AI 语义正则（Notion AI / Do anything with AI / Ask AI / 中文「问 AI」等），或容器被判定为「AI 输入面」。
- U-12.4 容器评分：从编辑器向上 8 层，按语义(+76)/结构词(+10)/视觉面(圆角≥6 + 边框/阴影/背景，位于页面中部且避开侧栏，或在 dialog/aside 内，+58)/form(+54)/发送按钮(+70)/其它按钮(+12)/底部留白/横向留白/高度区间等打分，取最高。只有在 `/ai` 路由才把「视觉面」当作 AI 资格。
- U-12.5 编辑器总分再加：语义 +110、textarea +48、textbox +44、lexical +24、聚焦 +130、越靠下越宽越高分、在 dialog/aside 内 +16。
- U-12.6 跟踪：缓存已选 composer；`ResizeObserver` 只观察 composer **尺寸**；`MutationObserver` 在找到后改为只观察 composer 的 **祖父节点子树**；另监听 scroll(capture)、focusin、resize、visualViewport resize/scroll；未命中时扫描冷却 600ms；`ensureUi` 每 2.5 秒补一次。

### U-12 已知缺陷与根因（重写必须修复）

| 现象 | 根因 |
| --- | --- |
| 圆环不贴合（偏离输入框、停在旧位置） | composer **位置**变化但尺寸不变（侧栏开合、侧边 AI 面板滑入、对话区布局变化、输入框上方附件条出现、窗口内滚动容器移动）时，ResizeObserver 不触发；MutationObserver 只看祖父子树，看不到外部布局变化；只能等 2.5 秒兜底或下一次 scroll/focus |
| SPA 切换后不显示 / 停在角落 | 没有任何路由监听（无 pushState/replaceState/popstate/navigation 钩子）；`/ai` 判定只认 `/ai`，Notion AI 现已使用 `/chat?t=…` 路由，`/chat` 下视觉面不算 AI 资格，只能靠 placeholder 语义正则命中；切换会话时 React 替换 composer 节点，缓存的旧节点若仍可见（过渡动画期间）就继续被使用 |
| 等待状态长时间不消失 | spaceId 只能从 Notion 自身三类请求获得（U-5 缺陷） |
| 宿主偶尔消失 | 依赖 2.5 秒轮询发现宿主被移除，期间不可见 |
| composer 在视口上 35% 以内（例如对话为空时居中的大输入框） | 被直接过滤，不停靠 |

---

## 6. 隐私与安全约束（重写必须保持）

- 不读、不存、不外传 Cookie、`token_v2`、Authorization；只用浏览器自动携带的同源登录态。
- 用量快照只在内存；localStorage 只存位置与展开/最小化偏好。
- 不读非目标请求正文；不替换、不阻塞 Notion 原响应。
- 401/403 不尝试绕过。

## 7. 测试覆盖（原仓库 `tests/notion-ai-usage.test.cjs`，1988 行）

覆盖 schema 解析、套餐/Trial、服务端时钟、天数算法、拖拽阈值、边界夹取、停靠几何、视口切换、位置键兼容、双圆环呈现、同源白名单、请求头脱敏、跨账号与并发竞态、非目标正文不读取。
