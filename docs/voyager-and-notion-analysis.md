# Voyager Gemini 用量机制与 Notion AI 迁移分析

本文基于 Voyager commit [`71b6ef0`](https://github.com/Nagi-ovo/voyager/tree/71b6ef034d5154459bca470b94a6f9aa188950f5)、Arc DevTools 中的实际 Notion Usage 页，以及 2026-07-30 的 Notion Web bundle。

## 1. Voyager 怎样获取 Gemini 用量

### 1.1 必须足够早地进入页面上下文

Voyager 在普通 content 入口启动 `startUsageStatus()`，同时把 `usage-observer.js` 以 `document_start`、MAIN world 注入。这有两个目的：

- 抢在 Gemini `/usage` 页面启动时的 eager RPC 之前 hook `fetch`/XHR。
- 读取隔离 content script 拿不到的 `window.WIZ_global_data`。

对应源码：

- [`src/pages/content/index.tsx`](https://github.com/Nagi-ovo/voyager/blob/71b6ef034d5154459bca470b94a6f9aa188950f5/src/pages/content/index.tsx#L325-L338)
- [`public/usage-observer.js`](https://github.com/Nagi-ovo/voyager/blob/71b6ef034d5154459bca470b94a6f9aa188950f5/public/usage-observer.js#L1-L21)
- [`vite.config.chrome.ts`](https://github.com/Nagi-ovo/voyager/blob/71b6ef034d5154459bca470b94a6f9aa188950f5/vite.config.chrome.ts#L62-L82)

隔离 world 与 MAIN world 之间通过 `window.postMessage` 传递最小数据。

### 1.2 捕获一次真实 RPC，生成可重放 recipe

Gemini 用量不是普通 JSON REST endpoint，而是 Google `batchexecute` RPC。观察器只匹配 URL 包含 `batchexecute` 的 fetch/XHR，然后：

1. 从 query 的 `rpcids=` 取得混淆 RPC id。
2. 从表单体 `f.req=` 解码内层 `[rpcid, args, null, "generic"]`。
3. 保存 `{rpcid, args}` recipe。
4. `clone()` 响应，绝不影响原请求。

相关实现：[`usage-observer.js#L46-L80`](https://github.com/Nagi-ovo/voyager/blob/71b6ef034d5154459bca470b94a6f9aa188950f5/public/usage-observer.js#L46-L80)、[`#L86-L168`](https://github.com/Nagi-ovo/voyager/blob/71b6ef034d5154459bca470b94a6f9aa188950f5/public/usage-observer.js#L86-L168)。

当前内置默认 recipe 是：

```js
{ rpcid: "jSf9Qc", args: "[]" }
```

Google 轮换 id 后，用户重新打开 Gemini `/usage`，Voyager 会从真实流量自校准。

### 1.3 用 Gemini 页面 token 静默重放

Voyager 重放：

```text
POST {origin}{/u/N?}/_/BardChatUi/data/batchexecute
```

关键参数来自 `WIZ_global_data`：

- `cfb2h` → `bl`
- `FdrFJe` → `f.sid`
- `SNlM0e` → 表单 `at`

请求设置 `credentials: "include"`，让浏览器自动携带 Gemini 第一方 Cookie；实现没有手工拼 Cookie 或 Authorization。多账户 `/u/N` 必须同时用于 endpoint 与 `source-path=/u/N/usage`。完整代码见 [`usage-observer.js#L170-L240`](https://github.com/Nagi-ovo/voyager/blob/71b6ef034d5154459bca470b94a6f9aa188950f5/public/usage-observer.js#L170-L240)。

### 1.4 解码和结构校验

Google 返回值带 `)]}'` anti-JSON-hijacking 前缀和长度块。Voyager 扫描 `[["wrb.fr"`，配对括号后两次 `JSON.parse`，而不是依赖易变的长度。见 [`batchexecute.ts`](https://github.com/Nagi-ovo/voyager/blob/71b6ef034d5154459bca470b94a6f9aa188950f5/src/core/utils/batchexecute.ts#L1-L68)。

已知 metric 结构：

```text
[limit, fractionUsed, periodEnum, [[resetEpochSec, nanos]]]
```

- `period=1`：当前 UI 的 5 小时滚动窗口（代码内旧名 daily）。
- `period=2`：weekly。
- 百分比：`Math.round(fractionUsed * 100)`。
- 未知 period（例如 4）忽略，不拖垮已知项。

解析实现见 [`usageStatus/index.ts#L708-L762`](https://github.com/Nagi-ovo/voyager/blob/71b6ef034d5154459bca470b94a6f9aa188950f5/src/pages/content/usageStatus/index.ts#L708-L762)。

### 1.5 DOM 回退与交叉验证

RPC 不是盲信：Voyager 还能从 `/usage` 页的 DOM 读取 5h/weekly 百分比与重置文本。发现候选 RPC 后，先做结构解析，再与 DOM 两个百分比做 ±2 个百分点的交叉验证；通过后才持久化 recipe。见 [`usageStatus/index.ts#L560-L706`](https://github.com/Nagi-ovo/voyager/blob/71b6ef034d5154459bca470b94a6f9aa188950f5/src/pages/content/usageStatus/index.ts#L560-L706)、[`#L1344-L1368`](https://github.com/Nagi-ovo/voyager/blob/71b6ef034d5154459bca470b94a6f9aa188950f5/src/pages/content/usageStatus/index.ts#L1344-L1368)。

### 1.6 缓存、刷新与竞态

Voyager 按 `default`/`u/N` 分账户缓存 snapshot，避免串号。刷新来源包括：

- Gemini generation 请求结束 4 秒后。
- 页面重新可见时。
- 两分钟 heartbeat，但 snapshot 超过五分钟才真正请求。
- 用户手动刷新。

它还拒绝旧请求覆盖新 snapshot；同一个 reset window 内自动观察到用量下降时，先等两秒做第二次 fresh RPC 确认。相关代码见 [`usageStatus/index.ts#L295-L407`](https://github.com/Nagi-ovo/voyager/blob/71b6ef034d5154459bca470b94a6f9aa188950f5/src/pages/content/usageStatus/index.ts#L295-L407)、[`#L1392-L1512`](https://github.com/Nagi-ovo/voyager/blob/71b6ef034d5154459bca470b94a6f9aa188950f5/src/pages/content/usageStatus/index.ts#L1392-L1512)。

## 2. Notion AI 的真实用量接口

Arc 中原生页面显示：

- Rolling：滚动窗口用量、剩余时间。
- Monthly：月度用量、billing cycle 重置日。

官方文档确认当前是「滚动六小时 + 月度」两种窗口：[Manage your usage allowance for Notion AI](https://www.notion.com/en-gb/help/manage-your-usage-allowance-for-notion-ai)。

### 2.1 新旧接口不能混淆

DevTools 会看到旧接口：

```text
POST /api/v3/getAIUsageEligibility
```

它仍用于 eligibility/旧数据刷新，也能提供 `spaceId` 上下文；但当前 Usage 页两条进度真正来自：

```text
POST /api/v3/getCreditRateLimitStatus
{"spaceId":"..."}
```

静态证据：

- [`10616-187c7ac8651e2028.js`](https://www.notion.so/_assets/10616-187c7ac8651e2028.js)：调用新 endpoint，并定义 runtime schema。
- [`41086-be240084ef4cf147.js`](https://www.notion.so/_assets/41086-be240084ef4cf147.js)：计算两条百分比和重置时间。
- [`spaceSettings-b3469edb0616e64d.js`](https://www.notion.so/_assets/spaceSettings-b3469edb0616e64d.js)：Usage 设置页接入 store。
- [`FullPageAI-9908e236119fa860.js`](https://www.notion.so/_assets/FullPageAI-9908e236119fa860.js)：旧 eligibility 请求。

### 2.2 当前响应 schema

无额外 HTTP `data` 包裹：

```js
{ status: "not_applicable" }

{
  status: "within_limit",
  window: {
    creditType: "basic_ai_credits",
    scope: "per_user",
    window: "6h" | "24h",
    used: Number,
    limit: Number
  },
  resetsInSeconds: Number | undefined,
  billingPeriodWindow: {
    creditType: "basic_ai_credits",
    scope: "per_user",
    cadence: "billing_period",
    used: Number,
    limit: Number,
    periodEndMs: Number
  } | undefined,
  enforcement: "preview" | undefined
}

{
  status: "rate_limited",
  window: { /* 同上 */ },
  retryAfterSeconds: Number | undefined,
  billingPeriodWindow: { /* 同上 */ } | undefined,
  limitedBy: "rolling" | "billing_period" | undefined,
  resumesAtMs: Number | undefined
}
```

计算：

```js
percent = clamp(used / limit * 100, 0, 100)
```

`not_applicable` 必须作为独立状态，不能显示成 `0%`。月度 `periodEndMs` 已经过期时，不继续显示旧窗口。

## 3. 迁移到用户脚本的设计

不能照搬 Gemini 的 rpcid、WIZ token 或 `batchexecute`：它们只在 Gemini 第一方页面有效。能迁移的是架构。

| Voyager 思路 | Notion AI 用户脚本实现 |
| --- | --- |
| `document_start` MAIN world | `@run-at document-start` + `@inject-into page` |
| 观察 `batchexecute` | 精确观察两个 Notion 同源 pathname |
| 保存 `{rpcid,args}` | 只保留 `spaceId` 和允许的非密钥 header |
| `response.clone()` | 同样 clone，不消费原响应 |
| WIZ token + Cookie 登录态 | 不读 token；`credentials: include` 让浏览器自行处理 |
| Gemini RPC replay | 主动 POST `getCreditRateLimitStatus` |
| snapshot 缓存 | 只在当前页面内存保留最后有效 snapshot，避免跨用户持久化 |
| DOM 兜底 | Shadow DOM 浮层；不依赖 Notion 混淆 class |

额外收紧：

- 校验 `origin === location.origin` 与精确 pathname。
- 请求头只允许 `content-type`、client version、active user 和 space id。
- 从不复制 Cookie/Authorization。
- HTTP 状态、超时、429/5xx 退避均显式处理。
- schema 异常不覆盖最后有效 snapshot。
- 页面隐藏时暂停刷新。

## 4. 原生 Usage 页 deeplink

Notion 当前支持 query target：

```js
const url = new URL(location.href);
url.searchParams.set('target', 'aiusage');
location.assign(url.href);
```

启动处理器会打开 `Settings → Notion AI → Usage` 并清理参数。脚本的「原生用量页」按钮使用这一入口，而不是依赖易变的 React class 或内部 module id。

## 5. 许可边界

Voyager 为 GPL-3.0。本项目只借鉴公开架构和行为分析；用户脚本代码是独立实现，没有复制其实现片段，因此没有把 GPL 源文件并入本项目。
