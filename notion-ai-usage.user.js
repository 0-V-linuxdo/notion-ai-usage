// ==UserScript==
// @name         [Notion AI] Usage [20260730] v1.0.0
// @namespace    https://github.com/0-V-linuxdo/notion-ai-usage
// @version      20260730.1.0.0
// @description  Show Notion AI usage and Business Trial time without exposing cookies or tokens.
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
  const SPACE_ID_PATTERN = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
  const PLAN_RANK = new Map([
    ['free', 0],
    ['student', 1],
    ['personal', 2],
    ['plus', 3],
    ['business', 4],
    ['enterprise', 5],
  ]);

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
    return selected || 'free';
  }

  function normalizeBusinessTrial(payload, nowMs = Date.now()) {
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
    if (!hasSubscriptionTrial && !hasSeparateTrial) {
      return { status: 'none', updatedAt: nowMs };
    }

    const endRaw = hasSubscriptionTrial ? subscriptionEndRaw : separateEndRaw;
    const startRaw = hasSubscriptionTrial
      ? subscription && subscription.startDate
      : separateTrial && separateTrial.startDate;
    const endAt = parseIsoTimestamp(endRaw);
    const startAt = parseIsoTimestamp(startRaw);
    if (endAt === null) return null;
    if (typeof startRaw === 'string' && (startAt === null || startAt > endAt)) return null;

    const clock = isRecord(billingData.clock) ? billingData.clock : null;
    const serverClockRaw = clock && clock.externalId ? clock.now : null;
    const serverClockAt = parseIsoTimestamp(serverClockRaw);
    const usesServerClock = serverClockAt !== null;
    const referenceNowAt = usesServerClock ? serverClockAt : nowMs;
    if (endAt - referenceNowAt > 2 * 366 * 86400000) return null;

    const activeItems = hasSubscriptionTrial
      ? itemList(subscription && subscription.items)
      : [
          ...itemList(separateTrial && separateTrial.items),
          ...itemList(subscription && subscription.items),
        ].slice(0, 80);
    const plan = highestPlanProduct(activeItems);

    if (endAt <= referenceNowAt || plan !== 'business') {
      return { status: 'none', updatedAt: nowMs };
    }

    return {
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

  function localStartOfDay(timestamp) {
    const local = new Date(timestamp);
    if (!Number.isFinite(local.getTime())) return null;
    local.setHours(0, 0, 0, 0);
    return local.getTime();
  }

  function businessTrialReferenceNow(trial, nowMs = Date.now()) {
    if (!trial || trial.status !== 'active') return null;
    return trial.usesServerClock ? trial.referenceNowAt : nowMs;
  }

  function businessTrialDaysRemaining(trial, nowMs = Date.now()) {
    const referenceNow = businessTrialReferenceNow(trial, nowMs);
    if (referenceNow === null || trial.endAt <= referenceNow) return 0;
    const startOfDay = localStartOfDay(referenceNow);
    if (startOfDay === null) return 0;
    return Math.max(0, Math.ceil((trial.endAt - startOfDay) / 86400000));
  }

  function activeBusinessTrial(trial, nowMs = Date.now()) {
    const referenceNow = businessTrialReferenceNow(trial, nowMs);
    return referenceNow !== null && trial.endAt > referenceNow ? trial : null;
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

  const testExports = {
    BILLING_ENDPOINT,
    CURRENT_ENDPOINT,
    LEGACY_ENDPOINT,
    activeFailureCanCommit,
    activeBusinessTrial,
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
    contextTokenMatches,
    cssColorTheme,
    currentUiLanguage,
    currentUiTheme,
    normalizeVerdict,
    normalizeBusinessTrial,
    percentage,
    pollingInterval,
    mergeRecipeHeaders,
    requestBodyText,
    responseSequenceIsFresh,
    safeHeaders,
    shouldBootstrapInFrame,
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
    businessTrial: null,
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
    ui: null,
  };

  function warn(message) {
    try {
      root.console.warn(`${SCRIPT_PREFIX} ${message}`);
    } catch {
      // Ignore logging failures.
    }
  }

  function setExpanded(expanded) {
    if (!runtime.ui) return;
    runtime.ui.expanded = expanded;
    runtime.ui.card.hidden = !expanded;
    runtime.ui.summary.setAttribute('aria-expanded', String(expanded));
    runtime.ui.chevron.textContent = expanded ? '▴' : '▾';
    try {
      root.localStorage.setItem(EXPANDED_KEY, expanded ? '1' : '0');
    } catch {
      // Preference persistence is optional.
    }
  }

  function metricTone(percent) {
    if (percent >= 90) return 'danger';
    if (percent >= 70) return 'warning';
    return 'normal';
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

  function renderBusinessTrial(elements, trial, nowMs) {
    if (!trial) {
      elements.row.hidden = true;
      return;
    }
    const remainingDays = businessTrialDaysRemaining(trial, nowMs);
    const endsToday = businessTrialEndsToday(trial, nowMs);
    elements.row.hidden = false;
    elements.label.textContent = uiText('Business 试用', 'Business Trial');
    elements.remaining.textContent = endsToday
      ? uiText('今天结束', 'Ends today')
      : uiText(`剩余 ${remainingDays} 天`, `${remainingDays} days left`);
    elements.end.textContent = formatTrialEnd(trial.endAt);
    elements.row.title = uiText(
      `Business 试用：${formatAbsoluteTime(trial.startAt)} — ${formatAbsoluteTime(trial.endAt)}`,
      `Business Trial: ${formatAbsoluteTime(trial.startAt)} — ${formatAbsoluteTime(trial.endAt)}`,
    );
  }

  function setSummaryParts(container, parts) {
    const values = parts.filter((part) => typeof part === 'string' && part.length > 0);
    const nodes = values.map((value) => {
      const part = container.ownerDocument.createElement('span');
      part.className = 'summary-part';
      part.textContent = value;
      return part;
    });
    container.replaceChildren(...nodes);
    container.setAttribute('aria-label', values.join('，'));
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
    ui.nativePage.textContent = uiText('原生用量页', 'Native Usage');
  }

  function render() {
    const ui = runtime.ui;
    if (!ui) return;
    const snapshot = runtime.snapshot;
    const nowMs = Date.now();
    const trial = activeBusinessTrial(runtime.businessTrial, nowMs);
    const trialDays = trial ? businessTrialDaysRemaining(trial, nowMs) : null;
    const trialPart = trial
      ? businessTrialEndsToday(trial, nowMs)
        ? uiText('试用 今天结束', 'Trial ends today')
        : uiText(`试用 ${trialDays}天`, `Trial ${trialDays}d`)
      : null;

    const cooldownUntil = runtime.lastFetchedAt + MIN_REFRESH_INTERVAL;
    const isLoading = runtime.fetching || runtime.billingFetching;
    updateStaticUiCopy(ui, isLoading, snapshot && snapshot.enforcement === 'preview');
    ui.refresh.disabled =
      isLoading ||
      (runtime.activeRefreshDisabled && runtime.billingRefreshDisabled) ||
      !runtime.spaceId ||
      nowMs < Math.max(runtime.nextAllowedAt, cooldownUntil);
    renderBusinessTrial(ui.trial, trial, nowMs);

    if (!snapshot) {
      setSummaryParts(ui.summaryText, [
        uiText('AI 用量', 'AI Usage'),
        trialPart ||
          (runtime.fetching || runtime.billingFetching
            ? uiText('读取中', 'Loading')
            : uiText('等待', 'Waiting')),
      ]);
      ui.dot.dataset.status = runtime.error ? 'error' : 'waiting';
      ui.notice.hidden = false;
      ui.notice.dataset.kind = runtime.error ? 'error' : 'info';
      ui.notice.textContent =
        runtime.error ||
        (runtime.spaceId
          ? uiText('正在读取 Notion AI 用量…', 'Loading Notion AI usage…')
          : uiText(
              '等待 Notion 初始化当前工作区；也可以打开原生用量页触发读取。',
              'Waiting for Notion to initialize this workspace. You can also open the native Usage page.',
            ));
      ui.rolling.row.hidden = true;
      ui.monthly.row.hidden = true;
      ui.metrics.hidden = !trial;
      ui.updated.textContent = trial
        ? uiText(
            `${formatUpdated(trial.updatedAt, nowMs)} — Notion 同源接口`,
            `${formatUpdated(trial.updatedAt, nowMs)} — Notion same-origin API`,
          )
        : uiText('尚未取得有效数据', 'No valid data yet');
      return;
    }

    if (snapshot.status === 'not_applicable') {
      setSummaryParts(ui.summaryText, [
        uiText('AI 用量', 'AI Usage'),
        uiText('不适用', 'Not applicable'),
        trialPart,
      ]);
      ui.dot.dataset.status = 'neutral';
      ui.notice.hidden = false;
      ui.notice.dataset.kind = 'info';
      ui.notice.textContent = uiText(
        'Notion 返回 not_applicable：当前账户或套餐没有可展示的 AI 用量窗口。',
        'Notion returned not_applicable: this account or plan has no AI usage window to display.',
      );
      ui.rolling.row.hidden = true;
      ui.monthly.row.hidden = true;
      ui.metrics.hidden = !trial;
    } else {
      const activeMonthly =
        snapshot.monthly && snapshot.monthly.resetAt > nowMs ? snapshot.monthly : null;
      setSummaryParts(ui.summaryText, [
        `AI ${formatPercent(snapshot.rolling.percent)}`,
        activeMonthly ? formatPercent(activeMonthly.percent) : null,
        trialPart,
      ]);
      ui.dot.dataset.status = snapshot.status === 'rate_limited' ? 'error' : 'ok';
      ui.metrics.hidden = false;

      renderMetric(ui.rolling, snapshot.rolling, formatWindowLabel(snapshot.rolling.window), nowMs);
      renderMetric(ui.monthly, activeMonthly, uiText('月度用量', 'Monthly usage'), nowMs);

      if (snapshot.status === 'rate_limited') {
        ui.notice.hidden = false;
        ui.notice.dataset.kind = 'error';
        ui.notice.textContent =
          snapshot.limitedBy === 'billing_period'
            ? uiText('已达到月度额度上限。', 'The monthly allowance has been reached.')
            : uiText(
                '已达到当前滚动窗口的额度上限。',
                'The current rolling-window allowance has been reached.',
              );
      } else if (runtime.error) {
        ui.notice.hidden = false;
        ui.notice.dataset.kind = 'error';
        ui.notice.textContent = uiText(
          `${runtime.error}（继续显示最后一次有效数据）`,
          `${runtime.error} (showing the last valid data)`,
        );
      } else {
        ui.notice.hidden = true;
      }
    }

    const newestUpdate = Math.max(snapshot.updatedAt, trial ? trial.updatedAt : 0);
    ui.updated.textContent = uiText(
      `${formatUpdated(newestUpdate, nowMs)} — Notion 同源接口`,
      `${formatUpdated(newestUpdate, nowMs)} — Notion same-origin API`,
    );
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

  function buildTrialRow(documentRef) {
    const row = documentRef.createElement('div');
    row.className = 'metric trial';
    row.dataset.metric = 'business-trial';
    row.innerHTML = trustedHtml(`
      <div class="metric-head">
        <span class="metric-label">Business Trial</span>
        <span class="trial-remaining"></span>
      </div>
      <div class="metric-reset trial-end"></div>
    `);
    return {
      row,
      label: row.querySelector('.metric-label'),
      remaining: row.querySelector('.trial-remaining'),
      end: row.querySelector('.trial-end'),
    };
  }

  function mountUi() {
    if (!root.document.body) return;
    const existingHost = root.document.getElementById(HOST_ID);
    if (existingHost && runtime.ui && existingHost === runtime.ui.host) return;
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
          --usage-trial: #d9c4ff;
          --usage-info-text: #c6dfff;
          --usage-info-bg: rgba(58,132,217,.14);
          --usage-error-text: #ffc5c5;
          --usage-error-bg: rgba(221,70,70,.14);
          --usage-tooltip-text: #f7f7f5;
          --usage-tooltip-bg: #2f2f2f;
          --usage-tooltip-border: rgba(255,255,255,.12);
          --usage-shadow: 0 14px 42px rgba(0,0,0,.36);
          position: fixed;
          top: 16px;
          right: 16px;
          z-index: 2147483646;
          width: min(336px, calc(100vw - 24px));
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
          --usage-trial: #6940a5;
          --usage-info-text: #24588f;
          --usage-info-bg: rgba(46,119,190,.11);
          --usage-error-text: #a62d2f;
          --usage-error-bg: rgba(190,46,48,.10);
          --usage-tooltip-text: #252525;
          --usage-tooltip-bg: #fff;
          --usage-tooltip-border: rgba(15,15,15,.12);
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
        .summary {
          pointer-events: auto;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          min-height: 34px;
          max-width: 100%;
          padding: 7px 11px;
          border: 1px solid var(--usage-border);
          border-radius: 999px;
          color: var(--usage-text);
          background: var(--usage-summary);
          box-shadow: 0 7px 24px rgba(0,0,0,.20);
          backdrop-filter: blur(14px);
          cursor: pointer;
        }
        .summary:hover { background: var(--usage-summary-hover); }
        .summary:focus-visible, .action:focus-visible {
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
        .summary-part:nth-child(2)::before {
          content: "·";
          display: inline;
          margin: 0 9px;
          color: var(--usage-muted);
        }
        .summary-part:nth-child(n+3)::before {
          content: "";
          display: inline-block;
          width: 1px;
          height: 14px;
          margin: 0 9px;
          vertical-align: -2px;
          background: var(--usage-divider);
        }
        .chevron { color: var(--usage-muted); font-size: 11px; }
        .card {
          pointer-events: auto;
          width: 100%;
          overflow: hidden;
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
        }
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
        .trial-remaining {
          color: var(--usage-trial);
          font-weight: 650;
          font-variant-numeric: tabular-nums;
        }
        .trial-end { margin-top: 5px; }
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
        .footer-actions { display: flex; gap: 5px; }
        @media (max-width: 520px) {
          :host { top: 9px; right: 9px; width: min(324px, calc(100vw - 18px)); }
        }
        @media (prefers-reduced-motion: reduce) {
          .bar-fill { transition: none; }
          .refresh.is-loading svg { animation: none; opacity: .55; }
          .preview-tooltip { transition: none; }
        }
      </style>
      <div class="shell">
        <button class="summary" type="button" aria-expanded="false" aria-controls="notion-ai-usage-card">
          <span class="dot" data-status="waiting" aria-hidden="true"></span>
          <span class="summary-text">
            <span class="summary-part">AI Usage</span>
            <span class="summary-part">Waiting</span>
          </span>
          <span class="chevron" aria-hidden="true">▾</span>
        </button>
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
              <button class="action native-page" type="button">原生用量页</button>
            </span>
          </div>
        </section>
      </div>
    `);

    const metrics = shadow.querySelector('.metrics');
    const rolling = buildMetricRow(root.document, 'rolling');
    const monthly = buildMetricRow(root.document, 'monthly');
    const trial = buildTrialRow(root.document);
    metrics.append(rolling.row, monthly.row, trial.row);

    runtime.ui = {
      host,
      shadow,
      summary: shadow.querySelector('.summary'),
      summaryText: shadow.querySelector('.summary-text'),
      dot: shadow.querySelector('.dot'),
      chevron: shadow.querySelector('.chevron'),
      card: shadow.querySelector('.card'),
      title: shadow.querySelector('.title'),
      previewHelp: shadow.querySelector('.preview-help'),
      previewTooltip: shadow.querySelector('.preview-tooltip'),
      notice: shadow.querySelector('.notice'),
      metrics,
      rolling,
      monthly,
      trial,
      refresh: shadow.querySelector('.refresh'),
      nativePage: shadow.querySelector('.native-page'),
      updated: shadow.querySelector('.updated'),
      expanded: false,
    };

    runtime.ui.summary.addEventListener('click', () => setExpanded(!runtime.ui.expanded));
    runtime.ui.refresh.addEventListener('click', () => {
      refreshBusinessTrial({ force: true, reason: 'manual' });
      refreshUsage({ force: true, reason: 'manual' });
    });
    runtime.ui.nativePage.addEventListener('click', () => {
      const target = new root.URL(root.location.href);
      target.searchParams.set('target', 'aiusage');
      root.location.assign(target.href);
    });

    root.document.body.appendChild(host);
    let expanded = false;
    try {
      expanded = root.localStorage.getItem(EXPANDED_KEY) === '1';
    } catch {
      expanded = false;
    }
    setExpanded(expanded);
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
      runtime.businessTrial = null;
      runtime.acceptedCurrentResponseSequence = 0;
      runtime.acceptedBillingResponseSequence = 0;
      runtime.lastAttemptAt = 0;
      runtime.lastFetchedAt = 0;
      runtime.lastBillingFetchedAt = 0;
      runtime.lastBillingAttemptAt = 0;
      runtime.billingBackoffUntil = 0;
      runtime.error = '';
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

  function acceptBusinessTrialPayload(payload, requestContext = null, sequenceFloor = null) {
    if (requestContext && !contextTokenMatches(requestContext, runtime)) return false;
    if (
      requestContext &&
      !responseSequenceIsFresh(requestContext, runtime.acceptedBillingResponseSequence)
    ) {
      return false;
    }

    // Project the billing response immediately to a minimal trial-only object.
    // Addresses, payment methods, invoices, balances, and dependencies are never retained.
    const normalized = normalizeBusinessTrial(payload);
    if (!normalized) {
      warn('Unsupported getBillingData trial schema; keeping the last valid trial state.');
      return false;
    }

    runtime.businessTrial = normalized.status === 'active' ? normalized : null;
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
      if (kind === 'billing') acceptBusinessTrialPayload(payload, requestContext);
      else acceptPayload(payload, kind, requestContext);
    } catch {
      if (kind === 'current') warn('Could not decode the current usage response as JSON.');
      if (kind === 'billing') warn('Could not decode the Business Trial billing response.');
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
                if (kind === 'billing') acceptBusinessTrialPayload(payload, requestContext);
                else acceptPayload(payload, kind, requestContext);
              } catch {
                warn(
                  kind === 'billing'
                    ? 'Could not decode the XHR Business Trial response.'
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

  async function refreshBusinessTrial(options = {}) {
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
      if (!acceptBusinessTrialPayload(payload, null, passiveSequenceAtStart)) {
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
      refreshBusinessTrial({ force: false, reason });
    }, Math.max(0, dueAt - nowMs));
  }

  function runHeartbeat() {
    ensureUi();
    render();
    if (root.document.hidden || !runtime.spaceId) return;

    if (
      !runtime.billingFetching &&
      Date.now() - runtime.lastBillingFetchedAt >= BILLING_REFRESH_INTERVAL
    ) {
      refreshBusinessTrial({ force: false, reason: 'heartbeat' });
    }
    if (runtime.fetching) return;

    const referenceTime = Math.max(runtime.lastFetchedAt, runtime.lastAttemptAt);
    if (Date.now() - referenceTime >= pollingInterval(runtime.snapshot)) {
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
  root.setInterval(runHeartbeat, 30000);
  root.setInterval(ensureUi, 2500);
})(
  typeof unsafeWindow !== 'undefined'
    ? unsafeWindow
    : typeof window !== 'undefined'
      ? window
      : globalThis,
);
