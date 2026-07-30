// ==UserScript==
// @name         [Notion AI] Usage [20260731] v1.1.2
// @namespace    https://github.com/0-V-linuxdo/notion-ai-usage
// @version      20260731.1.1.2
// @description  Show Notion AI usage and workspace plan status without exposing cookies or tokens.
// @homepageURL  https://github.com/0-V-linuxdo/notion-ai-usage
// @supportURL   https://github.com/0-V-linuxdo/notion-ai-usage/issues
// @downloadURL  https://raw.githubusercontent.com/0-V-linuxdo/notion-ai-usage/main/notion-ai-usage.user.js
// @updateURL    https://raw.githubusercontent.com/0-V-linuxdo/notion-ai-usage/main/notion-ai-usage.user.js
// @match        https://app.notion.com/*
// @match        https://www.notion.so/*
// @match        https://notion.so/*
// @run-at       document-start
// @grant        unsafeWindow
// @inject-into  page
// ==/UserScript==

(function bootstrapNotionAiUsage(root) {
  'use strict';

  const CURRENT_ENDPOINT = '/api/v3/getCreditRateLimitStatus';
  const LEGACY_ENDPOINT = '/api/v3/getAIUsageEligibility';
  const BILLING_ENDPOINT = '/api/v3/getBillingData';
  const SCRIPT_PREFIX = '[Notion AI Usage]';
  const HOST_ID = 'notion-ai-usage-userscript-host';
  const EXPANDED_KEY = 'notion-ai-usage:expanded:v1';
  const MINIMIZED_KEY = 'notion-ai-usage:minimized:v1';
  const LEGACY_POSITION_KEY = 'notion-ai-usage:position:v1';
  const POSITION_KEY = 'notion-ai-usage:position:v2';
  const LEGACY_POSITION_KEY_PREFIX = `${POSITION_KEY}:`;
  const LEGACY_POSITION_SCOPE_PATTERN = /^(?:top|embedded(?:-[0-9a-f]{64})?)$/;
  const POSITION_INSET = 8;
  const COMPOSER_DOCK_INSET = 7;
  const COMPOSER_SCAN_COOLDOWN_MS = 600;
  const DRAG_THRESHOLD = 4;
  const MIN_REFRESH_INTERVAL = 15000;
  const BILLING_REFRESH_INTERVAL = 60 * 60 * 1000;
  const CURRENT_RESPONSE_GRACE_INTERVAL = 1000;
  const SAFE_HEADER_NAMES = new Set([
    'content-type',
    'notion-client-version',
    'x-notion-active-user-header',
    'x-notion-cell',
    'x-notion-space-id',
  ]);
  const NOTION_HOSTNAMES = new Set(['app.notion.com', 'www.notion.so', 'notion.so']);
  const VALID_STATUSES = new Set(['within_limit', 'rate_limited', 'not_applicable']);
  const VALID_SUBSCRIPTION_STATUSES = new Set([
    'active',
    'trialing',
    'past_due',
    'unpaid',
    'paused',
    'canceled',
    'incomplete',
    'incomplete_expired',
  ]);
  const SPACE_ID_PATTERN = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
  const PLAN_RANK = new Map([
    ['free', 0],
    ['student', 1],
    ['personal', 2],
    ['plus', 3],
    ['business', 4],
    ['enterprise', 5],
    ['enterprise_limited', 5],
  ]);
  const COMPOSER_EDITOR_SELECTOR = [
    'textarea',
    '[role="textbox"][contenteditable="true"]',
    '[role="textbox"][contenteditable="plaintext-only"]',
    '[contenteditable="true"]',
    '[contenteditable="plaintext-only"]',
  ].join(',');
  const COMPOSER_SEMANTIC_PATTERN =
    /(?:notion[\s_-]*ai|do\s+anything\s+with\s+ai|ask[\s_-]*(?:notion[\s_-]*)?ai|ai[\s_-]*(?:chat|input|prompt|composer|assistant)|(?:chat|input|prompt|composer|message)[\s_-]*(?:for[\s_-]*|with[\s_-]*)?ai|(?:用|向|让|问)\s*(?:notion\s*)?ai|ai\s*(?:助手|输入|对话|提问))/i;
  const COMPOSER_STRUCTURE_PATTERN = /(?:composer|prompt|comment|message|输入|发送|提问)/i;
  const COMPOSER_SEND_PATTERN = /(?:send|submit|发送|提交)/i;

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function finiteNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string' || value.trim() === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function nonNegativeNumber(value) {
    const number = finiteNumber(value);
    return number !== null && number >= 0 ? number : null;
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function isPageInstance(value, constructorName) {
    try {
      const Constructor = root && root[constructorName];
      return typeof Constructor === 'function' && value instanceof Constructor;
    } catch {
      return false;
    }
  }

  function isNotionPageUrl(value) {
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'https:' && NOTION_HOSTNAMES.has(parsed.hostname);
    } catch {
      return false;
    }
  }

  function shouldBootstrapInFrame(windowRef) {
    if (
      !windowRef ||
      !windowRef.document ||
      !windowRef.location ||
      !isNotionPageUrl(windowRef.location.href)
    ) {
      return false;
    }

    // Chromium exposes cross-origin ancestors without granting DOM access.
    // Skip a nested Notion document, but allow a Notion iframe inside Tabbit
    // or another non-Notion shell.
    try {
      const ancestorOrigins = windowRef.location.ancestorOrigins;
      if (ancestorOrigins && Number.isSafeInteger(ancestorOrigins.length)) {
        for (let index = 0; index < ancestorOrigins.length; index += 1) {
          if (isNotionPageUrl(String(ancestorOrigins[index]))) return false;
        }
      }
    } catch {
      // Fall back to walking only ancestors whose locations are accessible.
    }

    const seen = new Set();
    let current = windowRef;
    for (let depth = 0; depth < 32; depth += 1) {
      let parent;
      try {
        parent = current.parent;
      } catch {
        break;
      }
      if (!parent || parent === current || seen.has(parent)) break;
      seen.add(parent);
      try {
        if (isNotionPageUrl(parent.location && parent.location.href)) return false;
        current = parent;
      } catch {
        // An unknown cross-origin shell is a valid embedding boundary. Fail
        // open here so Tabbit/ChatClub cannot accidentally suppress the UI.
        break;
      }
    }
    return true;
  }

  function trustedHtml(html) {
    try {
      if (
        typeof ADG_policyApi !== 'undefined' &&
        ADG_policyApi &&
        typeof ADG_policyApi.createHTML === 'function'
      ) {
        return ADG_policyApi.createHTML(html);
      }
    } catch {
      // Other userscript managers do not expose AdGuard's Trusted Types bridge.
    }
    return html;
  }

  function percentage(used, limit) {
    if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return 0;
    return clamp((used / limit) * 100, 0, 100);
  }

  function isVerdictShape(value) {
    if (!isRecord(value) || !VALID_STATUSES.has(value.status)) return false;
    if (value.status === 'not_applicable') return true;

    const rolling = value.window;
    return (
      isRecord(rolling) &&
      nonNegativeNumber(rolling.used) !== null &&
      nonNegativeNumber(rolling.limit) !== null
    );
  }

  /**
   * Notion's request wrapper is currently transparent, but older call sites and
   * cached stores may nest the verdict. Search only a small, bounded object tree.
   */
  function findCreditVerdict(payload) {
    const queue = [{ value: payload, depth: 0 }];
    const seen = new Set();
    let visited = 0;

    while (queue.length && visited < 240) {
      const current = queue.shift();
      const value = current.value;
      visited += 1;

      if (isVerdictShape(value)) return value;
      if (current.depth >= 6 || (!isRecord(value) && !Array.isArray(value))) continue;
      if (seen.has(value)) continue;
      seen.add(value);

      const priorityKeys = [
        'creditRateLimitVerdict',
        'creditRateLimitStatus',
        'data',
        'result',
        'value',
      ];
      for (const key of priorityKeys) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          queue.unshift({ value: value[key], depth: current.depth + 1 });
        }
      }

      for (const child of Object.values(value)) {
        if (isRecord(child) || Array.isArray(child)) {
          queue.push({ value: child, depth: current.depth + 1 });
        }
      }
    }

    return null;
  }

  function normalizeVerdict(payload, nowMs = Date.now()) {
    const verdict = findCreditVerdict(payload);
    if (!verdict) return null;

    const status = verdict.status;
    // Match Notion's store: reset countdowns are based on when this response
    // reached the client, not on an optional server-side activity timestamp.
    const updatedAt = nowMs;

    if (status === 'not_applicable') {
      return {
        schemaVersion: 1,
        status,
        rolling: null,
        monthly: null,
        limitedBy: null,
        enforcement: verdict.enforcement === 'preview' ? 'preview' : null,
        updatedAt,
      };
    }

    const rollingRaw = verdict.window;
    const rollingUsed = nonNegativeNumber(rollingRaw.used);
    const rollingLimit = nonNegativeNumber(rollingRaw.limit);
    if (rollingUsed === null || rollingLimit === null) return null;

    let rollingResetAt = null;
    if (status === 'within_limit') {
      const resetsInSeconds = nonNegativeNumber(verdict.resetsInSeconds);
      if (resetsInSeconds !== null) rollingResetAt = updatedAt + resetsInSeconds * 1000;
    } else {
      const retryAfterSeconds = nonNegativeNumber(verdict.retryAfterSeconds);
      const resumesAtMs = nonNegativeNumber(verdict.resumesAtMs);
      if (verdict.limitedBy === 'billing_period' && resumesAtMs !== null) {
        rollingResetAt = resumesAtMs;
      } else if (retryAfterSeconds !== null) {
        rollingResetAt = updatedAt + retryAfterSeconds * 1000;
      } else if (resumesAtMs !== null) {
        rollingResetAt = resumesAtMs;
      }
    }

    const rollingWindow =
      typeof rollingRaw.window === 'string' && rollingRaw.window.length <= 16
        ? rollingRaw.window
        : 'rolling';

    let monthly = null;
    const monthlyRaw = verdict.billingPeriodWindow;
    if (isRecord(monthlyRaw)) {
      const monthlyUsed = nonNegativeNumber(monthlyRaw.used);
      const monthlyLimit = nonNegativeNumber(monthlyRaw.limit);
      const periodEndMs = nonNegativeNumber(monthlyRaw.periodEndMs);
      if (
        monthlyUsed !== null &&
        monthlyLimit !== null &&
        periodEndMs !== null &&
        periodEndMs > nowMs
      ) {
        monthly = {
          used: monthlyUsed,
          limit: monthlyLimit,
          percent: percentage(monthlyUsed, monthlyLimit),
          resetAt: periodEndMs,
        };
      }
    }

    return {
      schemaVersion: 1,
      status,
      rolling: {
        used: rollingUsed,
        limit: rollingLimit,
        percent: percentage(rollingUsed, rollingLimit),
        window: rollingWindow,
        resetAt: rollingResetAt,
      },
      monthly,
      limitedBy:
        verdict.limitedBy === 'rolling' || verdict.limitedBy === 'billing_period'
          ? verdict.limitedBy
          : null,
      enforcement: verdict.enforcement === 'preview' ? 'preview' : null,
      updatedAt,
    };
  }

  function parseIsoTimestamp(value) {
    if (
      typeof value !== 'string' ||
      value.length < 20 ||
      value.length > 80 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/.test(
        value,
      )
    ) {
      return null;
    }
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  function billingDataFromPayload(payload) {
    if (!isRecord(payload)) return null;
    if (isRecord(payload.billingData)) return payload.billingData;
    if (isRecord(payload.data) && isRecord(payload.data.billingData)) {
      return payload.data.billingData;
    }
    return null;
  }

  function itemList(value) {
    if (Array.isArray(value)) return value.slice(0, 80);
    if (isRecord(value)) return Object.values(value).slice(0, 80);
    return [];
  }

  function highestPlanProduct(items) {
    let selected = null;
    let selectedRank = -1;
    for (const item of items) {
      const product = isRecord(item) && isRecord(item.price) ? item.price.product : null;
      const rank = typeof product === 'string' ? PLAN_RANK.get(product) : undefined;
      if (typeof rank === 'number' && rank > selectedRank) {
        selected = product;
        selectedRank = rank;
      }
    }
    return selected;
  }

  function hasUnknownBillingProduct(items) {
    return items.some((item) => {
      const product = isRecord(item) && isRecord(item.price) ? item.price.product : null;
      return typeof product === 'string' && !PLAN_RANK.has(product);
    });
  }

  function normalizeBillingStatus(payload, nowMs = Date.now()) {
    const billingData = billingDataFromPayload(payload);
    if (!billingData) return null;

    const subscription = isRecord(billingData.subscription) ? billingData.subscription : null;
    const separateTrial = isRecord(billingData.trial) ? billingData.trial : null;
    const subscriptionEndRaw = subscription && subscription.trialEnd;
    const separateEndRaw = separateTrial && separateTrial.endDate;
    const hasSubscriptionTrial = typeof subscriptionEndRaw === 'string';
    const hasSeparateTrial = typeof separateEndRaw === 'string';

    // Notion treats these two representations as mutually exclusive.
    if (hasSubscriptionTrial && hasSeparateTrial) return null;
    const clock = isRecord(billingData.clock) ? billingData.clock : null;
    const serverClockRaw = clock && clock.externalId ? clock.now : null;
    const serverClockAt = parseIsoTimestamp(serverClockRaw);
    const usesServerClock = serverClockAt !== null;
    const referenceNowAt = usesServerClock ? serverClockAt : nowMs;

    if (hasSubscriptionTrial || hasSeparateTrial) {
      const endRaw = hasSubscriptionTrial ? subscriptionEndRaw : separateEndRaw;
      const startRaw = hasSubscriptionTrial
        ? subscription && subscription.startDate
        : separateTrial && separateTrial.startDate;
      const endAt = parseIsoTimestamp(endRaw);
      const startAt = parseIsoTimestamp(startRaw);
      if (endAt === null) return null;
      if (typeof startRaw === 'string' && (startAt === null || startAt > endAt)) return null;
      if (endAt - referenceNowAt > 2 * 366 * 86400000) return null;

      const activeItems = hasSubscriptionTrial
        ? itemList(subscription && subscription.items)
        : itemList(separateTrial && separateTrial.items);
      const plan = highestPlanProduct(activeItems);

      if (endAt > referenceNowAt && plan === 'business') {
        return {
          kind: 'trial',
          status: 'active',
          plan,
          startAt,
          endAt,
          autoConvert:
            separateTrial && typeof separateTrial.autoConvert === 'boolean'
              ? separateTrial.autoConvert
              : null,
          usesServerClock,
          referenceNowAt,
          updatedAt: nowMs,
        };
      }
      if (
        endAt > referenceNowAt &&
        (plan === null || hasUnknownBillingProduct(activeItems))
      ) {
        return null;
      }
    }

    if (!subscription) {
      return { kind: 'none', status: 'none', plan: 'free', updatedAt: nowMs };
    }

    const subscriptionItems = itemList(subscription.items);
    const recognizedPlan = highestPlanProduct(subscriptionItems);
    const hasUnknownProduct = hasUnknownBillingProduct(subscriptionItems);
    if (recognizedPlan === 'free' && !hasUnknownProduct) {
      return { kind: 'none', status: 'none', plan: 'free', updatedAt: nowMs };
    }
    const plan = recognizedPlan && recognizedPlan !== 'free' ? recognizedPlan : 'unknown';

    const planItem = subscriptionItems.find(
      (item) =>
        isRecord(item) &&
        isRecord(item.price) &&
        (recognizedPlan ? item.price.product === recognizedPlan : true),
    );
    const currentPeriodEndRaw =
      typeof subscription.currentPeriodEnd === 'string'
        ? subscription.currentPeriodEnd
        : planItem && typeof planItem.currentPeriodEnd === 'string'
          ? planItem.currentPeriodEnd
          : null;
    const currentPeriodEndAt = parseIsoTimestamp(currentPeriodEndRaw);
    const rawStatus =
      typeof subscription.status === 'string' &&
      VALID_SUBSCRIPTION_STATUSES.has(subscription.status)
        ? subscription.status
        : 'unknown';

    return {
      kind: 'subscription',
      status: rawStatus,
      plan,
      currentPeriodEndAt,
      updatedAt: nowMs,
    };
  }

  function normalizeBusinessTrial(payload, nowMs = Date.now()) {
    const normalized = normalizeBillingStatus(payload, nowMs);
    if (!normalized || normalized.kind === 'trial') return normalized;
    return { kind: 'none', status: 'none', plan: 'free', updatedAt: nowMs };
  }

  function localStartOfDay(timestamp) {
    const local = new Date(timestamp);
    if (!Number.isFinite(local.getTime())) return null;
    local.setHours(0, 0, 0, 0);
    return local.getTime();
  }

  function businessTrialReferenceNow(trial, nowMs = Date.now()) {
    if (!trial || trial.status !== 'active') return null;
    if (!trial.usesServerClock) return nowMs;
    if (!Number.isFinite(trial.referenceNowAt) || !Number.isFinite(trial.updatedAt)) return null;
    return trial.referenceNowAt + Math.max(0, nowMs - trial.updatedAt);
  }

  function businessTrialDaysRemaining(trial, nowMs = Date.now()) {
    const referenceNow = businessTrialReferenceNow(trial, nowMs);
    if (referenceNow === null || trial.endAt <= referenceNow) return 0;
    const startOfDay = localStartOfDay(referenceNow);
    if (startOfDay === null) return 0;
    return Math.max(0, Math.ceil((trial.endAt - startOfDay) / 86400000));
  }

  function activeBusinessTrial(trial, nowMs = Date.now()) {
    if (!trial || trial.kind !== 'trial') return null;
    const referenceNow = businessTrialReferenceNow(trial, nowMs);
    return referenceNow !== null && trial.endAt > referenceNow ? trial : null;
  }

  function activeBillingStatus(billingStatus, nowMs = Date.now()) {
    if (!billingStatus) return null;
    if (billingStatus.kind === 'trial') return activeBusinessTrial(billingStatus, nowMs);
    return billingStatus.kind === 'subscription' || billingStatus.kind === 'none'
      ? billingStatus
      : null;
  }

  function businessTrialEndsToday(trial, nowMs = Date.now()) {
    const referenceNow = businessTrialReferenceNow(trial, nowMs);
    if (referenceNow === null || !Number.isFinite(trial.endAt)) return false;
    const today = new Date(referenceNow);
    const end = new Date(trial.endAt);
    return (
      today.getFullYear() === end.getFullYear() &&
      today.getMonth() === end.getMonth() &&
      today.getDate() === end.getDate()
    );
  }

  function endpointKind(url, baseUrl = 'https://app.notion.com/') {
    try {
      const parsed = new URL(url, baseUrl);
      const base = new URL(baseUrl);
      if (parsed.origin !== base.origin) return null;
      if (parsed.pathname === CURRENT_ENDPOINT) return 'current';
      if (parsed.pathname === LEGACY_ENDPOINT) return 'legacy';
      if (parsed.pathname === BILLING_ENDPOINT) return 'billing';
      return null;
    } catch {
      return null;
    }
  }

  function extractSpaceId(bodyText, headers) {
    let parsed = null;
    if (typeof bodyText === 'string' && bodyText.trim()) {
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        parsed = null;
      }
    }

    const candidates = [];
    if (isRecord(parsed)) candidates.push(parsed.spaceId);
    candidates.push(readHeaderValue(headers, 'x-notion-space-id'));

    return (
      candidates.find(
        (candidate) => typeof candidate === 'string' && SPACE_ID_PATTERN.test(candidate),
      ) || null
    );
  }

  function readHeaderValue(headers, wantedName) {
    if (!headers) return null;
    const lowerWantedName = wantedName.toLowerCase();

    try {
      if (typeof headers.get === 'function') return headers.get(lowerWantedName);
      if (Array.isArray(headers)) {
        for (const entry of headers) {
          if (
            Array.isArray(entry) &&
            String(entry[0]).toLowerCase() === lowerWantedName
          ) {
            return String(entry[1]);
          }
        }
        return null;
      }
      if (isRecord(headers)) {
        const matchingKey = Object.keys(headers).find(
          (key) => key.toLowerCase() === lowerWantedName,
        );
        return matchingKey ? String(headers[matchingKey]) : null;
      }
    } catch {
      return null;
    }
    return null;
  }

  function safeHeaders(headers) {
    const result = {};
    if (!headers) return result;

    // Read allow-listed names one by one. Never materialize or iterate values
    // for Cookie, Authorization, prompts, or unrelated application headers.
    for (const name of SAFE_HEADER_NAMES) {
      const value = readHeaderValue(headers, name);
      if (typeof value === 'string' && value.length <= 512) result[name] = value;
    }
    return result;
  }

  function mergeRecipeHeaders(previousHeaders, incomingHeaders, spaceId, reset = false) {
    const merged = reset ? {} : safeHeaders(previousHeaders);
    Object.assign(merged, safeHeaders(incomingHeaders));
    merged['content-type'] = 'application/json';
    merged['x-notion-space-id'] = spaceId;
    return merged;
  }

  function usageRefreshPlan(kind, hasSnapshot, millisecondsSinceNativeCurrent) {
    if (kind === 'legacy' && millisecondsSinceNativeCurrent > 1500) {
      return { reason: 'legacy-space-id', delay: 400 };
    }
    if (hasSnapshot) return null;
    if (kind === 'billing') return { reason: 'billing-space-id', delay: 400 };
    if (kind === 'current') {
      return {
        reason: 'current-response-grace',
        delay: CURRENT_RESPONSE_GRACE_INTERVAL,
      };
    }
    return null;
  }

  function contextTokenMatches(token, context) {
    return Boolean(
      token &&
        context &&
        Number.isSafeInteger(token.sequence) &&
        token.sequence > 0 &&
        token.sequence <= context.acceptedContextSequence &&
        token.contextVersion === context.contextVersion &&
        token.spaceId === context.spaceId &&
        token.activeUserId === context.activeUserId,
    );
  }

  function responseSequenceIsFresh(token, acceptedSequence) {
    return Boolean(
      token &&
        Number.isSafeInteger(token.sequence) &&
        token.sequence > acceptedSequence,
    );
  }

  function activeFailureCanCommit(requestContext, context) {
    return Boolean(
      requestContext &&
        context &&
        requestContext.spaceId === context.spaceId &&
        requestContext.contextVersion === context.contextVersion &&
        context.acceptedCurrentResponseSequence <=
          requestContext.acceptedCurrentResponseSequence,
    );
  }

  function billingFailureCanCommit(requestContext, context) {
    return Boolean(
      requestContext &&
        context &&
        requestContext.spaceId === context.spaceId &&
        requestContext.activeUserId === context.activeUserId &&
        requestContext.contextVersion === context.contextVersion &&
        requestContext.acceptedBillingResponseSequence ===
          context.acceptedBillingResponseSequence,
    );
  }

  function currentUiLanguage() {
    const language =
      root && root.document && root.document.documentElement
        ? root.document.documentElement.lang
        : '';
    return typeof language === 'string' && /^zh(?:-|$)/i.test(language) ? 'zh' : 'en';
  }

  function uiText(chinese, english, language = currentUiLanguage()) {
    return language === 'zh' ? chinese : english;
  }

  function billingFailureMessage(error, language = currentUiLanguage()) {
    const status = finiteNumber(error && error.status);
    if (status === 401 || status === 403) {
      return uiText(
        '无法读取订阅状态：当前账户没有账单数据权限',
        'Subscription status unavailable: this account cannot access billing data',
        language,
      );
    }
    if (status === 429) {
      return uiText(
        '订阅状态请求过于频繁，稍后自动重试',
        'Subscription status request was rate limited; retrying later',
        language,
      );
    }
    if (error && error.name === 'AbortError') {
      return uiText(
        '读取订阅状态超时',
        'Subscription status request timed out',
        language,
      );
    }
    return uiText(
      '暂时无法读取订阅状态',
      'Unable to load subscription status',
      language,
    );
  }

  function cssColorTheme(value) {
    if (typeof value !== 'string') return null;
    const match = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i.exec(
      value,
    );
    if (!match) return null;
    const alpha = match[4] === undefined ? 1 : Number(match[4]);
    if (!Number.isFinite(alpha) || alpha < 0.35) return null;
    const red = clamp(Number(match[1]), 0, 255);
    const green = clamp(Number(match[2]), 0, 255);
    const blue = clamp(Number(match[3]), 0, 255);
    const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
    return luminance < 0.52 ? 'dark' : 'light';
  }

  function currentUiTheme() {
    const documentRef = root && root.document;
    if (!documentRef) return 'light';
    const html = documentRef.documentElement;
    const body = documentRef.body;
    const marker = [
      html && html.className,
      body && body.className,
      html && html.getAttribute('data-theme'),
      body && body.getAttribute('data-theme'),
      html && html.getAttribute('data-mode'),
      body && body.getAttribute('data-mode'),
    ]
      .filter((value) => typeof value === 'string')
      .join(' ');
    if (/(?:^|[\s_-])dark(?:$|[\s_-])/i.test(marker)) return 'dark';
    if (/(?:^|[\s_-])light(?:$|[\s_-])/i.test(marker)) return 'light';

    if (typeof root.getComputedStyle === 'function') {
      const candidates = [
        documentRef.getElementById('notion-app'),
        documentRef.querySelector('.notion-app-inner'),
        body,
        html,
      ];
      if (typeof documentRef.elementFromPoint === 'function' && root.innerWidth && root.innerHeight) {
        let current = documentRef.elementFromPoint(root.innerWidth / 2, root.innerHeight / 2);
        for (let index = 0; current && index < 8; index += 1) {
          candidates.push(current);
          current = current.parentElement;
        }
      }
      const seen = new Set();
      for (const candidate of candidates) {
        if (!candidate || seen.has(candidate)) continue;
        seen.add(candidate);
        try {
          const theme = cssColorTheme(root.getComputedStyle(candidate).backgroundColor);
          if (theme) return theme;
        } catch {
          // Keep checking less specific page surfaces.
        }
      }
      if (body) {
        try {
          const textTheme = cssColorTheme(root.getComputedStyle(body).color);
          if (textTheme === 'light') return 'dark';
          if (textTheme === 'dark') return 'light';
        } catch {
          // Fall through to the system preference only when Notion exposes no usable colors.
        }
      }
    }

    try {
      return root.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  }

  function formatWindowLabel(value) {
    if (value === '6h') return uiText('当前窗口（6 小时）', 'Current window (6h)');
    if (value === '24h') return uiText('当前窗口（24 小时）', 'Current window (24h)');
    return uiText('当前窗口', 'Current window');
  }

  function formatPercent(value) {
    return `${Math.round(clamp(finiteNumber(value) || 0, 0, 100))}%`;
  }

  function formatReset(resetAt, nowMs = Date.now(), language = currentUiLanguage()) {
    if (!Number.isFinite(resetAt)) return uiText('重置时间未知', 'Reset time unavailable', language);
    const difference = resetAt - nowMs;
    if (difference <= 0) return uiText('即将重置', 'Resetting soon', language);

    const totalMinutes = Math.max(1, Math.ceil(difference / 60000));
    if (difference <= 86400000) {
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      if (language === 'zh') {
        if (hours > 0 && minutes > 0) return `${hours} 小时 ${minutes} 分钟后重置`;
        if (hours > 0) return `${hours} 小时后重置`;
        return `${minutes} 分钟后重置`;
      }
      if (hours > 0 && minutes > 0) return `Resets in ${hours}h ${minutes}m`;
      if (hours > 0) return `Resets in ${hours}h`;
      return `Resets in ${minutes}m`;
    }

    const formatted = new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(resetAt));
    return language === 'zh' ? `${formatted} 重置` : `Resets ${formatted}`;
  }

  function formatAbsoluteTime(timestamp, language = currentUiLanguage()) {
    if (!Number.isFinite(timestamp)) return uiText('未知', 'Unknown', language);
    return new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(timestamp));
  }

  function formatUpdated(timestamp, nowMs = Date.now(), language = currentUiLanguage()) {
    if (!Number.isFinite(timestamp)) return uiText('尚未更新', 'Not updated yet', language);
    const elapsedSeconds = Math.max(0, Math.floor((nowMs - timestamp) / 1000));
    if (language === 'zh') {
      if (elapsedSeconds < 10) return '刚刚更新';
      if (elapsedSeconds < 60) return `${elapsedSeconds} 秒前更新`;
      if (elapsedSeconds < 3600) return `${Math.floor(elapsedSeconds / 60)} 分钟前更新`;
      return `${Math.floor(elapsedSeconds / 3600)} 小时前更新`;
    }
    if (elapsedSeconds < 10) return 'Updated just now';
    if (elapsedSeconds < 60) return `Updated ${elapsedSeconds}s ago`;
    if (elapsedSeconds < 3600) return `Updated ${Math.floor(elapsedSeconds / 60)}m ago`;
    return `Updated ${Math.floor(elapsedSeconds / 3600)}h ago`;
  }

  function pollingInterval(snapshot) {
    if (!snapshot) return 60000;
    if (snapshot.status === 'not_applicable') return 6 * 60 * 60 * 1000;
    return 60000;
  }

  function parseLegacyOverlayPosition(raw) {
    if (typeof raw !== 'string' || raw.length === 0) return null;
    try {
      const parsed = JSON.parse(raw);
      if (!isRecord(parsed) || parsed.v !== 1) return null;
      if (
        typeof parsed.left !== 'number' ||
        !Number.isFinite(parsed.left) ||
        typeof parsed.top !== 'number' ||
        !Number.isFinite(parsed.top)
      ) {
        return null;
      }
      const position = { left: parsed.left, top: parsed.top };
      if (parsed.side === 'left' || parsed.side === 'right') position.side = parsed.side;
      if (parsed.verticalSide === 'up' || parsed.verticalSide === 'down') {
        position.verticalSide = parsed.verticalSide;
      }
      return position;
    } catch {
      return null;
    }
  }

  function normalizeOverlayAnchor(anchor, roundOffsets = false) {
    if (
      !isRecord(anchor) ||
      (anchor.xEdge !== 'left' && anchor.xEdge !== 'right') ||
      (anchor.yEdge !== 'top' && anchor.yEdge !== 'bottom') ||
      (anchor.side !== 'left' && anchor.side !== 'right') ||
      (anchor.verticalSide !== 'up' && anchor.verticalSide !== 'down')
    ) {
      return null;
    }
    if (
      typeof anchor.xOffset !== 'number' ||
      !Number.isFinite(anchor.xOffset) ||
      anchor.xOffset < 0 ||
      typeof anchor.yOffset !== 'number' ||
      !Number.isFinite(anchor.yOffset) ||
      anchor.yOffset < 0
    ) {
      return null;
    }
    return {
      xEdge: anchor.xEdge,
      xOffset: roundOffsets ? Math.round(anchor.xOffset) : anchor.xOffset,
      yEdge: anchor.yEdge,
      yOffset: roundOffsets ? Math.round(anchor.yOffset) : anchor.yOffset,
      side: anchor.side,
      verticalSide: anchor.verticalSide,
    };
  }

  function overlayPositionRecord(anchor) {
    const normalized = normalizeOverlayAnchor(anchor, true);
    return normalized ? { v: 2, ...normalized } : null;
  }

  function serializeOverlayPosition(anchor) {
    const record = overlayPositionRecord(anchor);
    return record ? JSON.stringify(record) : null;
  }

  function parseOverlayPosition(raw) {
    if (typeof raw !== 'string' || raw.length === 0) return null;
    try {
      const parsed = JSON.parse(raw);
      if (!isRecord(parsed) || parsed.v !== 2 || parsed.scope !== undefined) return null;
      return normalizeOverlayAnchor(parsed);
    } catch {
      return null;
    }
  }

  function legacyOverlayPositionScope(key) {
    if (typeof key !== 'string' || !key.startsWith(LEGACY_POSITION_KEY_PREFIX)) {
      return null;
    }
    const scope = key.slice(LEGACY_POSITION_KEY_PREFIX.length);
    return LEGACY_POSITION_SCOPE_PATTERN.test(scope) ? scope : null;
  }

  function parseLegacyV2OverlayPosition(key, raw) {
    const scope = legacyOverlayPositionScope(key);
    if (!scope || typeof raw !== 'string' || raw.length === 0) return null;
    try {
      const parsed = JSON.parse(raw);
      if (!isRecord(parsed) || parsed.v !== 2 || parsed.scope !== scope) return null;
      return normalizeOverlayAnchor(parsed);
    } catch {
      return null;
    }
  }

  function orderedLegacyPositionEntries(entries) {
    if (!Array.isArray(entries)) return [];
    return entries
      .filter((entry) => isRecord(entry) && legacyOverlayPositionScope(entry.key))
      .slice()
      .sort((left, right) => {
        const leftScope = legacyOverlayPositionScope(left.key);
        const rightScope = legacyOverlayPositionScope(right.key);
        const leftRank = leftScope.startsWith('embedded-')
          ? 0
          : leftScope === 'embedded'
            ? 1
            : 2;
        const rightRank = rightScope.startsWith('embedded-')
          ? 0
          : rightScope === 'embedded'
            ? 1
            : 2;
        if (leftRank !== rightRank) return leftRank - rightRank;
        if (left.key === right.key) return 0;
        return left.key > right.key ? -1 : 1;
      });
  }

  function selectStoredOverlayPosition(canonicalRaw, legacyV2Entries, legacyRaw) {
    const canonical = parseOverlayPosition(canonicalRaw);
    if (canonical) return { kind: 'anchor', source: 'canonical', anchor: canonical };
    for (const entry of orderedLegacyPositionEntries(legacyV2Entries)) {
      const anchor = parseLegacyV2OverlayPosition(entry.key, entry.raw);
      if (anchor) return { kind: 'anchor', source: 'legacy-v2', anchor };
    }
    const position = parseLegacyOverlayPosition(legacyRaw);
    return position ? { kind: 'legacy', source: 'legacy-v1', position } : null;
  }

  function overlayAnchorFromRect(
    rect,
    viewport,
    preferredXEdge = null,
    preferredYEdge = null,
  ) {
    const viewportWidth = Math.max(0, finiteNumber(viewport && viewport.width) || 0);
    const viewportHeight = Math.max(0, finiteNumber(viewport && viewport.height) || 0);
    const left = finiteNumber(rect && rect.left) || 0;
    const top = finiteNumber(rect && rect.top) || 0;
    const width = Math.max(0, finiteNumber(rect && rect.width) || 0);
    const height = Math.max(0, finiteNumber(rect && rect.height) || 0);
    const right = finiteNumber(rect && rect.right);
    const bottom = finiteNumber(rect && rect.bottom);
    const safeRight = right === null ? left + width : right;
    const safeBottom = bottom === null ? top + height : bottom;
    const leftOffset = Math.max(0, left);
    const rightOffset = Math.max(0, viewportWidth - safeRight);
    const topOffset = Math.max(0, top);
    const bottomOffset = Math.max(0, viewportHeight - safeBottom);
    const xEdge =
      preferredXEdge === 'left' || preferredXEdge === 'right'
        ? preferredXEdge
        : leftOffset <= rightOffset
          ? 'left'
          : 'right';
    const yEdge =
      preferredYEdge === 'top' || preferredYEdge === 'bottom'
        ? preferredYEdge
        : topOffset <= bottomOffset
          ? 'top'
          : 'bottom';
    return {
      xEdge,
      xOffset: xEdge === 'left' ? leftOffset : rightOffset,
      yEdge,
      yOffset: yEdge === 'top' ? topOffset : bottomOffset,
    };
  }

  function overlayPositionFromAnchor(
    anchor,
    viewport,
    overlay,
    summary,
    inset = POSITION_INSET,
  ) {
    const viewportWidth = Math.max(0, finiteNumber(viewport && viewport.width) || 0);
    const viewportHeight = Math.max(0, finiteNumber(viewport && viewport.height) || 0);
    const summaryWidth = Math.max(0, finiteNumber(summary && summary.width) || 0);
    const summaryHeight = Math.max(0, finiteNumber(summary && summary.height) || 0);
    const summaryOffsetLeft = finiteNumber(summary && summary.offsetLeft) || 0;
    const summaryOffsetTop = finiteNumber(summary && summary.offsetTop) || 0;
    const xOffset = nonNegativeNumber(anchor && anchor.xOffset);
    const yOffset = nonNegativeNumber(anchor && anchor.yOffset);
    const safeXOffset = xOffset === null ? POSITION_INSET : xOffset;
    const safeYOffset = yOffset === null ? POSITION_INSET : yOffset;
    const summaryLeft =
      anchor && anchor.xEdge === 'left'
        ? safeXOffset
        : viewportWidth - safeXOffset - summaryWidth;
    const summaryTop =
      anchor && anchor.yEdge === 'top'
        ? safeYOffset
        : viewportHeight - safeYOffset - summaryHeight;
    return clampOverlayPosition(
      {
        left: summaryLeft - summaryOffsetLeft,
        top: summaryTop - summaryOffsetTop,
      },
      viewport,
      overlay,
      inset,
    );
  }

  function responsiveOverlayVerticalSide(
    anchor,
    summary,
    requiredHeight,
    viewport,
    expanded = true,
  ) {
    const storedSide = anchor && anchor.verticalSide === 'up' ? 'up' : 'down';
    if (!expanded) return storedSide;
    const summaryWidth = Math.max(0, finiteNumber(summary && summary.width) || 0);
    const summaryHeight = Math.max(0, finiteNumber(summary && summary.height) || 0);
    const target = overlayPositionFromAnchor(
      anchor,
      viewport,
      { width: summaryWidth, height: summaryHeight },
      { width: summaryWidth, height: summaryHeight, offsetLeft: 0, offsetTop: 0 },
      POSITION_INSET,
    );
    const viewportHeight = Math.max(0, finiteNumber(viewport && viewport.height) || 0);
    const safeRequiredHeight = Math.max(0, finiteNumber(requiredHeight) || 0);
    const spaceAbove = Math.max(0, target.top - POSITION_INSET);
    const spaceBelow = Math.max(
      0,
      viewportHeight - target.top - summaryHeight - POSITION_INSET,
    );
    if (storedSide === 'up' && safeRequiredHeight <= spaceAbove) return 'up';
    if (storedSide === 'down' && safeRequiredHeight <= spaceBelow) return 'down';
    if (safeRequiredHeight <= spaceBelow) return 'down';
    if (safeRequiredHeight <= spaceAbove) return 'up';
    return spaceAbove > spaceBelow ? 'up' : 'down';
  }

  function clampOverlayPosition(position, viewport, overlay, inset = POSITION_INSET) {
    const parsedInset = nonNegativeNumber(inset);
    const safeInset = parsedInset === null ? POSITION_INSET : parsedInset;
    const viewportWidth = Math.max(0, finiteNumber(viewport && viewport.width) || 0);
    const viewportHeight = Math.max(0, finiteNumber(viewport && viewport.height) || 0);
    const overlayWidth = Math.max(0, finiteNumber(overlay && overlay.width) || 0);
    const overlayHeight = Math.max(0, finiteNumber(overlay && overlay.height) || 0);
    const maximumLeft = Math.max(safeInset, viewportWidth - overlayWidth - safeInset);
    const maximumTop = Math.max(safeInset, viewportHeight - overlayHeight - safeInset);
    const requestedLeft = finiteNumber(position && position.left);
    const requestedTop = finiteNumber(position && position.top);
    return {
      left: clamp(requestedLeft === null ? safeInset : requestedLeft, safeInset, maximumLeft),
      top: clamp(requestedTop === null ? safeInset : requestedTop, safeInset, maximumTop),
    };
  }

  function minimizedDockPosition(
    composerRect,
    orb,
    viewport,
    bottomInset = COMPOSER_DOCK_INSET,
    viewportInset = POSITION_INSET,
  ) {
    const left = finiteNumber(composerRect && composerRect.left);
    const top = finiteNumber(composerRect && composerRect.top);
    const rawWidth = finiteNumber(composerRect && composerRect.width);
    const rawHeight = finiteNumber(composerRect && composerRect.height);
    const rawRight = finiteNumber(composerRect && composerRect.right);
    const rawBottom = finiteNumber(composerRect && composerRect.bottom);
    const width = rawWidth === null && left !== null && rawRight !== null
      ? rawRight - left
      : rawWidth;
    const height = rawHeight === null && top !== null && rawBottom !== null
      ? rawBottom - top
      : rawHeight;
    const orbWidth = Math.max(0, finiteNumber(orb && orb.width) || 0);
    const orbHeight = Math.max(0, finiteNumber(orb && orb.height) || 0);
    if (
      left === null ||
      top === null ||
      width === null ||
      height === null ||
      width <= 0 ||
      height <= 0 ||
      orbWidth <= 0 ||
      orbHeight <= 0
    ) {
      return null;
    }

    const right = rawRight === null ? left + width : rawRight;
    const bottom = rawBottom === null ? top + height : rawBottom;
    const parsedBottomInset = nonNegativeNumber(bottomInset);
    const safeBottomInset = parsedBottomInset === null
      ? COMPOSER_DOCK_INSET
      : parsedBottomInset;
    const innerInset = Math.min(6, Math.max(2, width / 8));
    const minimumLeft = left + innerInset;
    const maximumLeft = Math.max(minimumLeft, right - orbWidth - innerInset);
    const minimumTop = top + Math.min(4, Math.max(0, height - orbHeight));
    const maximumTop = Math.max(minimumTop, bottom - orbHeight - 4);
    const insideComposer = {
      left: clamp(left + (width - orbWidth) / 2, minimumLeft, maximumLeft),
      top: clamp(bottom - orbHeight - safeBottomInset, minimumTop, maximumTop),
    };
    return clampOverlayPosition(
      insideComposer,
      viewport,
      { width: orbWidth, height: orbHeight },
      viewportInset,
    );
  }

  function composerCandidateEligible(editorSignals, containerSignals) {
    return Boolean(
      (editorSignals && editorSignals.semantic) ||
      (containerSignals && containerSignals.aiQualified),
    );
  }

  function composerSemanticText(value) {
    return typeof value === 'string' && COMPOSER_SEMANTIC_PATTERN.test(value);
  }

  function dragThresholdReached(previouslyDragged, start, current, threshold = DRAG_THRESHOLD) {
    if (previouslyDragged) return true;
    const startX = finiteNumber(start && start.x);
    const startY = finiteNumber(start && start.y);
    const currentX = finiteNumber(current && current.x);
    const currentY = finiteNumber(current && current.y);
    const parsedThreshold = nonNegativeNumber(threshold);
    if (startX === null || startY === null || currentX === null || currentY === null) return false;
    const safeThreshold = parsedThreshold === null ? DRAG_THRESHOLD : parsedThreshold;
    const deltaX = currentX - startX;
    const deltaY = currentY - startY;
    return deltaX * deltaX + deltaY * deltaY >= safeThreshold * safeThreshold;
  }

  function dragPosition(origin, start, current, viewport, overlay, inset = POSITION_INSET) {
    const originLeft = finiteNumber(origin && origin.left);
    const originTop = finiteNumber(origin && origin.top);
    const startX = finiteNumber(start && start.x);
    const startY = finiteNumber(start && start.y);
    const currentX = finiteNumber(current && current.x);
    const currentY = finiteNumber(current && current.y);
    return clampOverlayPosition(
      {
        left:
          (originLeft === null ? 0 : originLeft) +
          (currentX === null || startX === null ? 0 : currentX - startX),
        top:
          (originTop === null ? 0 : originTop) +
          (currentY === null || startY === null ? 0 : currentY - startY),
      },
      viewport,
      overlay,
      inset,
    );
  }

  function summaryClickTransition(expanded, suppressNextClick) {
    return {
      expanded: suppressNextClick ? Boolean(expanded) : !expanded,
      suppressNextClick: false,
    };
  }

  const testExports = {
    BILLING_ENDPOINT,
    CURRENT_ENDPOINT,
    LEGACY_ENDPOINT,
    LEGACY_POSITION_KEY,
    LEGACY_POSITION_KEY_PREFIX,
    POSITION_KEY,
    activeFailureCanCommit,
    activeBillingStatus,
    activeBusinessTrial,
    billingFailureMessage,
    billingSummaryPart,
    billingDataFromPayload,
    billingFailureCanCommit,
    businessTrialDaysRemaining,
    businessTrialEndsToday,
    endpointKind,
    extractSpaceId,
    fetchMetadata,
    findCreditVerdict,
    formatPercent,
    formatReset,
    formatUpdated,
    isNotionPageUrl,
    clampOverlayPosition,
    compactUsagePercent,
    compactUsagePresentation,
    composerCandidateEligible,
    composerSemanticText,
    contextTokenMatches,
    cssColorTheme,
    currentUiLanguage,
    currentUiTheme,
    dragPosition,
    dragThresholdReached,
    normalizeBillingStatus,
    normalizeOverlayAnchor,
    normalizeVerdict,
    normalizeBusinessTrial,
    overlayAnchorFromRect,
    overlayPositionRecord,
    overlayPositionFromAnchor,
    orderedLegacyPositionEntries,
    percentage,
    parseLegacyOverlayPosition,
    parseLegacyV2OverlayPosition,
    parseOverlayPosition,
    planDisplayName,
    pollingInterval,
    preferredVerticalSide,
    mergeRecipeHeaders,
    minimizedDockPosition,
    requestBodyText,
    responsiveOverlayVerticalSide,
    responseSequenceIsFresh,
    safeHeaders,
    serializeOverlayPosition,
    selectStoredOverlayPosition,
    shouldBootstrapInFrame,
    subscriptionStatusText,
    summaryClickTransition,
    uiText,
    usageRefreshPlan,
  };

  if (
    typeof document === 'undefined' &&
    typeof module === 'object' &&
    module &&
    module.exports &&
    typeof require === 'function'
  ) {
    module.exports = testExports;
    return;
  }

  if (
    !root ||
    !root.document ||
    !shouldBootstrapInFrame(root) ||
    root.__notionAiUsageUserscriptV1
  ) return;
  root.__notionAiUsageUserscriptV1 = true;

  const runtime = {
    nativeFetch: typeof root.fetch === 'function' ? root.fetch : null,
    snapshot: null,
    billingStatus: null,
    spaceId: null,
    activeUserId: null,
    recipeHeaders: {},
    fetching: false,
    lastAttemptAt: 0,
    lastFetchedAt: 0,
    lastNativeCurrentAt: 0,
    nextAllowedAt: 0,
    backoffMs: 0,
    activeRefreshDisabled: false,
    activeController: null,
    billingFetching: false,
    billingRefreshDisabled: false,
    billingController: null,
    lastBillingAttemptAt: 0,
    lastBillingFetchedAt: 0,
    billingBackoffUntil: 0,
    refreshToken: 0,
    billingRefreshToken: 0,
    requestSequence: 0,
    acceptedContextSequence: 0,
    acceptedCurrentResponseSequence: 0,
    acceptedBillingResponseSequence: 0,
    contextVersion: 0,
    refreshTimer: null,
    refreshDueAt: 0,
    billingRefreshTimer: null,
    billingRefreshDueAt: 0,
    error: '',
    billingError: '',
    positionError: '',
    positionAnchor: null,
    positionLoadStatus: 'unloaded',
    positionRetryAt: 0,
    pendingExternalAnchor: null,
    dockFrame: null,
    dockTimer: null,
    dockLastScanAt: 0,
    ui: null,
  };

  function warn(message) {
    try {
      root.console.warn(`${SCRIPT_PREFIX} ${message}`);
    } catch {
      // Ignore logging failures.
    }
  }

  function currentErrorText() {
    return [runtime.error, runtime.billingError, runtime.positionError]
      .filter((message) => typeof message === 'string' && message.length > 0)
      .join(uiText('；', '; '));
  }

  function viewportSize() {
    const documentElement = root.document && root.document.documentElement;
    return {
      width: Math.max(
        0,
        finiteNumber(root.innerWidth) ||
          finiteNumber(documentElement && documentElement.clientWidth) ||
          0,
      ),
      height: Math.max(
        0,
        finiteNumber(root.innerHeight) ||
          finiteNumber(documentElement && documentElement.clientHeight) ||
          0,
      ),
    };
  }

  function persistOverlayPosition(anchor = runtime.positionAnchor) {
    const normalized = normalizeOverlayAnchor(anchor, true);
    if (!normalized || !runtime.ui) return false;
    runtime.positionAnchor = normalized;
    runtime.ui.positionAnchor = normalized;
    runtime.pendingExternalAnchor = null;
    runtime.positionLoadStatus = 'loaded';
    const serialized = serializeOverlayPosition(normalized);
    if (!serialized) return false;
    try {
      const hadPositionError = Boolean(runtime.positionError);
      root.localStorage.setItem(POSITION_KEY, serialized);
      if (root.localStorage.getItem(POSITION_KEY) !== serialized) {
        runtime.positionError = uiText(
          '位置未能写入网页本地存储。',
          'Position could not be written to page localStorage.',
        );
        warn('Position storage verification failed; the current page may use ephemeral storage.');
        render();
        return false;
      }
      runtime.positionError = '';
      if (hadPositionError) render();
      return true;
    } catch {
      runtime.positionError = uiText(
        '此页面不允许保存悬浮窗位置。',
        'This page does not allow the overlay position to be saved.',
      );
      warn('Position could not be saved to this page localStorage.');
      render();
      return false;
    }
  }

  function legacyV2StorageEntries(storage) {
    const entries = [];
    const seen = new Set();
    const add = (key) => {
      if (!legacyOverlayPositionScope(key) || seen.has(key)) return;
      seen.add(key);
      try {
        entries.push({ key, raw: storage.getItem(key) });
      } catch {
        // Continue with any legacy candidates that remain readable.
      }
    };
    try {
      const length = Math.max(0, Math.floor(finiteNumber(storage.length) || 0));
      for (let index = 0; index < length; index += 1) add(storage.key(index));
    } catch {
      // Some storage proxies do not expose key enumeration.
    }
    add(`${LEGACY_POSITION_KEY_PREFIX}embedded`);
    add(`${LEGACY_POSITION_KEY_PREFIX}top`);
    return entries;
  }

  function storedOverlayPosition() {
    try {
      return selectStoredOverlayPosition(
        root.localStorage.getItem(POSITION_KEY),
        legacyV2StorageEntries(root.localStorage),
        root.localStorage.getItem(LEGACY_POSITION_KEY),
      );
    } catch {
      return { kind: 'unavailable' };
    }
  }

  function overlaySide(rect, viewport = viewportSize()) {
    if (!rect) return 'right';
    return rect.left + rect.width / 2 <= viewport.width / 2 ? 'left' : 'right';
  }

  function preferredVerticalSide(summaryRect, requiredHeight, viewport = viewportSize()) {
    if (!summaryRect) return 'down';
    const safeRequiredHeight = Math.max(0, finiteNumber(requiredHeight) || 0);
    const spaceAbove = Math.max(0, summaryRect.top - POSITION_INSET);
    const spaceBelow = Math.max(0, viewport.height - summaryRect.bottom - POSITION_INSET);
    if (safeRequiredHeight <= spaceBelow) return 'down';
    if (safeRequiredHeight <= spaceAbove) return 'up';
    return spaceAbove > spaceBelow ? 'up' : 'down';
  }

  function applyOverlayPosition(position, options = {}) {
    const ui = runtime.ui;
    if (!ui) return null;
    const rect = ui.host.getBoundingClientRect();
    const viewport = viewportSize();
    const clamped = clampOverlayPosition(
      position,
      viewport,
      { width: rect.width, height: rect.height },
      POSITION_INSET,
    );
    const normalized = {
      left: Math.round(clamped.left),
      top: Math.round(clamped.top),
    };
    ui.host.style.left = `${normalized.left}px`;
    ui.host.style.top = `${normalized.top}px`;
    ui.host.style.right = 'auto';
    ui.host.style.bottom = 'auto';
    ui.position = normalized;
    ui.host.dataset.side =
      options.side === 'left' || options.side === 'right'
        ? options.side
        : overlaySide(
            { left: normalized.left, width: rect.width },
            viewport,
          );
    return normalized;
  }

  function composerAttributeText(element) {
    if (!element || typeof element.getAttribute !== 'function') return '';
    const names = [
      'aria-label',
      'aria-placeholder',
      'placeholder',
      'data-placeholder',
      'data-testid',
      'id',
      'class',
    ];
    return names
      .map((name) => element.getAttribute(name) || '')
      .join(' ')
      .slice(0, 1200);
  }

  function visibleElementRect(element, options = {}) {
    if (!element || element.isConnected === false || typeof element.getBoundingClientRect !== 'function') {
      return null;
    }
    try {
      if (
        typeof element.closest === 'function' &&
        element.closest('[aria-hidden="true"], [inert]')
      ) {
        return null;
      }
    } catch {
      // Visibility can still be established from layout and computed style.
    }
    try {
      if (typeof root.getComputedStyle === 'function') {
        const style = root.getComputedStyle(element);
        const opacity = finiteNumber(style && style.opacity);
        if (
          !style ||
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          style.contentVisibility === 'hidden' ||
          (opacity !== null && opacity <= 0.02)
        ) {
          return null;
        }
      }
    } catch {
      // A usable client rect is enough when computed style is unavailable.
    }
    const rect = element.getBoundingClientRect();
    const width = Math.max(0, finiteNumber(rect && rect.width) || 0);
    const height = Math.max(0, finiteNumber(rect && rect.height) || 0);
    const left = finiteNumber(rect && rect.left);
    const top = finiteNumber(rect && rect.top);
    if (left === null || top === null || width <= 0 || height <= 0) return null;
    const right = finiteNumber(rect && rect.right);
    const bottom = finiteNumber(rect && rect.bottom);
    const normalized = {
      left,
      top,
      right: right === null ? left + width : right,
      bottom: bottom === null ? top + height : bottom,
      width,
      height,
    };
    const viewport = viewportSize();
    const minimumWidth = Math.max(0, finiteNumber(options.minimumWidth) || 0);
    const maximumHeight = finiteNumber(options.maximumHeight);
    if (
      width < minimumWidth ||
      (maximumHeight !== null && height > maximumHeight) ||
      normalized.right <= 0 ||
      normalized.bottom <= 0 ||
      normalized.left >= viewport.width ||
      normalized.top >= viewport.height
    ) {
      return null;
    }
    return normalized;
  }

  function composerEditorSignals(editor) {
    const tagName = String(editor && editor.tagName || '').toLowerCase();
    const role = editor && typeof editor.getAttribute === 'function'
      ? editor.getAttribute('role')
      : '';
    const semantic = composerSemanticText(composerAttributeText(editor));
    const lexical = Boolean(
      editor &&
      typeof editor.hasAttribute === 'function' &&
      editor.hasAttribute('data-lexical-editor'),
    );
    return {
      semantic,
      lexical,
      textarea: tagName === 'textarea',
      textbox: role === 'textbox',
    };
  }

  function isNotionAiRoute() {
    try {
      const pathname =
        typeof root.location.pathname === 'string'
          ? root.location.pathname
          : new URL(root.location.href).pathname;
      return /^\/ai(?:\/|$)/.test(pathname);
    } catch {
      return false;
    }
  }

  function composerVisualSurface(element, rect, editorRect) {
    const viewport = viewportSize();
    if (
      !element ||
      !rect ||
      rect.width < 260 ||
      rect.height < 50 ||
      rect.height > 220 ||
      rect.width > viewport.width * 0.92 ||
      rect.height > viewport.height * 0.4 ||
      editorRect.left < rect.left - 4 ||
      editorRect.right > rect.right + 4 ||
      editorRect.top < rect.top - 4 ||
      editorRect.bottom > rect.bottom + 4
    ) {
      return false;
    }
    let style;
    try {
      style = root.getComputedStyle(element);
    } catch {
      return false;
    }
    const radius = Number.parseFloat(style && style.borderRadius) || 0;
    const borderWidth = Number.parseFloat(style && style.borderTopWidth) || 0;
    const background = String(style && style.backgroundColor || '').replace(/\s+/g, '');
    const hasBackground =
      background.length > 0 &&
      background !== 'transparent' &&
      background !== 'rgba(0,0,0,0)';
    const hasSurface =
      radius >= 6 &&
      (borderWidth > 0 ||
        (style && style.boxShadow && style.boxShadow !== 'none') ||
        (style && style.outlineStyle && style.outlineStyle !== 'none') ||
        hasBackground);
    const centerDistance = Math.abs(rect.left + rect.width / 2 - viewport.width / 2);
    const nearPageCenter = centerDistance < viewport.width * 0.3;
    const avoidsSidebar = viewport.width < 700 || rect.left > Math.min(360, viewport.width * 0.34);
    let inAiSurface = false;
    try {
      inAiSurface = Boolean(
        typeof element.closest === 'function' && element.closest('[role="dialog"], aside'),
      );
    } catch {
      // Geometry remains the primary surface signal.
    }
    return hasSurface && ((nearPageCenter && avoidsSidebar) || inAiSurface);
  }

  function composerButtonSignal(container) {
    if (!container || typeof container.querySelectorAll !== 'function') {
      return { any: false, send: false };
    }
    let buttons;
    try {
      buttons = Array.from(container.querySelectorAll('button, [role="button"]')).slice(0, 36);
    } catch {
      return { any: false, send: false };
    }
    let any = false;
    for (const button of buttons) {
      if (!visibleElementRect(button)) continue;
      any = true;
      const type = typeof button.getAttribute === 'function'
        ? button.getAttribute('type')
        : '';
      const text = `${composerAttributeText(button)} ${button.textContent || ''}`.slice(0, 800);
      if (type === 'submit' || COMPOSER_SEND_PATTERN.test(text)) {
        return { any: true, send: true };
      }
    }
    return { any, send: false };
  }

  function composerContainerForEditor(editor, editorRect) {
    let current = editor;
    let sawAiSemantic = composerSemanticText(composerAttributeText(editor));
    let best = {
      element: editor,
      rect: editorRect,
      score: 0,
      aiQualified: sawAiSemantic,
    };
    for (let depth = 0; current && depth < 8; depth += 1) {
      const rect = visibleElementRect(current, {
        minimumWidth: Math.max(160, editorRect.width - 8),
        maximumHeight: 320,
      });
      if (rect) {
        const attributes = composerAttributeText(current);
        const semantic = composerSemanticText(attributes);
        if (semantic) sawAiSemantic = true;
        const structural = COMPOSER_STRUCTURE_PATTERN.test(attributes);
        const tagName = String(current.tagName || '').toLowerCase();
        const buttons = composerButtonSignal(current);
        const visualSurface = composerVisualSurface(current, rect, editorRect);
        const bottomSpace = Math.max(0, rect.bottom - editorRect.bottom);
        const horizontalSpace = Math.max(0, rect.width - editorRect.width);
        let score = depth === 0 ? 0 : 8;
        if (semantic) score += 76;
        else if (structural) score += 10;
        if (visualSurface) score += 58;
        if (tagName === 'form') score += 54;
        if (buttons.send) score += 70;
        else if (buttons.any) score += 12;
        if (bottomSpace >= 24 && bottomSpace <= 110) score += 30;
        else if (bottomSpace >= 8 && bottomSpace <= 150) score += 16;
        if (horizontalSpace >= 8 && horizontalSpace <= 280) score += 12;
        if (rect.height >= 48 && rect.height <= 220) score += 14;
        if (rect.width > editorRect.width + 480) score -= 24;
        score -= depth;
        if (score > best.score) {
          best = {
            element: current,
            rect,
            score,
            aiQualified: semantic || (isNotionAiRoute() && visualSurface),
          };
        }
      }
      if (current === root.document.body || !current.parentElement) break;
      current = current.parentElement;
    }
    if (sawAiSemantic) best.aiQualified = true;
    return best;
  }

  function findNotionAiComposer(ui = runtime.ui) {
    if (!ui || !root.document || typeof root.document.querySelectorAll !== 'function') return null;
    const activeElement = root.document.activeElement;
    if (ui.dockComposer && ui.dockEditor) {
      const editorRect = visibleElementRect(ui.dockEditor, {
        minimumWidth: 180,
        maximumHeight: 240,
      });
      const composerRect = visibleElementRect(ui.dockComposer, {
        minimumWidth: 180,
        maximumHeight: 320,
      });
      const activeSignals = composerEditorSignals(activeElement);
      const activeIsAnotherComposer =
        activeElement &&
        activeElement !== ui.host &&
        !(typeof ui.host.contains === 'function' && ui.host.contains(activeElement)) &&
        activeElement !== ui.dockEditor &&
        activeSignals.semantic;
      if (editorRect && composerRect && !activeIsAnotherComposer) {
        return { editor: ui.dockEditor, element: ui.dockComposer, rect: composerRect };
      }
    }

    let editorNodes;
    try {
      editorNodes = Array.from(root.document.querySelectorAll(COMPOSER_EDITOR_SELECTOR));
    } catch {
      return null;
    }
    if (editorNodes.length > 240) {
      editorNodes = editorNodes.slice(0, 32).concat(editorNodes.slice(-208));
    }
    if (activeElement && !editorNodes.includes(activeElement)) {
      const activeSignals = composerEditorSignals(activeElement);
      if (
        activeSignals.semantic ||
        activeSignals.textarea ||
        activeSignals.textbox ||
        activeSignals.lexical
      ) {
        editorNodes.push(activeElement);
      }
    }

    const viewport = viewportSize();
    let selected = null;
    for (const editor of editorNodes) {
      if (editor === ui.host || (typeof ui.host.contains === 'function' && ui.host.contains(editor))) {
        continue;
      }
      if (editor.disabled || editor.readOnly) continue;
      const editorRect = visibleElementRect(editor, {
        minimumWidth: 180,
        maximumHeight: 240,
      });
      if (!editorRect || editorRect.bottom < viewport.height * 0.35) continue;
      const signals = composerEditorSignals(editor);
      const container = composerContainerForEditor(editor, editorRect);
      if (!composerCandidateEligible(signals, container)) {
        continue;
      }
      const active =
        activeElement === editor ||
        (typeof editor.contains === 'function' && editor.contains(activeElement));
      let score = container.score;
      if (signals.semantic) score += 110;
      if (signals.textarea) score += 48;
      if (signals.textbox) score += 44;
      if (signals.lexical) score += 24;
      if (active) score += 130;
      score += clamp((editorRect.bottom / Math.max(1, viewport.height)) * 44, 0, 44);
      score += clamp((editorRect.width / Math.max(1, viewport.width)) * 18, 0, 18);
      try {
        if (typeof editor.closest === 'function' && editor.closest('[role="dialog"], aside')) {
          score += 16;
        }
      } catch {
        // Dialog context is only a ranking hint.
      }
      if (!selected || score > selected.score) {
        selected = {
          editor,
          element: container.element,
          rect: container.rect,
          score,
        };
      }
    }
    return selected;
  }

  function disconnectComposerResizeObserver(ui) {
    if (ui && ui.dockResizeObserver) {
      ui.dockResizeObserver.disconnect();
      ui.dockResizeObserver = null;
    }
  }

  function observeDockMutationTarget(ui, target) {
    if (!ui || !ui.dockMutationObserver || !target || ui.dockMutationTarget === target) return;
    ui.dockMutationObserver.disconnect();
    ui.dockMutationObserver.observe(target, { childList: true, subtree: true });
    ui.dockMutationTarget = target;
  }

  function watchDockComposer(ui, match) {
    if (!ui || !match) return;
    if (ui.dockComposer === match.element && ui.dockEditor === match.editor) return;
    disconnectComposerResizeObserver(ui);
    ui.dockComposer = match.element;
    ui.dockEditor = match.editor;
    const parent = match.element.parentElement;
    observeDockMutationTarget(ui, (parent && parent.parentElement) || parent || match.element);
    if (typeof root.ResizeObserver !== 'function') return;
    ui.dockResizeObserver = new root.ResizeObserver(() => {
      if (runtime.ui === ui && ui.minimized) scheduleMinimizedDock();
    });
    ui.dockResizeObserver.observe(match.element);
  }

  function clearComposerDock(ui, clearTarget = true) {
    if (!ui) return;
    if (typeof ui.host.removeAttribute === 'function') {
      ui.host.removeAttribute('data-docked');
    } else if (ui.host.dataset) {
      delete ui.host.dataset.docked;
    }
    if (!clearTarget) return;
    disconnectComposerResizeObserver(ui);
    ui.dockComposer = null;
    ui.dockEditor = null;
    ui.dockMutationTarget = null;
    if (ui.minimized && root.document.body) {
      observeDockMutationTarget(ui, root.document.body);
    }
  }

  function dockMinimizedOverlay() {
    const ui = runtime.ui;
    if (!ui || !ui.minimized || ui.dragActive) return null;
    const match = findNotionAiComposer(ui);
    if (!match) {
      clearComposerDock(ui);
      return null;
    }
    const orbRect = ui.orb.getBoundingClientRect();
    const position = minimizedDockPosition(
      match.rect,
      { width: orbRect.width, height: orbRect.height },
      viewportSize(),
    );
    if (!position) {
      clearComposerDock(ui);
      return null;
    }
    watchDockComposer(ui, match);
    ui.host.dataset.docked = 'composer';
    ui.host.dataset.verticalSide = 'down';
    return applyOverlayPosition(position);
  }

  function scheduleMinimizedDock(delayMs = 0) {
    const ui = runtime.ui;
    if (!ui || !ui.minimized || ui.dragActive) return;
    const requestedDelay = Math.max(0, finiteNumber(delayMs) || 0);
    const elapsedSinceScan = Date.now() - runtime.dockLastScanAt;
    const cooldownDelay = ui.dockComposer
      ? 0
      : Math.max(0, COMPOSER_SCAN_COOLDOWN_MS - elapsedSinceScan);
    const delay = Math.max(requestedDelay, cooldownDelay);
    if (delay > 0) {
      if (runtime.dockTimer !== null) return;
      runtime.dockTimer = root.setTimeout(() => {
        runtime.dockTimer = null;
        scheduleMinimizedDock();
      }, delay);
      return;
    }
    if (runtime.dockFrame !== null) return;
    const run = () => {
      runtime.dockFrame = null;
      if (runtime.ui === ui && ui.minimized && !ui.dragActive) {
        runtime.dockLastScanAt = Date.now();
        keepOverlayInViewport();
      }
    };
    if (typeof root.requestAnimationFrame === 'function') {
      runtime.dockFrame = root.requestAnimationFrame(run);
    } else {
      runtime.dockFrame = root.setTimeout(run, 16);
    }
  }

  function startDockTracking(ui) {
    if (!ui || !ui.minimized || ui.dockMutationObserver || !root.document.body) return;
    runtime.dockLastScanAt = 0;
    if (typeof root.MutationObserver !== 'function') return;
    ui.dockMutationObserver = new root.MutationObserver(() => {
      if (runtime.ui === ui && ui.minimized) scheduleMinimizedDock(120);
    });
    observeDockMutationTarget(ui, root.document.body);
  }

  function stopDockTracking(ui) {
    if (!ui) return;
    if (ui.dockMutationObserver) {
      ui.dockMutationObserver.disconnect();
      ui.dockMutationObserver = null;
    }
    ui.dockMutationTarget = null;
    runtime.dockLastScanAt = 0;
    clearComposerDock(ui);
  }

  function overlayPositionHandle(ui = runtime.ui) {
    return ui && ui.minimized ? ui.orb : ui && ui.summary;
  }

  function applyOverlayAnchor(anchor) {
    const ui = runtime.ui;
    const normalized = normalizeOverlayAnchor(anchor);
    if (!ui || !normalized) return null;
    runtime.positionAnchor = normalized;
    ui.positionAnchor = normalized;
    if (ui.minimized) {
      const docked = dockMinimizedOverlay();
      if (docked) return docked;
    }
    ui.host.dataset.side = normalized.side;
    const viewport = viewportSize();
    const handle = overlayPositionHandle(ui);
    const handleSize = handle.getBoundingClientRect();
    const cardHeight = ui.expanded && !ui.minimized
      ? ui.card.getBoundingClientRect().height + 7
      : 0;
    ui.host.dataset.verticalSide = responsiveOverlayVerticalSide(
      normalized,
      { width: handleSize.width, height: handleSize.height },
      cardHeight,
      viewport,
      ui.expanded && !ui.minimized,
    );
    const hostRect = ui.host.getBoundingClientRect();
    const handleRect = handle.getBoundingClientRect();
    const position = overlayPositionFromAnchor(
      normalized,
      viewport,
      { width: hostRect.width, height: hostRect.height },
      {
        width: handleRect.width,
        height: handleRect.height,
        offsetLeft: handleRect.left - hostRect.left,
        offsetTop: handleRect.top - hostRect.top,
      },
      POSITION_INSET,
    );
    return applyOverlayPosition(position, { side: normalized.side });
  }

  function anchorFromCurrentOverlay(preferredXEdge = null, preferredYEdge = null) {
    const ui = runtime.ui;
    if (!ui) return null;
    const handleRect = overlayPositionHandle(ui).getBoundingClientRect();
    const viewport = viewportSize();
    const edges = overlayAnchorFromRect(
      handleRect,
      viewport,
      preferredXEdge,
      preferredYEdge,
    );
    return {
      ...edges,
      side: overlaySide(handleRect, viewport),
      verticalSide: edges.yEdge === 'bottom' ? 'up' : 'down',
    };
  }

  function restoreOverlayPosition(force = false) {
    const ui = runtime.ui;
    if (!ui) return;
    if (runtime.positionAnchor && !force) {
      applyOverlayAnchor(runtime.positionAnchor);
      return;
    }
    const stored = storedOverlayPosition();
    if (stored && stored.kind === 'unavailable') {
      const firstFailure = runtime.positionLoadStatus !== 'failed';
      runtime.positionLoadStatus = 'failed';
      runtime.positionRetryAt = Date.now() + 5000;
      runtime.positionError = uiText(
        '暂时无法读取网页保存的位置，将自动重试。',
        'Saved page position is temporarily unavailable; retrying automatically.',
      );
      if (firstFailure) warn('Position could not be read from this page localStorage.');
      if (!runtime.positionAnchor) {
        const fallback = anchorFromCurrentOverlay();
        if (fallback) applyOverlayAnchor(fallback);
      }
      return;
    }
    runtime.positionLoadStatus = 'loaded';
    runtime.positionRetryAt = 0;
    runtime.positionError = '';
    if (stored && stored.kind === 'anchor') {
      applyOverlayAnchor(stored.anchor);
      return;
    }

    if (!stored) {
      const anchor = anchorFromCurrentOverlay();
      if (anchor) applyOverlayAnchor(anchor);
      return;
    }

    const position = stored.position;
    if (position.side === 'left' || position.side === 'right') {
      ui.host.dataset.side = position.side;
    }
    if (position.verticalSide === 'up' || position.verticalSide === 'down') {
      ui.host.dataset.verticalSide = position.verticalSide;
    }
    applyOverlayPosition(position, { side: position.side });
    const anchor = anchorFromCurrentOverlay(
      position.side === 'left' || position.side === 'right' ? position.side : null,
      position.verticalSide === 'up'
        ? 'bottom'
        : position.verticalSide === 'down'
          ? 'top'
          : null,
    );
    if (!anchor) return;
    anchor.side = ui.host.dataset.side === 'left' ? 'left' : 'right';
    if (position.verticalSide === 'up' || position.verticalSide === 'down') {
      anchor.verticalSide = position.verticalSide;
    }
    applyOverlayAnchor(anchor);
  }

  function keepOverlayInViewport() {
    const ui = runtime.ui;
    if (!ui || ui.dragActive) return;
    if (ui.minimized) {
      const docked = dockMinimizedOverlay();
      if (docked) return;
    }
    if (!ui.positionAnchor) return;
    applyOverlayAnchor(ui.positionAnchor);
  }

  function handleOverlayPositionStorage(event) {
    const ui = runtime.ui;
    if (!ui || !event || event.key !== POSITION_KEY) return;
    const raw = event.newValue;
    const anchor = parseOverlayPosition(raw);
    if (!anchor) return;
    try {
      // A delayed storage event must not roll the UI back after a newer write.
      if (root.localStorage.getItem(POSITION_KEY) !== raw) return;
    } catch {
      return;
    }
    if (ui.dragActive) {
      runtime.pendingExternalAnchor = { anchor, raw };
      return;
    }
    runtime.pendingExternalAnchor = null;
    runtime.positionLoadStatus = 'loaded';
    runtime.positionError = '';
    applyOverlayAnchor(anchor);
  }

  function applyPendingExternalAnchor() {
    const pending = runtime.pendingExternalAnchor;
    runtime.pendingExternalAnchor = null;
    if (!pending || !runtime.ui || runtime.ui.dragActive) return;
    try {
      if (root.localStorage.getItem(POSITION_KEY) !== pending.raw) return;
    } catch {
      return;
    }
    applyOverlayAnchor(pending.anchor);
  }

  function setExpanded(expanded) {
    if (!runtime.ui) return;
    const ui = runtime.ui;
    const nextExpanded = Boolean(expanded);
    const anchor = ui.positionAnchor ? { ...ui.positionAnchor } : null;

    ui.expanded = nextExpanded;
    ui.card.hidden = ui.minimized || !nextExpanded;
    ui.summaryToggle.setAttribute('aria-expanded', String(nextExpanded));
    ui.chevron.textContent = nextExpanded ? '▴' : '▾';

    if (anchor) applyOverlayAnchor(anchor);
    try {
      root.localStorage.setItem(EXPANDED_KEY, nextExpanded ? '1' : '0');
    } catch {
      // Preference persistence is optional.
    }
  }

  function setMinimized(minimized, persist = true) {
    const ui = runtime.ui;
    if (!ui) return;
    const nextMinimized = Boolean(minimized);
    const anchor = runtime.positionAnchor ? { ...runtime.positionAnchor } : null;
    ui.minimized = nextMinimized;
    ui.shell.dataset.minimized = String(nextMinimized);
    ui.orb.hidden = !nextMinimized;
    ui.summary.hidden = nextMinimized;
    ui.card.hidden = nextMinimized || !ui.expanded;
    if (nextMinimized) {
      startDockTracking(ui);
      if (!dockMinimizedOverlay() && anchor) applyOverlayAnchor(anchor);
      scheduleMinimizedDock();
    } else {
      stopDockTracking(ui);
      if (anchor) applyOverlayAnchor(anchor);
    }
    if (!persist) return;
    try {
      root.localStorage.setItem(MINIMIZED_KEY, nextMinimized ? '1' : '0');
    } catch {
      // Preference persistence is optional.
    }
  }

  function interactiveDragTarget(target) {
    if (!target || typeof target.closest !== 'function') return false;
    return Boolean(
      target.closest(
        'button, a, input, select, textarea, [role="button"], [contenteditable="true"], .preview-help',
      ),
    );
  }

  function installOverlayDragging(ui) {
    if (!ui) return;
    let session = null;

    const removeRootListeners = () => {
      root.removeEventListener('pointermove', rootPointerMove, true);
      root.removeEventListener('pointerup', rootPointerUp, true);
      root.removeEventListener('pointercancel', rootPointerCancel, true);
      root.removeEventListener('blur', rootBlur);
    };
    const addRootListeners = () => {
      root.addEventListener('pointermove', rootPointerMove, true);
      root.addEventListener('pointerup', rootPointerUp, true);
      root.addEventListener('pointercancel', rootPointerCancel, true);
      root.addEventListener('blur', rootBlur);
    };

    function finishDrag(event, canceled) {
      if (!session) return;
      if (
        event &&
        typeof event.pointerId === 'number' &&
        event.pointerId !== session.pointerId
      ) {
        return;
      }
      const completed = session;
      session = null;
      removeRootListeners();
      ui.dragActive = false;
      ui.shell.removeAttribute('data-dragging');
      try {
        if (
          typeof completed.handle.hasPointerCapture === 'function' &&
          completed.handle.hasPointerCapture(completed.pointerId)
        ) {
          completed.handle.releasePointerCapture(completed.pointerId);
        }
      } catch {
        // Pointer capture may already have been released by the browser.
      }
      if (runtime.ui !== ui) {
        applyPendingExternalAnchor();
        return;
      }
      if (!completed.dragged) {
        applyPendingExternalAnchor();
        return;
      }
      if (event && event.cancelable) event.preventDefault();
      if (canceled) {
        if (completed.anchor) {
          applyOverlayAnchor(completed.anchor);
        } else {
          applyOverlayPosition(completed.origin, { side: completed.side });
        }
        applyPendingExternalAnchor();
        return;
      }

      runtime.pendingExternalAnchor = null;
      const handleRect = overlayPositionHandle(ui).getBoundingClientRect();
      const viewport = viewportSize();
      const edges = overlayAnchorFromRect(handleRect, viewport);
      const cardHeight = ui.expanded && !ui.minimized
        ? ui.card.getBoundingClientRect().height
        : 0;
      const anchor = {
        ...edges,
        side: overlaySide(handleRect, viewport),
        verticalSide: ui.expanded && !ui.minimized
          ? preferredVerticalSide(handleRect, cardHeight + 7, viewport)
          : edges.yEdge === 'bottom'
            ? 'up'
            : 'down',
      };
      applyOverlayAnchor(anchor);
      persistOverlayPosition(anchor);
      if (completed.suppressClick) {
        ui.suppressSummaryClick = true;
        root.setTimeout(() => {
          if (runtime.ui === ui) ui.suppressSummaryClick = false;
        }, 500);
      }
    }

    function rootPointerMove(event) {
      if (!session) return;
      if (runtime.ui !== ui) {
        finishDrag(null, true);
        return;
      }
      if (event.pointerId !== session.pointerId) return;
      const current = { x: event.clientX, y: event.clientY };
      session.dragged = dragThresholdReached(
        session.dragged,
        session.start,
        current,
        DRAG_THRESHOLD,
      );
      if (!session.dragged) return;
      if (event.cancelable) event.preventDefault();
      ui.shell.dataset.dragging = 'true';
      applyOverlayPosition(
        dragPosition(
          session.origin,
          session.start,
          current,
          viewportSize(),
          session.size,
          POSITION_INSET,
        ),
        { side: session.side },
      );
    }

    function rootPointerUp(event) {
      finishDrag(event, false);
    }

    function rootPointerCancel(event) {
      finishDrag(event, true);
    }

    function rootBlur() {
      finishDrag(null, true);
    }

    const startDrag = (handle, options, event) => {
      if (
        session ||
        ui.dragActive ||
        ui.minimized ||
        runtime.ui !== ui ||
        event.isPrimary === false ||
        event.button !== 0
      ) {
        return;
      }
      if (options.ignoreInteractive && interactiveDragTarget(event.target)) return;
      if (
        options.ignoreSelector &&
        event.target &&
        typeof event.target.closest === 'function' &&
        event.target.closest(options.ignoreSelector)
      ) {
        return;
      }
      if (options.suppressClick) ui.suppressSummaryClick = false;
      const rect = ui.host.getBoundingClientRect();
      session = {
        handle,
        pointerId: event.pointerId,
        origin: { left: rect.left, top: rect.top },
        start: { x: event.clientX, y: event.clientY },
        size: { width: rect.width, height: rect.height },
        anchor: ui.positionAnchor ? { ...ui.positionAnchor } : null,
        suppressClick: Boolean(options.suppressClick),
        side:
          ui.host.dataset.side === 'left' || ui.host.dataset.side === 'right'
            ? ui.host.dataset.side
            : overlaySide(overlayPositionHandle(ui).getBoundingClientRect()),
        dragged: false,
      };
      ui.dragActive = true;
      addRootListeners();
      try {
        if (typeof handle.setPointerCapture === 'function') {
          handle.setPointerCapture(event.pointerId);
        }
      } catch {
        // Root listeners still provide a fallback when capture is unavailable.
      }
    };

    const handles = [
      {
        handle: ui.summary,
        options: { suppressClick: true, ignoreSelector: '.summary-minimize' },
      },
      { handle: ui.header, options: { ignoreInteractive: true } },
    ];
    for (const { handle, options } of handles) {
      handle.addEventListener('pointerdown', (event) => startDrag(handle, options, event));
      handle.addEventListener('lostpointercapture', (event) => finishDrag(event, true));
    }
  }

  function metricTone(percent) {
    if (percent >= 90) return 'danger';
    if (percent >= 70) return 'warning';
    return 'normal';
  }

  function compactUsagePercent(snapshot, nowMs = Date.now()) {
    if (!snapshot || snapshot.status === 'not_applicable') return null;
    const values = [];
    const rolling = finiteNumber(snapshot.rolling && snapshot.rolling.percent);
    if (rolling !== null) values.push(clamp(rolling, 0, 100));
    const monthly = finiteNumber(snapshot.monthly && snapshot.monthly.percent);
    if (
      monthly !== null &&
      finiteNumber(snapshot.monthly && snapshot.monthly.resetAt) > nowMs
    ) {
      values.push(clamp(monthly, 0, 100));
    }
    return values.length > 0 ? Math.max(...values) : null;
  }

  function compactUsagePresentation(snapshot, nowMs = Date.now()) {
    const waiting = { percent: null, text: '…', tone: 'waiting', status: 'waiting' };
    const unavailable = {
      percent: null,
      text: '—',
      tone: 'neutral',
      status: 'unavailable',
    };
    if (!snapshot) {
      return { status: 'waiting', rolling: waiting, monthly: waiting };
    }
    if (snapshot.status === 'not_applicable') {
      const notApplicable = { ...unavailable, status: 'not_applicable' };
      return {
        status: 'not_applicable',
        rolling: notApplicable,
        monthly: notApplicable,
      };
    }
    const metricPresentation = (metric, limited) => {
      const rawPercent = finiteNumber(metric && metric.percent);
      if (rawPercent === null) {
        return limited
          ? { ...unavailable, tone: 'danger', status: 'rate_limited' }
          : unavailable;
      }
      const percent = clamp(rawPercent, 0, 100);
      return {
        percent,
        text: formatPercent(percent),
        tone: limited ? 'danger' : metricTone(percent),
        status: limited ? 'rate_limited' : 'available',
      };
    };
    const monthly =
      snapshot.monthly && finiteNumber(snapshot.monthly.resetAt) > nowMs
        ? snapshot.monthly
        : null;
    const rollingLimited =
      snapshot.status === 'rate_limited' && snapshot.limitedBy !== 'billing_period';
    const monthlyLimited =
      snapshot.status === 'rate_limited' && snapshot.limitedBy === 'billing_period';
    return {
      status: snapshot.status === 'rate_limited' ? 'rate_limited' : 'available',
      rolling: metricPresentation(snapshot.rolling, rollingLimited),
      monthly: metricPresentation(monthly, monthlyLimited),
    };
  }

  function renderCompactOrbMetric(ring, value, presentation) {
    value.textContent = presentation.text;
    ring.style.setProperty(
      '--usage-orb-progress',
      String(presentation.percent === null ? 0 : presentation.percent),
    );
    ring.dataset.tone = presentation.tone;
  }

  function renderCompactOrb(ui, snapshot, nowMs) {
    const presentation = compactUsagePresentation(snapshot, nowMs);
    renderCompactOrbMetric(
      ui.orbRollingRing,
      ui.orbRollingValue,
      presentation.rolling,
    );
    renderCompactOrbMetric(
      ui.orbMonthlyRing,
      ui.orbMonthlyValue,
      presentation.monthly,
    );
    const rollingText = presentation.rolling.text;
    const monthlyText = presentation.monthly.text;
    const label = presentation.status === 'not_applicable'
      ? uiText(
          'AI 用量：6 小时与月度均不适用，点击恢复',
          'AI usage: 6h and Monthly are not applicable, click to restore',
        )
      : presentation.status === 'rate_limited'
        ? uiText(
            `AI 用量：6 小时 ${rollingText}，月度 ${monthlyText}，已达上限，点击恢复`,
            `AI usage: 6h ${rollingText}, Monthly ${monthlyText}, limit reached, click to restore`,
          )
        : presentation.status === 'waiting'
          ? uiText(
              'AI 用量：6 小时与月度等待读取，点击恢复',
              'AI usage: 6h and Monthly waiting, click to restore',
            )
          : uiText(
              `AI 用量：6 小时 ${rollingText}，月度 ${monthlyText}，点击恢复`,
              `AI usage: 6h ${rollingText}, Monthly ${monthlyText}, click to restore`,
            );
    ui.orb.setAttribute('aria-label', label);
  }

  function renderMetric(elements, metric, label, nowMs) {
    if (!metric) {
      elements.row.hidden = true;
      return;
    }

    elements.row.hidden = false;
    elements.label.textContent = label;
    elements.percent.textContent = uiText(
      `${formatPercent(metric.percent)} 已使用`,
      `${formatPercent(metric.percent)} used`,
    );
    elements.reset.textContent = formatReset(metric.resetAt, nowMs);
    elements.fill.style.width = `${clamp(metric.percent, 0, 100)}%`;
    elements.fill.dataset.tone = metricTone(metric.percent);
    elements.row.title = uiText(
      `${metric.used} / ${metric.limit}；重置时间：${formatAbsoluteTime(metric.resetAt)}`,
      `${metric.used} / ${metric.limit}; resets: ${formatAbsoluteTime(metric.resetAt)}`,
    );
  }

  function formatTrialEnd(timestamp) {
    if (!Number.isFinite(timestamp)) return uiText('结束时间未知', 'End time unavailable');
    const language = currentUiLanguage();
    const formatted = new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(timestamp));
    return language === 'zh' ? `${formatted} 结束` : `Ends ${formatted}`;
  }

  function planDisplayName(plan) {
    if (plan === 'free') return 'Free';
    if (plan === 'business') return 'Business';
    if (plan === 'enterprise' || plan === 'enterprise_limited') return 'Enterprise';
    if (plan === 'plus' || plan === 'personal' || plan === 'student') return 'Plus';
    return uiText('未知', 'Unknown');
  }

  function subscriptionStatusText(status) {
    const labels = {
      active: uiText('有效', 'Active'),
      trialing: uiText('试用中', 'Trialing'),
      past_due: uiText('逾期', 'Past due'),
      unpaid: uiText('未付款', 'Unpaid'),
      paused: uiText('已暂停', 'Paused'),
      canceled: uiText('已取消', 'Canceled'),
      incomplete: uiText('未完成', 'Incomplete'),
      incomplete_expired: uiText('已失效', 'Expired'),
      none: uiText('未订阅', 'No subscription'),
      unknown: uiText('状态未知', 'Status unavailable'),
    };
    return labels[status] || labels.unknown;
  }

  function formatSubscriptionPeriod(timestamp) {
    if (!Number.isFinite(timestamp)) return '';
    const language = currentUiLanguage();
    const formatted = new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(timestamp));
    return language === 'zh' ? `当前周期至 ${formatted}` : `Current period ends ${formatted}`;
  }

  function billingSummaryPart(billingStatus, nowMs) {
    if (!billingStatus) return null;
    if (billingStatus.kind === 'none') return null;
    if (billingStatus.kind === 'trial') {
      const days = businessTrialDaysRemaining(billingStatus, nowMs);
      return businessTrialEndsToday(billingStatus, nowMs)
        ? uiText('试用 今天结束', 'Trial ends today')
        : uiText(`试用 ${days}天`, `Trial ${days}d`);
    }
    return `${planDisplayName(billingStatus.plan)} · ${subscriptionStatusText(billingStatus.status)}`;
  }

  function renderBillingStatus(elements, billingStatus, nowMs) {
    if (!billingStatus) {
      elements.row.hidden = true;
      return;
    }

    elements.row.hidden = false;
    if (billingStatus.kind === 'none') {
      elements.row.dataset.kind = 'none';
      elements.label.textContent = uiText('Free 套餐', 'Free Plan');
      elements.value.textContent = subscriptionStatusText('none');
      elements.end.hidden = true;
      elements.end.textContent = '';
      elements.row.title = uiText('Free 套餐：未订阅', 'Free Plan: No subscription');
      return;
    }

    if (billingStatus.kind === 'trial') {
      const remainingDays = businessTrialDaysRemaining(billingStatus, nowMs);
      const endsToday = businessTrialEndsToday(billingStatus, nowMs);
      elements.row.dataset.kind = 'trial';
      elements.label.textContent = uiText('Business 试用', 'Business Trial');
      elements.value.textContent = endsToday
        ? uiText('今天结束', 'Ends today')
        : uiText(`剩余 ${remainingDays} 天`, `${remainingDays} days left`);
      elements.end.hidden = false;
      elements.end.textContent = formatTrialEnd(billingStatus.endAt);
      elements.row.title = uiText(
        `Business 试用：${formatAbsoluteTime(billingStatus.startAt)} — ${formatAbsoluteTime(billingStatus.endAt)}`,
        `Business Trial: ${formatAbsoluteTime(billingStatus.startAt)} — ${formatAbsoluteTime(billingStatus.endAt)}`,
      );
      return;
    }

    const planName = planDisplayName(billingStatus.plan);
    const statusText = subscriptionStatusText(billingStatus.status);
    const periodText = formatSubscriptionPeriod(billingStatus.currentPeriodEndAt);
    elements.row.dataset.kind = 'subscription';
    elements.label.textContent = uiText(`${planName} 套餐`, `${planName} Plan`);
    elements.value.textContent = statusText;
    elements.end.hidden = !periodText;
    elements.end.textContent = periodText;
    elements.row.title = periodText
      ? uiText(
          `${planName} 套餐：${statusText}；${periodText}`,
          `${planName} Plan: ${statusText}; ${periodText}`,
        )
      : uiText(`${planName} 套餐：${statusText}`, `${planName} Plan: ${statusText}`);
  }

  function setSummaryParts(container, parts) {
    const values = parts
      .filter((part) => isRecord(part) && typeof part.text === 'string' && part.text.length > 0)
      .map((part) => ({
        text: part.text,
        separator:
          part.separator === 'usage' || part.separator === 'billing'
            ? part.separator
            : 'none',
      }));
    const currentValues = Array.from(container.children, (node) => ({
      text: node.textContent || '',
      separator: node.dataset.separator || 'none',
    }));
    if (
      currentValues.length === values.length &&
      currentValues.every(
        (value, index) =>
          value.text === values[index].text &&
          value.separator === values[index].separator,
      )
    ) {
      container.setAttribute('aria-label', values.map((value) => value.text).join('，'));
      return;
    }
    const ui = runtime.ui;
    const preservedAnchor =
      ui &&
      ui.positionAnchor &&
        ui.summaryText === container &&
      !ui.dragActive
        ? { ...ui.positionAnchor }
        : null;
    const nodes = values.map((value) => {
      const part = container.ownerDocument.createElement('span');
      part.className = 'summary-part';
      part.dataset.separator = value.separator;
      part.textContent = value.text;
      return part;
    });
    container.replaceChildren(...nodes);
    container.setAttribute('aria-label', values.map((value) => value.text).join('，'));
    if (preservedAnchor) applyOverlayAnchor(preservedAnchor);
  }

  function updateStaticUiCopy(ui, isLoading, isPreview) {
    ui.host.dataset.theme = currentUiTheme();
    ui.card.setAttribute('aria-label', uiText('Notion AI 用量', 'Notion AI Usage'));
    ui.title.textContent = uiText('Notion AI 用量', 'Notion AI Usage');
    ui.previewHelp.hidden = !isPreview;
    ui.previewHelp.setAttribute(
      'aria-label',
      uiText('关于 preview 用量额度', 'About the preview usage allowance'),
    );
    ui.previewTooltip.textContent = uiText(
      'Notion 当前将此额度标记为 preview。',
      'Notion currently marks this allowance as preview.',
    );
    ui.refresh.classList.toggle('is-loading', isLoading);
    ui.refresh.setAttribute(
      'aria-label',
      isLoading ? uiText('正在读取', 'Loading') : uiText('刷新', 'Refresh'),
    );
    ui.refresh.title = isLoading ? uiText('正在读取…', 'Loading…') : uiText('刷新', 'Refresh');
    ui.minimize.setAttribute(
      'aria-label',
      uiText('最小化至输入框底部', 'Minimize to the composer bottom'),
    );
    ui.minimize.title = uiText('最小化至输入框底部', 'Minimize to the composer bottom');
    ui.nativePage.setAttribute('aria-label', uiText('打开原生用量页', 'Open native Usage page'));
    ui.nativePage.title = uiText('打开原生用量页', 'Open native Usage page');
  }

  function render() {
    const ui = runtime.ui;
    if (!ui) return;
    const snapshot = runtime.snapshot;
    const nowMs = Date.now();
    const billingStatus = activeBillingStatus(runtime.billingStatus, nowMs);
    const billingPart = billingSummaryPart(billingStatus, nowMs);
    const errorText = currentErrorText();

    const cooldownUntil = runtime.lastFetchedAt + MIN_REFRESH_INTERVAL;
    const isLoading = runtime.fetching || runtime.billingFetching;
    updateStaticUiCopy(ui, isLoading, snapshot && snapshot.enforcement === 'preview');
    renderCompactOrb(ui, snapshot, nowMs);
    ui.refresh.disabled =
      isLoading ||
      (runtime.activeRefreshDisabled && runtime.billingRefreshDisabled) ||
      !runtime.spaceId ||
      nowMs < Math.max(runtime.nextAllowedAt, cooldownUntil);
    renderBillingStatus(ui.billing, billingStatus, nowMs);

    if (!snapshot) {
      const waitingText =
        runtime.fetching || runtime.billingFetching
          ? uiText('读取中', 'Loading')
          : uiText('等待', 'Waiting');
      setSummaryParts(ui.summaryText, [
        { text: waitingText },
        billingPart ? { text: billingPart, separator: 'billing' } : null,
      ]);
      ui.dot.dataset.status = errorText ? 'error' : 'waiting';
      ui.notice.hidden = false;
      ui.notice.dataset.kind = errorText ? 'error' : 'info';
      ui.notice.textContent =
        errorText ||
        (runtime.spaceId
          ? uiText('正在读取 Notion AI 用量…', 'Loading Notion AI usage…')
          : uiText(
              '等待 Notion 初始化当前工作区；也可以打开原生用量页触发读取。',
              'Waiting for Notion to initialize this workspace. You can also open the native Usage page.',
            ));
      ui.rolling.row.hidden = true;
      ui.monthly.row.hidden = true;
      ui.metrics.hidden = !billingStatus;
      ui.updated.textContent = billingStatus
        ? uiText(
            `${formatUpdated(billingStatus.updatedAt, nowMs)} — Notion 同源接口`,
            `${formatUpdated(billingStatus.updatedAt, nowMs)} — Notion same-origin API`,
          )
        : uiText('尚未取得有效数据', 'No valid data yet');
      keepOverlayInViewport();
      return;
    }

    if (snapshot.status === 'not_applicable') {
      setSummaryParts(ui.summaryText, [
        { text: uiText('不适用', 'Not applicable') },
        billingPart ? { text: billingPart, separator: 'billing' } : null,
      ]);
      ui.dot.dataset.status = 'neutral';
      ui.notice.hidden = false;
      ui.notice.dataset.kind = errorText ? 'error' : 'info';
      ui.notice.textContent =
        errorText ||
        uiText(
          'Notion 返回 not_applicable：当前账户或套餐没有可展示的 AI 用量窗口。',
          'Notion returned not_applicable: this account or plan has no AI usage window to display.',
        );
      ui.rolling.row.hidden = true;
      ui.monthly.row.hidden = true;
      ui.metrics.hidden = !billingStatus;
    } else {
      const activeMonthly =
        snapshot.monthly && snapshot.monthly.resetAt > nowMs ? snapshot.monthly : null;
      setSummaryParts(ui.summaryText, [
        { text: formatPercent(snapshot.rolling.percent) },
        activeMonthly
          ? { text: formatPercent(activeMonthly.percent), separator: 'usage' }
          : null,
        billingPart ? { text: billingPart, separator: 'billing' } : null,
      ]);
      ui.dot.dataset.status = snapshot.status === 'rate_limited' ? 'error' : 'ok';
      ui.metrics.hidden = false;

      renderMetric(ui.rolling, snapshot.rolling, formatWindowLabel(snapshot.rolling.window), nowMs);
      renderMetric(ui.monthly, activeMonthly, uiText('月度用量', 'Monthly usage'), nowMs);

      if (snapshot.status === 'rate_limited') {
        ui.notice.hidden = false;
        ui.notice.dataset.kind = 'error';
        const limitText =
          snapshot.limitedBy === 'billing_period'
            ? uiText('已达到月度额度上限。', 'The monthly allowance has been reached.')
            : uiText(
                '已达到当前滚动窗口的额度上限。',
                'The current rolling-window allowance has been reached.',
              );
        ui.notice.textContent = errorText ? `${limitText} ${errorText}` : limitText;
      } else if (errorText) {
        ui.notice.hidden = false;
        ui.notice.dataset.kind = 'error';
        ui.notice.textContent = uiText(
          `${errorText}（继续显示可用的最后有效数据）`,
          `${errorText} (showing the last valid data where available)`,
        );
      } else {
        ui.notice.hidden = true;
      }
    }

    const newestUpdate = Math.max(
      snapshot.updatedAt,
      billingStatus ? billingStatus.updatedAt : 0,
    );
    ui.updated.textContent = uiText(
      `${formatUpdated(newestUpdate, nowMs)} — Notion 同源接口`,
      `${formatUpdated(newestUpdate, nowMs)} — Notion same-origin API`,
    );
    keepOverlayInViewport();
  }

  function buildMetricRow(documentRef, key) {
    const row = documentRef.createElement('div');
    row.className = 'metric';
    row.dataset.metric = key;
    row.innerHTML = trustedHtml(`
      <div class="metric-head">
        <span class="metric-label"></span>
        <span class="metric-percent"></span>
      </div>
      <div class="bar" aria-hidden="true"><span class="bar-fill"></span></div>
      <div class="metric-reset"></div>
    `);
    return {
      row,
      label: row.querySelector('.metric-label'),
      percent: row.querySelector('.metric-percent'),
      fill: row.querySelector('.bar-fill'),
      reset: row.querySelector('.metric-reset'),
    };
  }

  function buildBillingRow(documentRef) {
    const row = documentRef.createElement('div');
    row.className = 'metric billing';
    row.dataset.metric = 'billing-status';
    row.innerHTML = trustedHtml(`
      <div class="metric-head">
        <span class="metric-label">Business Trial</span>
        <span class="billing-value"></span>
      </div>
      <div class="metric-reset billing-end"></div>
    `);
    return {
      row,
      label: row.querySelector('.metric-label'),
      value: row.querySelector('.billing-value'),
      end: row.querySelector('.billing-end'),
    };
  }

  function mountUi() {
    if (!root.document.body) return;
    const existingHost = root.document.getElementById(HOST_ID);
    if (existingHost && runtime.ui && existingHost === runtime.ui.host) return;
    if (runtime.ui) stopDockTracking(runtime.ui);
    if (existingHost) existingHost.remove();

    const host = root.document.createElement('div');
    host.id = HOST_ID;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = trustedHtml(`
      <style>
        :host {
          all: initial;
          --usage-text: #f7f7f5;
          --usage-muted: #a8a8a8;
          --usage-faint: #929292;
          --usage-border: rgba(255,255,255,.14);
          --usage-divider: rgba(255,255,255,.24);
          --usage-summary: rgba(30,30,30,.94);
          --usage-summary-hover: rgba(42,42,42,.97);
          --usage-card: rgba(28,28,28,.97);
          --usage-button-text: #d6d6d6;
          --usage-button: rgba(255,255,255,.08);
          --usage-button-hover: rgba(255,255,255,.14);
          --usage-row-divider: rgba(255,255,255,.08);
          --usage-bar: rgba(255,255,255,.10);
          --usage-value: #c7c7c7;
          --usage-billing: #d9c4ff;
          --usage-info-text: #c6dfff;
          --usage-info-bg: rgba(58,132,217,.14);
          --usage-error-text: #ffc5c5;
          --usage-error-bg: rgba(221,70,70,.14);
          --usage-tooltip-text: #f7f7f5;
          --usage-tooltip-bg: #2f2f2f;
          --usage-tooltip-border: rgba(255,255,255,.12);
          --usage-orb-track: rgba(255,255,255,.18);
          --usage-orb-core: #202124;
          --usage-orb-value: #f7f7f5;
          --usage-shadow: 0 14px 42px rgba(0,0,0,.36);
          --usage-summary-item-gap: 11px;
          --usage-summary-separator-space: 12px;
          display: block;
          position: fixed;
          top: 16px;
          right: 16px;
          z-index: 2147483646;
          width: max-content;
          max-width: calc(100vw - 32px);
          color: var(--usage-text);
          font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          font-size: 13px;
          line-height: 1.4;
          pointer-events: none;
        }
        :host([data-theme="light"]) {
          --usage-text: #252525;
          --usage-muted: #686868;
          --usage-faint: #787774;
          --usage-border: rgba(15,15,15,.13);
          --usage-divider: rgba(15,15,15,.20);
          --usage-summary: rgba(255,255,255,.96);
          --usage-summary-hover: rgba(247,247,245,.98);
          --usage-card: rgba(255,255,255,.98);
          --usage-button-text: #4f4f4f;
          --usage-button: rgba(15,15,15,.06);
          --usage-button-hover: rgba(15,15,15,.11);
          --usage-row-divider: rgba(15,15,15,.09);
          --usage-bar: rgba(15,15,15,.10);
          --usage-value: #555;
          --usage-billing: #6940a5;
          --usage-info-text: #24588f;
          --usage-info-bg: rgba(46,119,190,.11);
          --usage-error-text: #a62d2f;
          --usage-error-bg: rgba(190,46,48,.10);
          --usage-tooltip-text: #252525;
          --usage-tooltip-bg: #fff;
          --usage-tooltip-border: rgba(15,15,15,.12);
          --usage-orb-track: rgba(15,15,15,.16);
          --usage-orb-core: #202124;
          --usage-orb-value: #f7f7f5;
          --usage-shadow: 0 14px 38px rgba(15,15,15,.18);
        }
        * { box-sizing: border-box; }
        button { font: inherit; }
        .shell {
          display: flex;
          align-items: flex-end;
          flex-direction: column;
          gap: 7px;
        }
        :host([data-side="left"]) .shell { align-items: flex-start; }
        :host([data-vertical-side="up"]) .shell { flex-direction: column-reverse; }
        :host([data-docked="composer"]) .shell { align-items: center; }
        .orb {
          pointer-events: auto;
          display: inline-flex;
          align-items: center;
          gap: 5px;
          max-width: 100%;
          min-height: 28px;
          padding: 2px;
          border: 0;
          border-radius: 999px;
          color: var(--usage-text);
          background: transparent;
          cursor: pointer;
          touch-action: manipulation;
          user-select: none;
          transition: transform .12s ease;
        }
        .orb:hover { transform: translateY(-1px); }
        .orb[hidden], .summary[hidden] { display: none; }
        .orb-metric {
          display: block;
          width: 24px;
          height: 24px;
          flex: 0 0 24px;
          min-width: 24px;
        }
        .orb-ring {
          --usage-orb-progress: 0;
          --usage-orb-color: #35b46f;
          display: block;
          position: relative;
          width: 24px;
          height: 24px;
          flex: 0 0 auto;
          border-radius: 50%;
          background: conic-gradient(
            from -90deg,
            var(--usage-orb-color) calc(var(--usage-orb-progress) * 1%),
            var(--usage-orb-track) 0
          );
          box-shadow: 0 3px 10px rgba(0,0,0,.24);
        }
        .orb-ring::after {
          content: "";
          position: absolute;
          inset: 3px;
          border-radius: inherit;
          background: var(--usage-orb-core);
        }
        .orb-ring[data-tone="warning"] { --usage-orb-color: #dfa83a; }
        .orb-ring[data-tone="danger"] { --usage-orb-color: #ed6566; }
        .orb-ring[data-tone="waiting"] { --usage-orb-color: #8c8c8c; }
        .orb-ring[data-tone="neutral"] { --usage-orb-color: #8c8c8c; }
        .orb-value {
          position: absolute;
          z-index: 1;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--usage-orb-value);
          font-size: 7px;
          font-weight: 750;
          font-variant-numeric: tabular-nums;
          letter-spacing: -.05em;
          opacity: 0;
          white-space: nowrap;
          transition: opacity .12s ease;
        }
        .orb:hover .orb-value,
        .orb:focus-visible .orb-value { opacity: 1; }
        .summary {
          pointer-events: auto;
          display: inline-flex;
          align-items: center;
          gap: 2px;
          min-height: 38px;
          max-width: 100%;
          padding: 0 6px 0 0;
          border: 1px solid var(--usage-border);
          border-radius: 999px;
          color: var(--usage-text);
          background: var(--usage-summary);
          box-shadow: 0 7px 24px rgba(0,0,0,.20);
          backdrop-filter: blur(14px);
          cursor: grab;
          touch-action: none;
          user-select: none;
        }
        .summary:hover { background: var(--usage-summary-hover); }
        .summary-toggle {
          display: inline-flex;
          align-items: center;
          gap: var(--usage-summary-item-gap);
          min-width: 0;
          min-height: 38px;
          max-width: calc(100% - 28px);
          padding: 8px 5px 8px 13px;
          border: 0;
          color: inherit;
          background: transparent;
          cursor: grab;
          touch-action: none;
          user-select: none;
        }
        .summary-minimize {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 24px;
          height: 24px;
          flex: 0 0 auto;
          padding: 0;
          border: 0;
          border-radius: 50%;
          color: var(--usage-muted);
          background: transparent;
          cursor: pointer;
        }
        .summary-minimize:hover {
          color: var(--usage-text);
          background: var(--usage-button-hover);
        }
        .summary-minimize svg {
          width: 13px;
          height: 13px;
          fill: none;
          stroke: currentColor;
          stroke-width: 2;
          stroke-linecap: round;
        }
        .orb:focus-visible,
        .summary-toggle:focus-visible,
        .summary-minimize:focus-visible,
        .action:focus-visible {
          outline: 2px solid #4e9cff;
          outline-offset: 2px;
        }
        .dot {
          width: 8px;
          height: 8px;
          flex: 0 0 auto;
          border-radius: 50%;
          background: #808080;
          box-shadow: 0 0 0 3px rgba(128,128,128,.13);
        }
        .dot[data-status="ok"] { background: #35b46f; box-shadow: 0 0 0 3px rgba(53,180,111,.15); }
        .dot[data-status="error"] { background: #f05d5e; box-shadow: 0 0 0 3px rgba(240,93,94,.16); }
        .dot[data-status="waiting"] { background: #d3a832; box-shadow: 0 0 0 3px rgba(211,168,50,.16); }
        .summary-text {
          display: inline-flex;
          align-items: center;
          min-width: 0;
          overflow: hidden;
          white-space: nowrap;
          text-overflow: ellipsis;
          font-weight: 650;
          letter-spacing: .01em;
        }
        .summary-part { flex: 0 0 auto; }
        .summary-part[data-separator="usage"]::before {
          content: "·";
          display: inline;
          margin: 0 var(--usage-summary-separator-space);
          color: var(--usage-muted);
        }
        .summary-part[data-separator="billing"]::before {
          content: "";
          display: inline-block;
          width: 1px;
          height: 14px;
          margin: 0 var(--usage-summary-separator-space);
          vertical-align: -2px;
          background: var(--usage-divider);
        }
        .chevron { flex: 0 0 auto; color: var(--usage-muted); font-size: 11px; }
        .card {
          pointer-events: auto;
          width: min(336px, calc(100vw - 32px));
          max-height: max(0px, calc(100vh - 70px));
          overflow: auto;
          overscroll-behavior: contain;
          border: 1px solid var(--usage-border);
          border-radius: 14px;
          color: var(--usage-text);
          background: var(--usage-card);
          box-shadow: var(--usage-shadow);
          backdrop-filter: blur(18px);
        }
        .card[hidden] { display: none; }
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 14px 10px;
          cursor: grab;
          touch-action: none;
          user-select: none;
        }
        .shell[data-dragging="true"] .orb,
        .shell[data-dragging="true"] .summary,
        .shell[data-dragging="true"] .summary-toggle,
        .shell[data-dragging="true"] .header { cursor: grabbing; }
        .title-group { display: flex; align-items: center; gap: 6px; min-width: 0; }
        .title { font-size: 14px; font-weight: 720; }
        .preview-help {
          position: relative;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 17px;
          height: 17px;
          flex: 0 0 auto;
          border-radius: 50%;
          color: var(--usage-muted);
          cursor: help;
        }
        .preview-help[hidden] { display: none; }
        .preview-help:focus-visible {
          outline: 2px solid #4e9cff;
          outline-offset: 2px;
        }
        .preview-help > svg {
          width: 15px;
          height: 15px;
          fill: none;
          stroke: currentColor;
          stroke-width: 1.8;
          stroke-linecap: round;
          stroke-linejoin: round;
        }
        .preview-tooltip {
          position: absolute;
          z-index: 2;
          top: calc(100% + 8px);
          left: 50%;
          width: max-content;
          max-width: 238px;
          padding: 7px 9px;
          border-radius: 6px;
          border: 1px solid var(--usage-tooltip-border);
          color: var(--usage-tooltip-text);
          background: var(--usage-tooltip-bg);
          box-shadow: 0 5px 18px rgba(0,0,0,.22);
          font-size: 11px;
          font-weight: 450;
          line-height: 1.4;
          text-align: left;
          white-space: normal;
          opacity: 0;
          visibility: hidden;
          pointer-events: none;
          transform: translate(-50%, -2px);
          transition: opacity .12s ease, transform .12s ease, visibility .12s;
        }
        .preview-help:hover .preview-tooltip,
        .preview-help:focus .preview-tooltip {
          opacity: 1;
          visibility: visible;
          transform: translate(-50%, 0);
        }
        .actions { display: flex; gap: 6px; }
        .action {
          border: 0;
          border-radius: 7px;
          padding: 5px 8px;
          color: var(--usage-button-text);
          background: var(--usage-button);
          cursor: pointer;
        }
        .action:hover:not(:disabled) { background: var(--usage-button-hover); color: var(--usage-text); }
        .action:disabled { cursor: default; opacity: .5; }
        .icon-action {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          height: 28px;
          padding: 0;
        }
        .icon-action svg {
          width: 16px;
          height: 16px;
          fill: none;
          stroke: currentColor;
          stroke-width: 1.8;
          stroke-linecap: round;
          stroke-linejoin: round;
        }
        .refresh svg { stroke-width: 2; }
        .refresh.is-loading svg {
          transform-origin: center;
          animation: usage-spin .8s linear infinite;
        }
        @keyframes usage-spin { to { transform: rotate(360deg); } }
        .notice {
          margin: 0 14px 10px;
          padding: 8px 9px;
          border-radius: 8px;
          color: var(--usage-info-text);
          background: var(--usage-info-bg);
          font-size: 11px;
        }
        .notice[data-kind="error"] { color: var(--usage-error-text); background: var(--usage-error-bg); }
        .notice[hidden], .metrics[hidden] { display: none; }
        .metrics { padding: 0 14px 3px; }
        .metric { padding: 8px 0 11px; }
        .metric + .metric { border-top: 1px solid var(--usage-row-divider); }
        .metric-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
        .metric-label { font-weight: 620; }
        .metric-percent { color: var(--usage-value); font-variant-numeric: tabular-nums; }
        .billing-value {
          color: var(--usage-billing);
          font-weight: 650;
          font-variant-numeric: tabular-nums;
        }
        .billing-end { margin-top: 5px; }
        .bar {
          width: 100%;
          height: 5px;
          overflow: hidden;
          margin: 7px 0 5px;
          border-radius: 99px;
          background: var(--usage-bar);
        }
        .bar-fill {
          display: block;
          width: 0;
          height: 100%;
          border-radius: inherit;
          background: #3d9bff;
          transition: width .25s ease;
        }
        .bar-fill[data-tone="warning"] { background: #dfa83a; }
        .bar-fill[data-tone="danger"] { background: #ed6566; }
        .metric-reset { color: var(--usage-faint); font-size: 11px; }
        .footer {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          min-height: 39px;
          padding: 8px 10px 8px 14px;
          border-top: 1px solid var(--usage-row-divider);
          color: var(--usage-faint);
          font-size: 10px;
        }
        .footer-actions { display: flex; flex: 0 0 auto; gap: 5px; }
        @media (max-width: 520px) {
          :host { top: 9px; right: 9px; max-width: calc(100vw - 18px); }
          .card { width: min(324px, calc(100vw - 18px)); }
        }
        @media (prefers-reduced-motion: reduce) {
          .bar-fill { transition: none; }
          .orb { transition: none; }
          .orb-value { transition: none; }
          .refresh.is-loading svg { animation: none; opacity: .55; }
          .preview-tooltip { transition: none; }
        }
      </style>
      <div class="shell">
        <button class="orb" type="button" aria-label="AI usage" hidden>
          <span class="orb-metric" aria-hidden="true">
            <span class="orb-ring orb-rolling-ring"><span class="orb-value orb-rolling-value">…</span></span>
          </span>
          <span class="orb-metric" aria-hidden="true">
            <span class="orb-ring orb-monthly-ring"><span class="orb-value orb-monthly-value">…</span></span>
          </span>
        </button>
        <div class="summary">
          <button class="summary-toggle" type="button" aria-expanded="false" aria-controls="notion-ai-usage-card">
            <span class="dot" data-status="waiting" aria-hidden="true"></span>
            <span class="summary-text">
              <span class="summary-part">Waiting</span>
            </span>
            <span class="chevron" aria-hidden="true">▾</span>
          </button>
          <button class="summary-minimize" type="button" aria-label="Minimize to the composer bottom" title="Minimize to the composer bottom">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12"></path></svg>
          </button>
        </div>
        <section class="card" id="notion-ai-usage-card" aria-label="Notion AI Usage" hidden>
          <div class="header">
            <div class="title-group">
              <div class="title">Notion AI Usage</div>
              <span class="preview-help" tabindex="0" aria-describedby="notion-ai-preview-tooltip" hidden>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="12" r="10"></circle>
                  <path d="M12 16v-4"></path>
                  <path d="M12 8h.01"></path>
                </svg>
                <span class="preview-tooltip" id="notion-ai-preview-tooltip" role="tooltip"></span>
              </span>
            </div>
            <div class="actions">
              <button class="action icon-action refresh" type="button" aria-label="Refresh" title="Refresh">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path>
                  <path d="M21 3v5h-5"></path>
                  <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path>
                  <path d="M8 16H3v5"></path>
                </svg>
              </button>
            </div>
          </div>
          <div class="notice" data-kind="info"></div>
          <div class="metrics"></div>
          <div class="footer">
            <span class="updated">Not updated yet</span>
            <span class="footer-actions">
              <button class="action icon-action native-page" type="button" aria-label="Open native Usage page" title="Open native Usage page">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M14 4h6v6"></path>
                  <path d="m20 4-9 9"></path>
                  <path d="M20 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4"></path>
                </svg>
              </button>
            </span>
          </div>
        </section>
      </div>
    `);

    const metrics = shadow.querySelector('.metrics');
    const rolling = buildMetricRow(root.document, 'rolling');
    const monthly = buildMetricRow(root.document, 'monthly');
    const billing = buildBillingRow(root.document);
    metrics.append(rolling.row, monthly.row, billing.row);

    runtime.ui = {
      host,
      shadow,
      shell: shadow.querySelector('.shell'),
      orb: shadow.querySelector('.orb'),
      orbRollingRing: shadow.querySelector('.orb-rolling-ring'),
      orbRollingValue: shadow.querySelector('.orb-rolling-value'),
      orbMonthlyRing: shadow.querySelector('.orb-monthly-ring'),
      orbMonthlyValue: shadow.querySelector('.orb-monthly-value'),
      summary: shadow.querySelector('.summary'),
      summaryToggle: shadow.querySelector('.summary-toggle'),
      summaryText: shadow.querySelector('.summary-text'),
      dot: shadow.querySelector('.dot'),
      chevron: shadow.querySelector('.chevron'),
      card: shadow.querySelector('.card'),
      header: shadow.querySelector('.header'),
      title: shadow.querySelector('.title'),
      previewHelp: shadow.querySelector('.preview-help'),
      previewTooltip: shadow.querySelector('.preview-tooltip'),
      notice: shadow.querySelector('.notice'),
      metrics,
      rolling,
      monthly,
      billing,
      minimize: shadow.querySelector('.summary-minimize'),
      refresh: shadow.querySelector('.refresh'),
      nativePage: shadow.querySelector('.native-page'),
      updated: shadow.querySelector('.updated'),
      expanded: false,
      minimized: false,
      position: null,
      positionAnchor: null,
      dragActive: false,
      suppressSummaryClick: false,
      dockComposer: null,
      dockEditor: null,
      dockResizeObserver: null,
      dockMutationObserver: null,
      dockMutationTarget: null,
    };

    runtime.ui.summary.addEventListener('click', (event) => {
      if (
        event.target &&
        typeof event.target.closest === 'function' &&
        event.target.closest('.summary-minimize')
      ) {
        return;
      }
      const transition = summaryClickTransition(
        runtime.ui.expanded,
        runtime.ui.suppressSummaryClick,
      );
      runtime.ui.suppressSummaryClick = transition.suppressNextClick;
      if (transition.expanded !== runtime.ui.expanded) setExpanded(transition.expanded);
    });
    runtime.ui.summaryToggle.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        runtime.ui.suppressSummaryClick = false;
      }
    });
    runtime.ui.orb.addEventListener('click', () => {
      if (runtime.ui.suppressSummaryClick) {
        runtime.ui.suppressSummaryClick = false;
        return;
      }
      const ui = runtime.ui;
      setMinimized(false);
      try {
        ui.summaryToggle.focus({ preventScroll: true });
      } catch {
        ui.summaryToggle.focus();
      }
    });
    runtime.ui.orb.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        runtime.ui.suppressSummaryClick = false;
      }
    });
    runtime.ui.minimize.addEventListener('click', () => {
      const ui = runtime.ui;
      setMinimized(true);
      try {
        ui.orb.focus({ preventScroll: true });
      } catch {
        ui.orb.focus();
      }
    });
    runtime.ui.refresh.addEventListener('click', () => {
      refreshBillingStatus({ force: true, reason: 'manual' });
      refreshUsage({ force: true, reason: 'manual' });
    });
    runtime.ui.nativePage.addEventListener('click', () => {
      const target = new root.URL(root.location.href);
      target.searchParams.set('target', 'aiusage');
      root.location.assign(target.href);
    });
    installOverlayDragging(runtime.ui);

    root.document.body.appendChild(host);
    let expanded = false;
    let minimized = false;
    try {
      expanded = root.localStorage.getItem(EXPANDED_KEY) === '1';
      minimized = root.localStorage.getItem(MINIMIZED_KEY) === '1';
    } catch {
      expanded = false;
      minimized = false;
    }
    setExpanded(expanded);
    restoreOverlayPosition();
    setMinimized(minimized, false);
    render();
  }

  function ensureUi() {
    if (!runtime.ui || !runtime.ui.host.isConnected) {
      mountUi();
      return;
    }
    if (root.document.body && runtime.ui.host.parentNode !== root.document.body) {
      root.document.body.appendChild(runtime.ui.host);
    }
    if (runtime.ui.minimized) {
      startDockTracking(runtime.ui);
      scheduleMinimizedDock();
    }
    if (
      runtime.positionLoadStatus === 'failed' &&
      !runtime.ui.dragActive &&
      Date.now() >= runtime.positionRetryAt
    ) {
      restoreOverlayPosition(true);
      render();
    }
  }

  function acceptSpaceId(spaceId, headers, sequence) {
    if (!spaceId) return null;
    if (sequence < runtime.acceptedContextSequence) return null;
    runtime.acceptedContextSequence = sequence;

    const incomingHeaders = safeHeaders(headers);
    const activeUserCandidate = incomingHeaders['x-notion-active-user-header'];
    const incomingActiveUser =
      typeof activeUserCandidate === 'string' &&
      activeUserCandidate.length > 0 &&
      activeUserCandidate.length <= 128 &&
      !/[\u0000-\u001f\u007f]/.test(activeUserCandidate)
        ? activeUserCandidate
        : null;
    const spaceChanged = runtime.spaceId !== spaceId;
    const changed =
      spaceChanged ||
      Boolean(incomingActiveUser && incomingActiveUser !== runtime.activeUserId);

    runtime.spaceId = spaceId;
    runtime.activeUserId = spaceChanged
      ? incomingActiveUser
      : incomingActiveUser || runtime.activeUserId;
    // Sparse billing/legacy calls must not erase a richer recipe from the same
    // account. A workspace or explicit user switch still starts from scratch.
    runtime.recipeHeaders = mergeRecipeHeaders(
      runtime.recipeHeaders,
      incomingHeaders,
      spaceId,
      changed,
    );

    if (changed) {
      runtime.contextVersion += 1;
      if (runtime.activeController) runtime.activeController.abort();
      if (runtime.billingController) runtime.billingController.abort();
      if (runtime.refreshTimer) {
        root.clearTimeout(runtime.refreshTimer);
        runtime.refreshTimer = null;
        runtime.refreshDueAt = 0;
      }
      if (runtime.billingRefreshTimer) {
        root.clearTimeout(runtime.billingRefreshTimer);
        runtime.billingRefreshTimer = null;
        runtime.billingRefreshDueAt = 0;
      }
      runtime.snapshot = null;
      runtime.billingStatus = null;
      runtime.acceptedCurrentResponseSequence = 0;
      runtime.acceptedBillingResponseSequence = 0;
      runtime.lastAttemptAt = 0;
      runtime.lastFetchedAt = 0;
      runtime.lastBillingFetchedAt = 0;
      runtime.lastBillingAttemptAt = 0;
      runtime.billingBackoffUntil = 0;
      runtime.error = '';
      runtime.billingError = '';
      runtime.nextAllowedAt = 0;
      runtime.backoffMs = 0;
      runtime.activeRefreshDisabled = false;
      runtime.billingRefreshDisabled = false;
      render();
    }

    return Object.freeze({
      sequence,
      contextVersion: runtime.contextVersion,
      spaceId: runtime.spaceId,
      activeUserId: runtime.activeUserId,
    });
  }

  function acceptRecipe(kind, bodyText, headers, sequence) {
    const spaceId = extractSpaceId(bodyText, headers);
    const contextToken = acceptSpaceId(spaceId, headers, sequence);
    if (!contextToken) return null;

    const refreshPlan = usageRefreshPlan(
      kind,
      Boolean(runtime.snapshot),
      Date.now() - runtime.lastNativeCurrentAt,
    );
    if (refreshPlan) scheduleRefresh(refreshPlan.reason, refreshPlan.delay);
    if (kind === 'billing') {
      scheduleBillingRefresh('native-billing', 1500);
    } else {
      scheduleBillingRefresh(`${kind}-space-id`, 250);
    }
    return contextToken;
  }

  function acceptPayload(payload, source, requestContext = null, sequenceFloor = null) {
    if (requestContext && !contextTokenMatches(requestContext, runtime)) return false;
    if (
      requestContext &&
      source === 'current' &&
      !responseSequenceIsFresh(
        requestContext,
        runtime.acceptedCurrentResponseSequence,
      )
    ) {
      return false;
    }

    const snapshot = normalizeVerdict(payload);
    if (!snapshot) {
      if (source === 'current') {
        runtime.error = uiText(
          'Notion 返回了暂不支持的用量数据结构',
          'Notion returned an unsupported usage schema',
        );
        warn('Unsupported getCreditRateLimitStatus response schema; keeping the last valid snapshot.');
        render();
      }
      return false;
    }

    runtime.snapshot = snapshot;
    if (source === 'current') {
      if (requestContext) {
        runtime.acceptedCurrentResponseSequence = requestContext.sequence;
      } else if (Number.isSafeInteger(sequenceFloor)) {
        runtime.acceptedCurrentResponseSequence = Math.max(
          runtime.acceptedCurrentResponseSequence,
          sequenceFloor,
        );
      }
    }
    runtime.error = '';
    runtime.lastFetchedAt = Date.now();
    runtime.backoffMs = 0;
    runtime.nextAllowedAt = 0;
    runtime.activeRefreshDisabled = false;
    render();
    return true;
  }

  function acceptBillingStatusPayload(payload, requestContext = null, sequenceFloor = null) {
    if (requestContext && !contextTokenMatches(requestContext, runtime)) return false;
    if (
      requestContext &&
      !responseSequenceIsFresh(requestContext, runtime.acceptedBillingResponseSequence)
    ) {
      return false;
    }

    // Project the billing response immediately to a minimal plan-status object.
    // Addresses, payment methods, invoices, balances, and dependencies are never retained.
    const normalized = normalizeBillingStatus(payload);
    if (!normalized) {
      warn('Unsupported getBillingData plan schema; keeping the last valid billing state.');
      return false;
    }

    runtime.billingStatus = normalized;
    runtime.billingError = '';
    if (requestContext) {
      runtime.acceptedBillingResponseSequence = requestContext.sequence;
    } else if (Number.isSafeInteger(sequenceFloor)) {
      runtime.acceptedBillingResponseSequence = Math.max(
        runtime.acceptedBillingResponseSequence,
        sequenceFloor,
      );
    }
    runtime.lastBillingFetchedAt = Date.now();
    runtime.billingBackoffUntil = 0;
    runtime.billingRefreshDisabled = false;
    render();
    return true;
  }

  async function readBillingJson(response) {
    const contentLength = finiteNumber(response.headers && response.headers.get('content-length'));
    if (contentLength !== null && contentLength > 2_000_000) {
      throw new Error('billing-response-too-large');
    }
    const text = await response.text();
    if (text.length > 2_000_000) throw new Error('billing-response-too-large');
    return JSON.parse(text);
  }

  async function inspectFetchResponse(kind, response, requestContext) {
    if (!response || !response.ok) return;
    if (!contextTokenMatches(requestContext, runtime)) return;
    try {
      const payload =
        kind === 'billing'
          ? await readBillingJson(response.clone())
          : await response.clone().json();
      if (!contextTokenMatches(requestContext, runtime)) return;
      if (kind === 'billing') acceptBillingStatusPayload(payload, requestContext);
      else acceptPayload(payload, kind, requestContext);
    } catch {
      if (kind === 'current') warn('Could not decode the current usage response as JSON.');
      if (kind === 'billing') warn('Could not decode the workspace billing response.');
    }
  }

  function requestBodyText(input, init, headers = null) {
    // AdGuard can expose a cross-realm Request whose clone().text() settles
    // later. The allow-listed workspace header is enough to build the recipe.
    if (extractSpaceId('', headers)) return Promise.resolve('');
    if (init && Object.prototype.hasOwnProperty.call(init, 'body')) {
      const body = init.body;
      if (typeof body === 'string') return Promise.resolve(body);
      if (isPageInstance(body, 'URLSearchParams')) return Promise.resolve(body.toString());
      return Promise.resolve('');
    }

    if (isPageInstance(input, 'Request')) {
      try {
        return input.clone().text();
      } catch {
        return Promise.resolve('');
      }
    }

    return Promise.resolve('');
  }

  function fetchMetadata(input, init) {
    const isRequest = isPageInstance(input, 'Request');
    const url = isRequest ? input.url : String(input);
    const method = String((init && init.method) || (isRequest && input.method) || 'GET').toUpperCase();
    const headers = (init && init.headers) || (isRequest && input.headers) || {};
    return { url, method, headers };
  }

  function isAiMutation(url, method) {
    if (method === 'GET' || endpointKind(url, root.location.href)) return false;
    try {
      const parsed = new root.URL(url, root.location.href);
      if (parsed.origin !== root.location.origin) return false;
      return /\/(?:runInference|invokeAgent|submitAi|sendAi|createInference)/i.test(
        parsed.pathname,
      );
    } catch {
      return false;
    }
  }

  function installFetchObserver() {
    if (!runtime.nativeFetch) return;
    const nativeFetch = runtime.nativeFetch;

    function observedFetch(input, init) {
      let metadata = null;
      try {
        metadata = fetchMetadata(input, init);
      } catch {
        metadata = null;
      }

      const kind = metadata ? endpointKind(metadata.url, root.location.href) : null;
      const requestSequence = kind ? ++runtime.requestSequence : 0;
      if (kind === 'current') runtime.lastNativeCurrentAt = Date.now();
      const requestContextPromise = kind
        ? requestBodyText(input, init, metadata.headers)
            .then((bodyText) =>
              acceptRecipe(kind, bodyText, metadata.headers, requestSequence),
            )
            .catch(() => null)
        : Promise.resolve(null);

      const result = Reflect.apply(nativeFetch, this, arguments);
      if ((kind === 'current' || kind === 'billing') && result && typeof result.then === 'function') {
        Promise.all([result, requestContextPromise])
          .then(([response, requestContext]) =>
            inspectFetchResponse(kind, response, requestContext),
          )
          .catch(() => undefined);
      } else if (metadata && isAiMutation(metadata.url, metadata.method)) {
        Promise.resolve(result)
          .then((response) => {
            if (response && response.ok) scheduleRefresh('ai-mutation', 4000);
          })
          .catch(() => undefined);
      }
      return result;
    }

    try {
      Object.defineProperty(observedFetch, 'name', { value: 'fetch', configurable: true });
    } catch {
      // Function name preservation is cosmetic.
    }
    try {
      root.fetch = observedFetch;
    } catch {
      warn('Could not install the fetch observer; XHR and active refresh remain available.');
    }
  }

  function installXhrObserver() {
    if (!root.XMLHttpRequest || !root.XMLHttpRequest.prototype) return;
    const prototype = root.XMLHttpRequest.prototype;
    const nativeOpen = prototype.open;
    const nativeSend = prototype.send;
    const nativeSetRequestHeader = prototype.setRequestHeader;
    if (
      typeof nativeOpen !== 'function' ||
      typeof nativeSend !== 'function' ||
      typeof nativeSetRequestHeader !== 'function'
    ) {
      return;
    }
    const metadataByXhr = new WeakMap();

    function observedOpen(method, url) {
      const requestUrl = String(url);
      metadataByXhr.set(this, {
        method: String(method || 'GET').toUpperCase(),
        url: requestUrl,
        kind: endpointKind(requestUrl, root.location.href),
        headers: {},
      });
      return Reflect.apply(nativeOpen, this, arguments);
    }

    function observedSetRequestHeader(name, value) {
      const metadata = metadataByXhr.get(this);
      if (
        metadata &&
        metadata.kind &&
        SAFE_HEADER_NAMES.has(String(name).toLowerCase())
      ) {
        metadata.headers[String(name).toLowerCase()] = String(value);
      }
      return Reflect.apply(nativeSetRequestHeader, this, arguments);
    }

    function observedSend(body) {
      const metadata = metadataByXhr.get(this);
      const kind = metadata ? metadata.kind : null;
      const requestSequence = kind ? ++runtime.requestSequence : 0;
      if (kind === 'current') runtime.lastNativeCurrentAt = Date.now();
      if (kind) {
        const requestContext = acceptRecipe(
          kind,
          typeof body === 'string' ? body : '',
          metadata.headers,
          requestSequence,
        );
        if (kind === 'current' || kind === 'billing') {
          this.addEventListener(
            'loadend',
            () => {
              if (this.status < 200 || this.status >= 300) return;
              if (!contextTokenMatches(requestContext, runtime)) return;
              try {
                let payload;
                if (this.responseType === 'json') {
                  if (kind === 'billing') {
                    const contentLength = finiteNumber(
                      this.getResponseHeader && this.getResponseHeader('content-length'),
                    );
                    if (contentLength === null || contentLength > 2_000_000) {
                      throw new Error('unbounded-billing-response');
                    }
                  }
                  payload = this.response;
                } else {
                  if (this.responseText.length > 2_000_000) {
                    throw new Error('billing-response-too-large');
                  }
                  payload = JSON.parse(this.responseText);
                }
                if (kind === 'billing') acceptBillingStatusPayload(payload, requestContext);
                else acceptPayload(payload, kind, requestContext);
              } catch {
                warn(
                  kind === 'billing'
                    ? 'Could not decode the XHR workspace billing response.'
                    : 'Could not decode the XHR usage response as JSON.',
                );
              }
            },
            { once: true },
          );
        }
      } else if (metadata && isAiMutation(metadata.url, metadata.method)) {
        this.addEventListener(
          'loadend',
          () => {
            if (this.status >= 200 && this.status < 300) scheduleRefresh('ai-xhr-mutation', 4000);
          },
          { once: true },
        );
      }
      return Reflect.apply(nativeSend, this, arguments);
    }

    try {
      prototype.open = observedOpen;
      prototype.setRequestHeader = observedSetRequestHeader;
      prototype.send = observedSend;
    } catch {
      try {
        prototype.open = nativeOpen;
        prototype.setRequestHeader = nativeSetRequestHeader;
        prototype.send = nativeSend;
      } catch {
        // A frozen prototype is safe to leave untouched.
      }
      warn('Could not install the XHR observer; fetch observation remains available.');
    }
  }

  function setFetchError(error) {
    const status = finiteNumber(error && error.status);
    if (status === 401 || status === 403) {
      runtime.activeRefreshDisabled = true;
      runtime.error = uiText(
        '主动读取没有权限；请打开原生用量页触发 Notion 自身请求',
        'Active refresh is not permitted; open the native Usage page to trigger Notion’s request',
      );
    }
    else if (status === 429) {
      runtime.error = uiText('请求过于频繁，稍后自动重试', 'Too many requests; retrying later');
    }
    else if (error && error.name === 'AbortError') {
      runtime.error = uiText('读取用量超时', 'Usage request timed out');
    }
    else runtime.error = uiText('暂时无法读取 Notion AI 用量', 'Unable to load Notion AI usage');
  }

  async function refreshBillingStatus(options = {}) {
    const nowMs = Date.now();
    if (
      !runtime.nativeFetch ||
      !runtime.spaceId ||
      runtime.billingFetching ||
      runtime.billingRefreshDisabled ||
      root.document.hidden
    ) {
      return false;
    }
    if (nowMs < runtime.billingBackoffUntil) return false;
    if (!options.force && nowMs - runtime.lastBillingFetchedAt < BILLING_REFRESH_INTERVAL) {
      return false;
    }
    if (nowMs - runtime.lastBillingAttemptAt < MIN_REFRESH_INTERVAL) return false;

    runtime.billingFetching = true;
    runtime.lastBillingAttemptAt = nowMs;
    const refreshToken = ++runtime.billingRefreshToken;
    const requestedSpaceId = runtime.spaceId;
    const requestedActiveUserId = runtime.activeUserId;
    const requestedContextVersion = runtime.contextVersion;
    const passiveSequenceAtStart = runtime.requestSequence;
    const acceptedBillingResponseSequenceAtStart =
      runtime.acceptedBillingResponseSequence;
    render();

    const controller = new root.AbortController();
    runtime.billingController = controller;
    const timeout = root.setTimeout(() => controller.abort(), 12000);
    try {
      const response = await Reflect.apply(runtime.nativeFetch, root, [
        new root.URL(BILLING_ENDPOINT, root.location.origin).href,
        {
          method: 'POST',
          credentials: 'include',
          cache: 'no-store',
          headers: { ...runtime.recipeHeaders, 'content-type': 'application/json' },
          body: JSON.stringify({ spaceId: requestedSpaceId }),
          signal: controller.signal,
        },
      ]);

      if (!response.ok) {
        const failure = new Error(`HTTP ${response.status}`);
        failure.status = response.status;
        failure.retryAfterSeconds = finiteNumber(
          response.headers && response.headers.get('retry-after'),
        );
        throw failure;
      }

      const payload = await readBillingJson(response);
      if (
        runtime.spaceId !== requestedSpaceId ||
        runtime.activeUserId !== requestedActiveUserId ||
        runtime.contextVersion !== requestedContextVersion
      ) {
        return false;
      }
      if (runtime.acceptedBillingResponseSequence > passiveSequenceAtStart) return false;
      if (!acceptBillingStatusPayload(payload, null, passiveSequenceAtStart)) {
        throw new Error('unsupported-billing-schema');
      }
      return true;
    } catch (error) {
      if (!billingFailureCanCommit(
        {
          spaceId: requestedSpaceId,
          activeUserId: requestedActiveUserId,
          contextVersion: requestedContextVersion,
          acceptedBillingResponseSequence: acceptedBillingResponseSequenceAtStart,
        },
        runtime,
      )) {
        return false;
      }
      const status = finiteNumber(error && error.status);
      runtime.billingError = billingFailureMessage(error);
      if (status === 401 || status === 403) {
        runtime.billingRefreshDisabled = true;
      } else if (status === 429) {
        const retryAfter = nonNegativeNumber(error && error.retryAfterSeconds);
        runtime.billingBackoffUntil = Date.now() + (retryAfter === null ? 60000 : retryAfter * 1000);
      } else if (!(error && error.name === 'AbortError')) {
        runtime.billingBackoffUntil = Date.now() + 15 * 60 * 1000;
      }
      render();
      return false;
    } finally {
      root.clearTimeout(timeout);
      if (runtime.billingRefreshToken === refreshToken) {
        runtime.billingController = null;
        runtime.billingFetching = false;
        render();
      }
    }
  }

  async function refreshUsage(options = {}) {
    const nowMs = Date.now();
    if (
      !runtime.nativeFetch ||
      !runtime.spaceId ||
      runtime.fetching ||
      runtime.activeRefreshDisabled ||
      root.document.hidden
    ) {
      return false;
    }
    if (nowMs < runtime.nextAllowedAt) {
      render();
      return false;
    }
    if (nowMs - runtime.lastFetchedAt < MIN_REFRESH_INTERVAL) return false;
    if (nowMs - runtime.lastAttemptAt < 5000) return false;

    runtime.fetching = true;
    runtime.lastAttemptAt = nowMs;
    const refreshToken = ++runtime.refreshToken;
    const requestedSpaceId = runtime.spaceId;
    const requestedContextVersion = runtime.contextVersion;
    const passiveSequenceAtStart = runtime.requestSequence;
    const acceptedResponseSequenceAtStart = runtime.acceptedCurrentResponseSequence;
    runtime.error = '';
    render();

    const controller = new root.AbortController();
    runtime.activeController = controller;
    const timeout = root.setTimeout(() => controller.abort(), 12000);
    try {
      const response = await Reflect.apply(runtime.nativeFetch, root, [
        new root.URL(CURRENT_ENDPOINT, root.location.origin).href,
        {
          method: 'POST',
          credentials: 'include',
          cache: 'no-store',
          headers: { ...runtime.recipeHeaders, 'content-type': 'application/json' },
          body: JSON.stringify({ spaceId: requestedSpaceId }),
          signal: controller.signal,
        },
      ]);

      if (!response.ok) {
        const failure = new Error(`HTTP ${response.status}`);
        failure.status = response.status;
        const retryAfter = finiteNumber(response.headers && response.headers.get('retry-after'));
        failure.retryAfterSeconds = retryAfter;
        throw failure;
      }

      const payload = await response.json();
      if (
        runtime.spaceId !== requestedSpaceId ||
        runtime.contextVersion !== requestedContextVersion
      ) {
        return false;
      }
      if (runtime.acceptedCurrentResponseSequence > passiveSequenceAtStart) {
        return false;
      }
      if (!acceptPayload(payload, 'current', null, passiveSequenceAtStart)) {
        throw new Error('unsupported-schema');
      }
      return true;
    } catch (error) {
      if (!activeFailureCanCommit(
        {
          spaceId: requestedSpaceId,
          contextVersion: requestedContextVersion,
          acceptedCurrentResponseSequence: acceptedResponseSequenceAtStart,
        },
        runtime,
      )) {
        return false;
      }
      const retryAfter = finiteNumber(error && error.retryAfterSeconds);
      if (finiteNumber(error && error.status) === 429 && retryAfter !== null) {
        runtime.nextAllowedAt = Date.now() + retryAfter * 1000;
      }
      setFetchError(error);
      runtime.backoffMs = runtime.backoffMs
        ? Math.min(runtime.backoffMs * 2, 5 * 60 * 1000)
        : 15000;
      runtime.nextAllowedAt = Math.max(runtime.nextAllowedAt, Date.now() + runtime.backoffMs);
      render();
      return false;
    } finally {
      root.clearTimeout(timeout);
      if (runtime.refreshToken === refreshToken) {
        runtime.activeController = null;
        runtime.fetching = false;
        render();
        if (runtime.contextVersion !== requestedContextVersion) {
          scheduleRefresh('context-changed', 0);
        }
      }
    }
  }

  function scheduleRefresh(reason, delayMs) {
    if (!runtime.spaceId || root.document.hidden) return;
    const nowMs = Date.now();
    const requestedAt = nowMs + Math.max(0, finiteNumber(delayMs) || 0);
    const dueAt = Math.max(
      requestedAt,
      runtime.nextAllowedAt,
      runtime.lastFetchedAt ? runtime.lastFetchedAt + MIN_REFRESH_INTERVAL : 0,
      runtime.lastAttemptAt ? runtime.lastAttemptAt + 5000 : 0,
    );
    if (runtime.refreshTimer && runtime.refreshDueAt <= dueAt) return;
    if (runtime.refreshTimer) root.clearTimeout(runtime.refreshTimer);
    runtime.refreshDueAt = dueAt;
    runtime.refreshTimer = root.setTimeout(() => {
      runtime.refreshTimer = null;
      runtime.refreshDueAt = 0;
      refreshUsage({ force: false, reason });
    }, Math.max(0, dueAt - nowMs));
  }

  function scheduleBillingRefresh(reason, delayMs) {
    if (!runtime.spaceId || root.document.hidden || runtime.billingRefreshDisabled) return;
    const nowMs = Date.now();
    const requestedAt = nowMs + Math.max(0, finiteNumber(delayMs) || 0);
    const dueAt = Math.max(
      requestedAt,
      runtime.billingBackoffUntil,
      runtime.lastBillingAttemptAt
        ? runtime.lastBillingAttemptAt + MIN_REFRESH_INTERVAL
        : 0,
    );
    if (runtime.billingRefreshTimer && runtime.billingRefreshDueAt <= dueAt) return;
    if (runtime.billingRefreshTimer) root.clearTimeout(runtime.billingRefreshTimer);
    runtime.billingRefreshDueAt = dueAt;
    runtime.billingRefreshTimer = root.setTimeout(() => {
      runtime.billingRefreshTimer = null;
      runtime.billingRefreshDueAt = 0;
      refreshBillingStatus({ force: false, reason });
    }, Math.max(0, dueAt - nowMs));
  }

  function runHeartbeat() {
    ensureUi();
    render();
    if (root.document.hidden || !runtime.spaceId) return;

    const nowMs = Date.now();
    const trialEnded = Boolean(
      runtime.billingStatus &&
        runtime.billingStatus.kind === 'trial' &&
        !activeBusinessTrial(runtime.billingStatus, nowMs),
    );
    if (
      !runtime.billingFetching &&
      (trialEnded || nowMs - runtime.lastBillingFetchedAt >= BILLING_REFRESH_INTERVAL)
    ) {
      refreshBillingStatus({ force: trialEnded, reason: trialEnded ? 'trial-ended' : 'heartbeat' });
    }
    if (runtime.fetching) return;

    const referenceTime = Math.max(runtime.lastFetchedAt, runtime.lastAttemptAt);
    if (nowMs - referenceTime >= pollingInterval(runtime.snapshot)) {
      refreshUsage({ force: false, reason: 'heartbeat' });
    }
  }

  function installEnvironmentObserver() {
    if (typeof root.MutationObserver !== 'function') return;

    const observerOptions = {
      attributes: true,
      attributeFilter: ['lang', 'class', 'style', 'data-theme', 'data-mode'],
    };
    let environmentObserver = null;
    let observedBody = null;

    const observeBody = () => {
      if (
        environmentObserver &&
        root.document.body &&
        root.document.body !== observedBody
      ) {
        observedBody = root.document.body;
        environmentObserver.observe(observedBody, observerOptions);
      }
    };

    const startObserver = () => {
      if (environmentObserver || !root.document.documentElement) return;
      environmentObserver = new root.MutationObserver(() => {
        observeBody();
        render();
      });
      environmentObserver.observe(root.document.documentElement, {
        ...observerOptions,
        childList: true,
      });
      observeBody();
    };

    startObserver();
    if (root.document.readyState === 'loading') {
      root.document.addEventListener(
        'DOMContentLoaded',
        () => {
          startObserver();
          observeBody();
          render();
        },
        { once: true },
      );
    }
  }

  installFetchObserver();
  installXhrObserver();
  mountUi();
  installEnvironmentObserver();

  if (!root.document.body) {
    root.document.addEventListener('DOMContentLoaded', mountUi, { once: true });
  }

  root.document.addEventListener('visibilitychange', () => {
    if (!root.document.hidden) runHeartbeat();
  });
  root.addEventListener('resize', keepOverlayInViewport, { passive: true });
  root.addEventListener('scroll', scheduleMinimizedDock, { capture: true, passive: true });
  root.addEventListener('focusin', scheduleMinimizedDock, { capture: true, passive: true });
  if (root.visualViewport) {
    root.visualViewport.addEventListener('resize', scheduleMinimizedDock, { passive: true });
    root.visualViewport.addEventListener('scroll', scheduleMinimizedDock, { passive: true });
  }
  root.addEventListener('storage', handleOverlayPositionStorage);
  root.setInterval(runHeartbeat, 30000);
  root.setInterval(ensureUi, 2500);
})(
  typeof unsafeWindow !== 'undefined'
    ? unsafeWindow
    : typeof window !== 'undefined'
      ? window
      : globalThis,
);
