# [Notion AI] Usage [20260730] v1.0.0

当前发布版本：`[20260730] v1.0.0`。用户脚本的机器版本为 `20260730.1.0.0`，以符合 Violentmonkey 的版本比较格式。

在 Notion 页面右上角显示 AI 的滚动用量、月度用量，以及当前工作区 Business Trial 的剩余天数和准确结束时间。脚本使用 Notion 自己的同源接口和当前登录态，不读取、不保存、也不外传 Cookie、`token_v2` 或 Authorization。

Notion 官方目前把额度分成「滚动六小时窗口」和「月度窗口」；原生入口是 `Settings → Notion AI → Usage`。Business Plan 通用试用通常为 30 天，但活动期限并不固定，所以脚本只采用服务端返回的实际结束时间，不用固定天数倒推。参见 [AI 用量说明](https://www.notion.com/en-gb/help/manage-your-usage-allowance-for-notion-ai)与 [付费套餐试用说明](https://www.notion.com/en-gb/help/paid-plan-trials)。

## 功能

- 固定小胶囊，展开后显示当前会话、月度用量、百分比和重置时间。
- 若当前工作区处于 Business Trial，额外显示 `剩余 N 天` 与精确结束日期；兼容独立 trial 与 subscription-backed trial。
- 自动跟随 Notion UI 语言：`zh-*` 使用中文，其余语言使用英文。
- 自动跟随 Notion 自身的普通/黑暗主题，并在页面内切换主题时实时更新。
- 用量百分比之间保留圆点，Trial 前使用 1 px 竖线；刷新使用带无障碍标签的 SVG 图标按钮。
- 刷新图标按 [Lucide `refresh-cw`](https://lucide.dev/icons/refresh-cw) 的官方 24 px 路径重绘。
- `preview` 说明收进标题右侧的信息图标，鼠标悬停或键盘聚焦时显示。
- 支持 `within_limit`、`rate_limited`、`not_applicable` 三种状态。
- 用量常规主动轮询约每 60 秒；账单试用数据最多每小时读取一次；页面隐藏时暂停，错误时退避。
- 首次加载会先给 Notion 原生用量请求 1 秒响应时间；若其仍未完成，脚本立即用同源接口主动兜底，不再等待十几秒。
- AI 请求结束后延迟刷新，并在当前页面内保留最后一次有效数据。
- 点击「原生用量页」可打开 Notion 的 `Settings → Notion AI → Usage`。
- Shadow DOM 隔离样式，不依赖 Notion 的混淆 class，也不挂进 React 子树。
- 兼容 Notion SPA；宿主被页面移除后会自动恢复。
- 支持 Tabbit/ChatClub 等跨源容器中的 Notion iframe；若存在 Notion 祖先 frame，只在最外层 Notion 文档显示一份。

## 安装

### Violentmonkey

1. 在目标浏览器安装 Violentmonkey。
2. [直接安装用户脚本](https://raw.githubusercontent.com/0-V-linuxdo/notion-ai-usage/main/notion-ai-usage.user.js)，或新建用户脚本并粘贴 [notion-ai-usage.user.js](./notion-ai-usage.user.js) 的全部内容。
3. 打开或刷新 `https://app.notion.com/ai`。

### AdGuard 桌面版

1. 打开 AdGuard for Mac/Windows 的「设置 → 扩展」。
2. 选择「添加扩展」，再从文件或 URL 导入 [notion-ai-usage.user.js](./notion-ai-usage.user.js)。
3. 启用脚本后，完全刷新已打开的 Notion 页面。

脚本使用 AdGuard 官方支持的 `@grant unsafeWindow` 进入页面上下文，并通过 `ADG_policyApi` 兼容 Trusted Types；同时保留 Violentmonkey 的 `@inject-into page`，防止其回退到无法观察 Notion 网络请求的隔离世界。`@inject-into` 只供 Violentmonkey 使用，AdGuard 的页面上下文由 `unsafeWindow` 提供，并不依赖该字段。同一份脚本可由 AdGuard 桌面版跨浏览器注入，也可直接安装到 Violentmonkey。页面右上角出现 `AI …% · …% | Trial …d`（中文界面显示中文）胶囊后即表示运行成功。

若 AdGuard 2.19+ 在导入时提示脚本会修改站点安全相关 API，这是因为本脚本需要在页面内观察 `fetch`/XHR 才能读取 Notion 自己返回的用量；请只安装你已检查过的本地文件。若脚本未出现，请确认 Notion 没有被加入 AdGuard 例外列表，并在启用扩展后完全刷新页面。

目标浏览器：Arc、Zen、Firefox Nightly、Dia、Tabbit。浏览器必须允许安装兼容扩展；本项目不提供 `javascript:` bookmarklet。

当 Notion 被嵌入 Tabbit 一类的跨源容器时，脚本仍只匹配并运行在 `app.notion.com` frame 内，不会注入容器顶层，也不会读取或操作父页面。

## 它怎样取数

当前 Notion 原生 Usage 页的数据源是：

```text
POST /api/v3/getCreditRateLimitStatus
Content-Type: application/json

{"spaceId":"当前工作区 UUID"}
```

脚本在 `document-start` 观察页面自身的 `fetch` 和 XHR：

1. 精确匹配同源的 `getCreditRateLimitStatus` 与旧版 `getAIUsageEligibility`。
2. 从页面请求中取得当前 `spaceId` 和必要的非密钥请求头；同一工作区与用户的稀疏请求不会覆盖已经取得的完整请求配方。
3. 使用 `response.clone()` 异步读取响应，不消费、阻塞或替换 Notion 的原响应。
4. 主动刷新只调用新版 `getCreditRateLimitStatus`；旧接口只用于 workspace 上下文和兼容回退。
5. 同源请求使用浏览器自动携带的现有登录态；代码从不访问 Cookie 内容。

响应中真正用于显示的核心结构为：

```js
{
  status: "within_limit" | "rate_limited" | "not_applicable",
  window: {
    window: "6h" | "24h",
    used: Number,
    limit: Number
  },
  resetsInSeconds: Number,
  billingPeriodWindow: {
    used: Number,
    limit: Number,
    periodEndMs: Number
  }
}
```

百分比为 `clamp(used / limit * 100, 0, 100)`。月度窗口已经结束时不会继续显示旧数据。

Business Trial 使用另一个只读 workspace 接口：

```text
POST /api/v3/getBillingData
Content-Type: application/json

{"spaceId":"当前工作区 UUID"}
```

响应中的实际日期路径为：

```text
billingData.trial.startDate
billingData.trial.endDate

或：

billingData.subscription.startDate
billingData.subscription.trialEnd
```

日期是带时区的 ISO-8601 字符串。脚本还遵循 Notion 前端对 `billingData.clock` 的处理，并用其同款口径计算：从 billing 当前日期的零点到 trial end 的 UTC 天数差向上取整。两个 trial 表示同时出现、日期不合法、已经结束或实际活动套餐不是 Business 时，试用行会隐藏，不作猜测。

## DevTools 验证

遵循项目约束，使用 DevTools，不使用 bookmarklet 或 `osascript`：

1. 在 Arc 打开 Notion AI。
2. 打开 DevTools → Network → Fetch/XHR。
3. 过滤 `getCreditRateLimitStatus`。
4. 点击脚本卡片中的「刷新」。
5. 应看到同源 POST，Request Payload 只有 `spaceId`；Response 包含 `status`、`window`，并可能包含 `billingPeriodWindow`。
6. Console 不应出现脚本异常；接口 schema 改变时只会出现带 `[Notion AI Usage]` 前缀的警告，并继续保留最后有效快照。

旧接口 `getAIUsageEligibility` 也可能出现，但不能把旧 eligibility 字段误当成新 Usage 页的两条进度。

## 隐私与安全

- 无 `@connect`，无第三方请求，无遥测。
- 请求 URL 必须与当前 Notion 页面同源，且 pathname 必须精确匹配白名单。
- 仅在内存中复用 `content-type`、Notion client version、active user、space id 等允许项。
- 明确拒绝复制 `Cookie`、`Authorization` 和其他请求头。
- 用量快照只保存在当前页面内存中，不写入 Web Storage；`localStorage` 只保存卡片展开/收起偏好。
- `getBillingData` 还可能包含地址、支付方式与发票等账单字段；脚本设置 2 MB 上限，解析后立即只保留 trial 起止时间、服务端时钟和 `autoConvert`，其余字段与 `dependencies` 均不记录、不展示、不持久化。
- 401/403 时停止主动取数并提示权限问题，不尝试绕过认证。

## 开发与测试

无需安装依赖，Node.js 20 及以上即可：

```bash
npm run check
```

该命令先做 JavaScript 语法检查，再运行单元测试，覆盖当前 quota schema、两种 Business Trial schema、Notion billing clock 天数算法、畸形与过期日期、同源白名单、请求头脱敏、跨账号与并发响应竞态，以及非目标请求正文绝不被读取。

## 研究说明

Voyager 的 Gemini 实现与本脚本迁移取舍见 [docs/voyager-and-notion-analysis.md](./docs/voyager-and-notion-analysis.md)。本项目借鉴其「早期观察 → 结构校验 → 同源重放 → 缓存与 UI」架构，代码为独立实现，没有复制 Voyager 的 GPL 源码。
