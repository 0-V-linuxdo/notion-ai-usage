'use strict';

process.env.TZ = 'Asia/Shanghai';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  BILLING_ENDPOINT,
  CURRENT_ENDPOINT,
  LEGACY_ENDPOINT,
  activeFailureCanCommit,
  activeBillingStatus,
  activeBusinessTrial,
  billingFailureMessage,
  billingSummaryPart,
  billingFailureCanCommit,
  businessTrialDaysRemaining,
  businessTrialEndsToday,
  clampOverlayPosition,
  cssColorTheme,
  contextTokenMatches,
  currentUiLanguage,
  currentUiTheme,
  dragPosition,
  dragThresholdReached,
  endpointKind,
  extractSpaceId,
  fetchMetadata,
  findCreditVerdict,
  formatPercent,
  formatReset,
  isNotionPageUrl,
  normalizeBillingStatus,
  normalizeBusinessTrial,
  normalizeVerdict,
  percentage,
  parseOverlayPosition,
  planDisplayName,
  pollingInterval,
  preferredVerticalSide,
  mergeRecipeHeaders,
  requestBodyText,
  responseSequenceIsFresh,
  safeHeaders,
  shouldBootstrapInFrame,
  subscriptionStatusText,
  summaryClickTransition,
  uiText,
  usageRefreshPlan,
} = require('../notion-ai-usage.user.js');

const NOW = 1785360000000;
const SPACE_ID = '12345678-1234-4abc-8def-1234567890ab';
const SCRIPT_PATH = path.resolve(__dirname, '../notion-ai-usage.user.js');
const PACKAGE_PATH = path.resolve(__dirname, '../package.json');

test('uses AdGuard-compatible metadata and unsafeWindow realm constructors', () => {
  const source = fs.readFileSync(SCRIPT_PATH, 'utf8');
  assert.match(source, /^\/\/ @name\s+\[Notion AI\] Usage \[20260730\] v1\.1\.0$/m);
  assert.match(source, /^\/\/ @namespace\s+https:\/\/github\.com\/0-V-linuxdo\/notion-ai-usage$/m);
  assert.match(source, /^\/\/ @version\s+20260730\.1\.1\.0$/m);
  assert.match(source, /^\/\/ @homepageURL\s+https:\/\/github\.com\/0-V-linuxdo\/notion-ai-usage$/m);
  assert.match(source, /^\/\/ @supportURL\s+https:\/\/github\.com\/0-V-linuxdo\/notion-ai-usage\/issues$/m);
  assert.match(source, /^\/\/ @downloadURL\s+https:\/\/raw\.githubusercontent\.com\/0-V-linuxdo\/notion-ai-usage\/main\/notion-ai-usage\.user\.js$/m);
  assert.match(source, /^\/\/ @updateURL\s+https:\/\/raw\.githubusercontent\.com\/0-V-linuxdo\/notion-ai-usage\/main\/notion-ai-usage\.user\.js$/m);
  assert.doesNotMatch(source, /^\/\/ @author\b/m);
  assert.match(source, /^\/\/ @grant\s+unsafeWindow$/m);
  assert.match(source, /^\/\/ @inject-into\s+page$/m);
  assert.doesNotMatch(source, /^\/\/ @noframes\b/m);
  assert.doesNotMatch(source, /root\.top\s*!==\s*root\.self/);
  assert.match(source, /ADG_policyApi\.createHTML\(html\)/);
  assert.ok(
    source.indexOf('!shouldBootstrapInFrame(root)') <
      source.indexOf('root.__notionAiUsageUserscriptV1 = true'),
  );

  const pageRealm = vm.runInNewContext(`({
    Request: class PageRequest {
      constructor(url, init = {}) {
        this.url = url;
        this.method = init.method || 'GET';
        this.headers = init.headers || {};
      }
    },
  })`);
  const freshModulePath = require.resolve(SCRIPT_PATH);
  global.unsafeWindow = pageRealm;
  delete require.cache[freshModulePath];
  try {
    const isolatedExports = require(freshModulePath);
    const request = new pageRealm.Request('https://app.notion.com/api/v3/getCreditRateLimitStatus', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    assert.deepEqual(isolatedExports.fetchMetadata(request), {
      url: request.url,
      method: 'POST',
      headers: request.headers,
    });
  } finally {
    delete global.unsafeWindow;
    delete require.cache[freshModulePath];
  }
});

test('keeps package and display release metadata aligned', () => {
  const packageJson = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
  assert.equal(packageJson.name, 'notion-ai-usage');
  assert.equal(packageJson.version, '1.1.0');
  assert.equal(packageJson.releaseLabel, '[20260730] v1.1.0');
  assert.equal(
    packageJson.repository.url,
    'git+https://github.com/0-V-linuxdo/notion-ai-usage.git',
  );
});

function makeFrameWindow(href, ancestorOrigins = []) {
  const windowRef = {
    document: { referrer: '' },
    location: { href, ancestorOrigins },
  };
  windowRef.parent = windowRef;
  windowRef.self = windowRef;
  windowRef.top = windowRef;
  return windowRef;
}

test('runs in a top-level Notion page and a Tabbit-hosted Notion iframe', () => {
  const topLevel = makeFrameWindow('https://app.notion.com/ai');
  assert.equal(shouldBootstrapInFrame(topLevel), true);

  const tabbitFrame = makeFrameWindow(
    'https://app.notion.com/ai',
    ['chrome-extension://kplgajidbllaeekcfpcdcbocbhppbind'],
  );
  tabbitFrame.document.referrer = 'https://app.notion.com/';
  const crossOriginParent = {};
  Object.defineProperty(crossOriginParent, 'location', {
    get() {
      const error = new Error('Blocked a frame with origin from accessing a cross-origin frame.');
      error.name = 'SecurityError';
      throw error;
    },
  });
  tabbitFrame.parent = crossOriginParent;

  assert.equal(shouldBootstrapInFrame(tabbitFrame), true);
});

test('skips nested Notion frames but not similarly named hostile hosts', () => {
  const nested = makeFrameWindow(
    'https://app.notion.com/ai',
    ['https://www.notion.so'],
  );
  assert.equal(shouldBootstrapInFrame(nested), false);

  const notionParent = makeFrameWindow('https://app.notion.com/workspace');
  const bridge = makeFrameWindow('about:blank');
  bridge.parent = notionParent;
  const child = makeFrameWindow('https://app.notion.com/ai');
  child.parent = bridge;
  assert.equal(shouldBootstrapInFrame(child), false);

  assert.equal(isNotionPageUrl('https://app.notion.com/ai'), true);
  assert.equal(isNotionPageUrl('https://app.notion.com.evil.example/ai'), false);
  assert.equal(shouldBootstrapInFrame(makeFrameWindow('https://example.com/')), false);
});

test('matches preview tooltip colors to Notion light and dark themes', () => {
  const source = fs.readFileSync(SCRIPT_PATH, 'utf8');
  const darkTheme = source.match(/:host \{([\s\S]*?)\n        \}/)?.[1] || '';
  const lightTheme =
    source.match(/:host\(\[data-theme="light"\]\) \{([\s\S]*?)\n        \}/)?.[1] || '';

  assert.match(darkTheme, /--usage-tooltip-text:\s*#f7f7f5;/);
  assert.match(darkTheme, /--usage-tooltip-bg:\s*#2f2f2f;/);
  assert.match(darkTheme, /--usage-tooltip-border:\s*rgba\(255,255,255,\.12\);/);
  assert.match(lightTheme, /--usage-tooltip-text:\s*#252525;/);
  assert.match(lightTheme, /--usage-tooltip-bg:\s*#fff;/);
  assert.match(lightTheme, /--usage-tooltip-border:\s*rgba\(15,15,15,\.12\);/);
  const tooltipRule = source.match(/\.preview-tooltip \{([\s\S]*?)\n        \}/)?.[1] || '';
  assert.match(tooltipRule, /border:\s*1px solid var\(--usage-tooltip-border\);/);
  assert.match(tooltipRule, /color:\s*var\(--usage-tooltip-text\);/);
  assert.match(tooltipRule, /background:\s*var\(--usage-tooltip-bg\);/);
});

test('clamps dragged overlay coordinates to the visible viewport', () => {
  assert.deepEqual(
    clampOverlayPosition(
      { left: 900, top: 700 },
      { width: 1000, height: 800 },
      { width: 336, height: 200 },
    ),
    { left: 656, top: 592 },
  );
  assert.deepEqual(
    clampOverlayPosition(
      { left: -50, top: -20 },
      { width: 1000, height: 800 },
      { width: 336, height: 200 },
    ),
    { left: 8, top: 8 },
  );
  assert.deepEqual(
    clampOverlayPosition(
      { left: 40, top: 30 },
      { width: 200, height: 100 },
      { width: 300, height: 120 },
    ),
    { left: 8, top: 8 },
  );
  assert.equal(
    preferredVerticalSide(
      { top: 20, bottom: 58 },
      300,
      { width: 1000, height: 800 },
    ),
    'down',
  );
  assert.equal(
    preferredVerticalSide(
      { top: 650, bottom: 688 },
      300,
      { width: 1000, height: 800 },
    ),
    'up',
  );
});

test('calculates drag movement and latches only after the movement threshold', () => {
  assert.deepEqual(
    dragPosition(
      { left: 100, top: 80 },
      { x: 10, y: 20 },
      { x: 50, y: 70 },
      { width: 500, height: 400 },
      { width: 100, height: 90 },
    ),
    { left: 140, top: 130 },
  );
  assert.equal(dragThresholdReached(false, { x: 0, y: 0 }, { x: 2, y: 3 }), false);
  assert.equal(dragThresholdReached(false, { x: 0, y: 0 }, { x: 4, y: 0 }), true);
  assert.equal(dragThresholdReached(true, null, null), true);
});

test('accepts only finite versioned overlay positions and consumes one drag click', () => {
  assert.deepEqual(
    parseOverlayPosition('{"v":1,"left":100.5,"top":80}'),
    { left: 100.5, top: 80 },
  );
  assert.deepEqual(
    parseOverlayPosition(
      '{"v":1,"left":100,"top":80,"side":"left","verticalSide":"up"}',
    ),
    { left: 100, top: 80, side: 'left', verticalSide: 'up' },
  );
  assert.equal(parseOverlayPosition('{"v":2,"left":100,"top":80}'), null);
  assert.equal(parseOverlayPosition('{"v":1,"left":"100","top":80}'), null);
  assert.equal(parseOverlayPosition('{"v":1,"left":null,"top":80}'), null);
  assert.equal(parseOverlayPosition('[1,2]'), null);
  assert.equal(parseOverlayPosition('not json'), null);

  assert.deepEqual(summaryClickTransition(false, false), {
    expanded: true,
    suppressNextClick: false,
  });
  assert.deepEqual(summaryClickTransition(true, true), {
    expanded: true,
    suppressNextClick: false,
  });
});

test('wires pointer dragging, persistence, and roomier capsule spacing', () => {
  const source = fs.readFileSync(SCRIPT_PATH, 'utf8');
  assert.match(source, /const POSITION_KEY = 'notion-ai-usage:position:v1';/);
  assert.match(source, /handle\.addEventListener\('pointerdown'/);
  assert.match(source, /handle\.addEventListener\('pointermove'/);
  assert.match(source, /handle\.addEventListener\('pointerup'/);
  assert.match(source, /handle\.addEventListener\('pointercancel'/);
  assert.match(source, /handle\.setPointerCapture\(event\.pointerId\)/);
  assert.match(source, /installDragHandle\(runtime\.ui\.summary, \{ suppressClick: true \}\)/);
  assert.match(source, /installDragHandle\(runtime\.ui\.header, \{ ignoreInteractive: true \}\)/);
  assert.match(source, /root\.addEventListener\('resize', \(\) => keepOverlayInViewport\(true\)/);

  const summaryRule = source.match(/\.summary \{([\s\S]*?)\n        \}/)?.[1] || '';
  const headerRule = source.match(/\.header \{([\s\S]*?)\n        \}/)?.[1] || '';
  assert.match(summaryRule, /gap:\s*var\(--usage-summary-item-gap\);/);
  assert.match(summaryRule, /min-height:\s*38px;/);
  assert.match(summaryRule, /padding:\s*8px 13px;/);
  assert.match(summaryRule, /touch-action:\s*none;/);
  assert.match(summaryRule, /user-select:\s*none;/);
  assert.match(headerRule, /cursor:\s*grab;/);
  assert.match(headerRule, /touch-action:\s*none;/);
  assert.match(source, /\.summary-part:first-child \{ word-spacing: 2px; \}/);
  assert.match(source, /\.summary-part\[data-separator="usage"\]::before/);
  assert.match(source, /\.summary-part\[data-separator="billing"\]::before/);
  assert.doesNotMatch(source, /\.summary-part:nth-child/);
  assert.match(source, /margin: 0 var\(--usage-summary-separator-space\);/);
  assert.match(source, /:host\(\[data-vertical-side="up"\]\) \.shell/);
});

test('calculates clamped usage percentages', () => {
  assert.equal(percentage(6, 100), 6);
  assert.equal(percentage(2, 0), 0);
  assert.equal(percentage(120, 100), 100);
  assert.equal(formatPercent(5.6), '6%');
});

test('normalizes the current within_limit response', () => {
  const snapshot = normalizeVerdict(
    {
      status: 'within_limit',
      window: {
        creditType: 'basic_ai_credits',
        scope: 'per_user',
        window: '6h',
        used: 60,
        limit: 1000,
      },
      resetsInSeconds: 3 * 60 * 60 + 48 * 60,
      billingPeriodWindow: {
        creditType: 'basic_ai_credits',
        scope: 'per_user',
        cadence: 'billing_period',
        used: 10,
        limit: 1000,
        periodEndMs: NOW + 18 * 86400000,
      },
      enforcement: 'preview',
    },
    NOW,
  );

  assert.equal(snapshot.status, 'within_limit');
  assert.equal(snapshot.rolling.percent, 6);
  assert.equal(snapshot.rolling.window, '6h');
  assert.equal(snapshot.rolling.resetAt, NOW + (3 * 60 * 60 + 48 * 60) * 1000);
  assert.equal(snapshot.monthly.percent, 1);
  assert.equal(snapshot.monthly.resetAt, NOW + 18 * 86400000);
  assert.equal(snapshot.enforcement, 'preview');
});

test('finds a verdict nested by a legacy or client wrapper', () => {
  const wrapped = {
    type: 'success',
    data: {
      creditRateLimitVerdict: {
        status: 'within_limit',
        window: { window: '24h', used: 1, limit: 10 },
        resetsInSeconds: 30,
      },
    },
  };

  assert.equal(findCreditVerdict(wrapped).window.window, '24h');
  assert.equal(normalizeVerdict(wrapped, NOW).rolling.percent, 10);
});

test('normalizes rolling and billing-period rate limits', () => {
  const rollingLimited = normalizeVerdict(
    {
      status: 'rate_limited',
      window: { window: '6h', used: 100, limit: 100 },
      retryAfterSeconds: 90,
      limitedBy: 'rolling',
    },
    NOW,
  );
  assert.equal(rollingLimited.rolling.resetAt, NOW + 90000);
  assert.equal(rollingLimited.limitedBy, 'rolling');

  const billingLimited = normalizeVerdict(
    {
      status: 'rate_limited',
      window: { window: '6h', used: 100, limit: 100 },
      retryAfterSeconds: 90,
      limitedBy: 'billing_period',
      resumesAtMs: NOW + 86400000,
    },
    NOW,
  );
  assert.equal(billingLimited.rolling.resetAt, NOW + 86400000);
  assert.equal(billingLimited.limitedBy, 'billing_period');
});

test('treats not_applicable as a distinct state instead of zero usage', () => {
  const snapshot = normalizeVerdict({ status: 'not_applicable' }, NOW);
  assert.equal(snapshot.status, 'not_applicable');
  assert.equal(snapshot.rolling, null);
  assert.equal(snapshot.monthly, null);
  assert.equal(pollingInterval(snapshot), 6 * 60 * 60 * 1000);
});

test('drops an expired monthly window', () => {
  const snapshot = normalizeVerdict(
    {
      status: 'within_limit',
      window: { window: '6h', used: 1, limit: 100 },
      billingPeriodWindow: { used: 2, limit: 100, periodEndMs: NOW - 1 },
    },
    NOW,
  );
  assert.equal(snapshot.monthly, null);
});

test('does not coerce null, blank, or boolean quota fields to zero', () => {
  assert.equal(
    normalizeVerdict(
      {
        status: 'within_limit',
        window: { window: '6h', used: '', limit: 100 },
      },
      NOW,
    ),
    null,
  );

  const snapshot = normalizeVerdict(
    {
      status: 'within_limit',
      window: { window: '6h', used: 1, limit: 100 },
      resetsInSeconds: null,
      billingPeriodWindow: { used: false, limit: 100, periodEndMs: NOW + 10000 },
    },
    NOW,
  );
  assert.equal(snapshot.rolling.resetAt, null);
  assert.equal(snapshot.monthly, null);
});

test('matches only exact same-origin Notion endpoints', () => {
  assert.equal(endpointKind(CURRENT_ENDPOINT), 'current');
  assert.equal(endpointKind(LEGACY_ENDPOINT), 'legacy');
  assert.equal(endpointKind(BILLING_ENDPOINT), 'billing');
  assert.equal(endpointKind(`${CURRENT_ENDPOINT}/extra`), null);
  assert.equal(endpointKind(`https://evil.example${CURRENT_ENDPOINT}`), null);
  assert.equal(endpointKind(`https://evil.example${BILLING_ENDPOINT}`), null);
});

test('normalizes an active Business subscription without retaining billing details', () => {
  const currentPeriodEndAt = NOW + 335 * 86400000;
  const billingStatus = normalizeBillingStatus(
    {
      billingData: {
        provider: 'stripe',
        address: { line1: 'must not be retained' },
        payment: { card: 'must not be retained' },
        paymentMethod: { last4: '0000' },
        subscription: {
          provider: 'stripe',
          status: 'active',
          startDate: new Date(NOW - 30 * 86400000).toISOString(),
          currentPeriodEnd: new Date(currentPeriodEndAt).toISOString(),
          items: [
            { price: { product: 'ai' } },
            {
              quantity: 1,
              price: { product: 'business', billingInterval: 'year' },
            },
          ],
        },
      },
      dependencies: [{ ignored: true }],
    },
    NOW,
  );

  assert.deepEqual(billingStatus, {
    kind: 'subscription',
    status: 'active',
    plan: 'business',
    currentPeriodEndAt,
    updatedAt: NOW,
  });
  for (const key of ['provider', 'address', 'payment', 'paymentMethod', 'dependencies']) {
    assert.equal(Object.hasOwn(billingStatus, key), false);
  }
});

test('maps an unknown subscription status to unknown', () => {
  const billingStatus = normalizeBillingStatus(
    {
      billingData: {
        subscription: {
          status: 'new_provider_state',
          items: [{ price: { product: 'business', billingInterval: 'month' } }],
        },
      },
    },
    NOW,
  );

  assert.equal(billingStatus.kind, 'subscription');
  assert.equal(billingStatus.status, 'unknown');
  assert.equal(billingStatus.plan, 'business');
});

test('keeps a subscription visible when its plan product is unknown', () => {
  const billingStatus = normalizeBillingStatus(
    {
      billingData: {
        subscription: {
          status: 'active',
          items: [{ price: { product: 'business_v2', billingInterval: 'month' } }],
        },
      },
    },
    NOW,
  );

  assert.equal(billingStatus.kind, 'subscription');
  assert.equal(billingStatus.status, 'active');
  assert.equal(billingStatus.plan, 'unknown');

  const mixedWithFree = normalizeBillingStatus(
    {
      billingData: {
        subscription: {
          status: 'active',
          items: [
            { price: { product: 'free' } },
            { price: { product: 'business_v2' } },
          ],
        },
      },
    },
    NOW,
  );
  assert.equal(mixedWithFree.kind, 'subscription');
  assert.equal(mixedWithFree.plan, 'unknown');
});

test('rejects an active trial whose plan product cannot be identified', () => {
  const trial = {
    startDate: new Date(NOW - 86400000).toISOString(),
    endDate: new Date(NOW + 86400000).toISOString(),
  };

  assert.equal(
    normalizeBillingStatus({ billingData: { trial: { ...trial, items: [] } } }, NOW),
    null,
  );
  assert.equal(
    normalizeBillingStatus(
      {
        billingData: {
          trial: { ...trial, items: [{ price: { product: 'business_v2' } }] },
        },
      },
      NOW,
    ),
    null,
  );
});

test('uses only separate trial items when an Enterprise subscription is present', () => {
  const trialEndAt = NOW + 10 * 86400000;
  const billingStatus = normalizeBillingStatus(
    {
      billingData: {
        trial: {
          startDate: new Date(NOW - 2 * 86400000).toISOString(),
          endDate: new Date(trialEndAt).toISOString(),
          items: [{ price: { product: 'business' } }],
        },
        subscription: {
          status: 'active',
          items: [{ price: { product: 'enterprise', billingInterval: 'year' } }],
        },
      },
    },
    NOW,
  );

  assert.equal(billingStatus.kind, 'trial');
  assert.equal(billingStatus.status, 'active');
  assert.equal(billingStatus.plan, 'business');
  assert.equal(billingStatus.endAt, trialEndAt);
  assert.equal(activeBillingStatus(billingStatus, NOW), billingStatus);
});

test('falls back from an expired subscription-backed trial to the subscription', () => {
  const currentPeriodEndAt = NOW + 20 * 86400000;
  const billingStatus = normalizeBillingStatus(
    {
      billingData: {
        subscription: {
          status: 'active',
          startDate: new Date(NOW - 30 * 86400000).toISOString(),
          trialEnd: new Date(NOW - 1).toISOString(),
          currentPeriodEnd: new Date(currentPeriodEndAt).toISOString(),
          items: [{ price: { product: 'business', billingInterval: 'month' } }],
        },
      },
    },
    NOW,
  );

  assert.equal(billingStatus.kind, 'subscription');
  assert.equal(billingStatus.status, 'active');
  assert.equal(billingStatus.plan, 'business');
  assert.equal(billingStatus.currentPeriodEndAt, currentPeriodEndAt);
  assert.equal(activeBillingStatus(billingStatus, NOW), billingStatus);
});

test('normalizes a missing subscription as the Free plan', () => {
  const billingStatus = normalizeBillingStatus({ billingData: {} }, NOW);

  assert.deepEqual(billingStatus, {
    kind: 'none',
    status: 'none',
    plan: 'free',
    updatedAt: NOW,
  });
  assert.equal(activeBillingStatus(billingStatus, NOW), billingStatus);
});

test('preserves enterprise_limited internally and keeps it active', () => {
  const billingStatus = normalizeBillingStatus(
    {
      billingData: {
        subscription: {
          status: 'active',
          items: [
            { price: { product: 'business', billingInterval: 'month' } },
            { price: { product: 'enterprise_limited', billingInterval: 'year' } },
          ],
        },
      },
    },
    NOW,
  );

  assert.equal(billingStatus.kind, 'subscription');
  assert.equal(billingStatus.plan, 'enterprise_limited');
  assert.equal(activeBillingStatus(billingStatus, NOW), billingStatus);
});

test('formats subscription status for the capsule and expanded plan row', () => {
  const billingStatus = {
    kind: 'subscription',
    status: 'active',
    plan: 'business',
    updatedAt: NOW,
  };

  assert.equal(billingSummaryPart(billingStatus, NOW), 'Business · Active');
  assert.equal(planDisplayName('enterprise_limited'), 'Enterprise');
  assert.equal(planDisplayName('unknown'), 'Unknown');
  assert.equal(subscriptionStatusText('unknown'), 'Status unavailable');
});

test('formats visible billing permission and timeout failures', () => {
  assert.equal(
    billingFailureMessage({ status: 403 }, 'en'),
    'Subscription status unavailable: this account cannot access billing data',
  );
  assert.equal(
    billingFailureMessage({ name: 'AbortError' }, 'zh'),
    '读取订阅状态超时',
  );
});

test('normalizes a separate Business Trial using Notion billing clock semantics', () => {
  const trial = normalizeBusinessTrial(
    {
      billingData: {
        type: 'admin',
        address: { line1: 'must not be retained' },
        paymentMethod: { last4: '0000' },
        clock: {
          externalId: 'test-clock',
          now: '2026-07-30T10:00:00+08:00',
        },
        trial: {
          startDate: '2026-07-15T00:00:00+08:00',
          endDate: '2026-08-12T00:00:00+08:00',
          autoConvert: false,
          items: [{ quantity: 1, price: { product: 'business' } }],
        },
        subscription: {
          items: [{ quantity: 1, price: { product: 'plus' } }],
        },
      },
      dependencies: [{ ignored: true }],
    },
    NOW,
  );

  assert.equal(trial.status, 'active');
  assert.equal(trial.plan, 'business');
  assert.equal(trial.autoConvert, false);
  assert.equal(trial.usesServerClock, true);
  assert.equal(businessTrialDaysRemaining(trial, NOW), 13);
  assert.equal(Object.hasOwn(trial, 'address'), false);
  assert.equal(Object.hasOwn(trial, 'paymentMethod'), false);
  assert.equal(Object.hasOwn(trial, 'dependencies'), false);
});

test('normalizes a subscription-backed Business Trial', () => {
  const endAt = NOW + 12 * 86400000;
  const trial = normalizeBusinessTrial(
    {
      billingData: {
        clock: { externalId: null, now: null },
        subscription: {
          startDate: new Date(NOW - 4 * 86400000).toISOString(),
          trialEnd: new Date(endAt).toISOString(),
          items: [
            { price: { product: 'ai' } },
            { price: { product: 'business' } },
          ],
        },
      },
    },
    NOW,
  );

  assert.equal(trial.status, 'active');
  assert.equal(trial.endAt, endAt);
  assert.equal(trial.usesServerClock, false);
  assert.equal(activeBusinessTrial(trial, NOW), trial);
  assert.equal(activeBusinessTrial(trial, endAt), null);
});

test('matches Notion by converting billing ISO timestamps to the browser timezone', () => {
  const businessItem = [{ price: { product: 'business' } }];
  const trial = normalizeBusinessTrial(
    {
      billingData: {
        clock: { externalId: 'test-clock', now: '2026-07-30T10:00:00Z' },
        trial: {
          startDate: '2026-07-01T00:00:00Z',
          endDate: '2026-07-31T00:00:00Z',
          items: businessItem,
        },
      },
    },
    NOW,
  );
  assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, 'Asia/Shanghai');
  assert.equal(businessTrialDaysRemaining(trial, NOW), 2);

  const endingToday = normalizeBusinessTrial(
    {
      billingData: {
        clock: { externalId: 'test-clock', now: '2026-07-30T10:00:00Z' },
        trial: {
          startDate: '2026-07-01T00:00:00Z',
          endDate: '2026-07-30T12:00:00Z',
          items: businessItem,
        },
      },
    },
    NOW,
  );
  assert.equal(businessTrialDaysRemaining(endingToday, NOW), 1);
  assert.equal(businessTrialEndsToday(endingToday, NOW), true);
});

test('advances a captured billing clock until the trial expires', () => {
  const serverNow = new Date(NOW).toISOString();
  const trial = normalizeBusinessTrial(
    {
      billingData: {
        clock: { externalId: 'test-clock', now: serverNow },
        trial: {
          startDate: new Date(NOW - 86400000).toISOString(),
          endDate: new Date(NOW + 60000).toISOString(),
          items: [{ price: { product: 'business' } }],
        },
      },
    },
    NOW,
  );

  assert.equal(activeBusinessTrial(trial, NOW + 59999), trial);
  assert.equal(activeBusinessTrial(trial, NOW + 60000), null);
});

test('hides expired, non-Business, and absent trials', () => {
  const expired = normalizeBusinessTrial(
    {
      billingData: {
        trial: {
          startDate: new Date(NOW - 10 * 86400000).toISOString(),
          endDate: new Date(NOW - 1).toISOString(),
          items: [{ price: { product: 'business' } }],
        },
      },
    },
    NOW,
  );
  const plusTrial = normalizeBusinessTrial(
    {
      billingData: {
        trial: {
          startDate: new Date(NOW - 86400000).toISOString(),
          endDate: new Date(NOW + 86400000).toISOString(),
          items: [{ price: { product: 'plus' } }],
        },
      },
    },
    NOW,
  );
  assert.equal(expired.status, 'none');
  assert.equal(plusTrial.status, 'none');
  assert.equal(normalizeBusinessTrial({ billingData: {} }, NOW).status, 'none');
});

test('rejects ambiguous or malformed trial dates', () => {
  const businessItem = [{ price: { product: 'business' } }];
  assert.equal(
    normalizeBusinessTrial(
      {
        billingData: {
          trial: {
            startDate: '2026-07-30',
            endDate: '2026-08-20',
            items: businessItem,
          },
        },
      },
      NOW,
    ),
    null,
  );
  assert.equal(
    normalizeBusinessTrial(
      {
        billingData: {
          trial: {
            startDate: new Date(NOW).toISOString(),
            endDate: new Date(NOW + 86400000).toISOString(),
            items: businessItem,
          },
          subscription: {
            startDate: new Date(NOW).toISOString(),
            trialEnd: new Date(NOW + 86400000).toISOString(),
            items: businessItem,
          },
        },
      },
      NOW,
    ),
    null,
  );
});

test('metadata inspection never clones or reads a non-usage Request body', () => {
  const request = new Request('https://app.notion.com/api/v3/runInference', {
    method: 'POST',
    body: 'private prompt text',
  });
  let cloneCalls = 0;
  Object.defineProperty(request, 'clone', {
    value() {
      cloneCalls += 1;
      throw new Error('body must not be cloned');
    },
  });

  const metadata = fetchMetadata(request);
  assert.equal(metadata.url, 'https://app.notion.com/api/v3/runInference');
  assert.equal(metadata.method, 'POST');
  assert.equal(cloneCalls, 0);
  assert.equal(Object.hasOwn(metadata, 'bodyTextPromise'), false);
});

test('uses a workspace header without cloning a cross-realm usage Request body', async () => {
  const request = new Request('https://app.notion.com/api/v3/getCreditRateLimitStatus', {
    method: 'POST',
    headers: { 'x-notion-space-id': SPACE_ID },
    body: JSON.stringify({ spaceId: SPACE_ID }),
  });
  let cloneCalls = 0;
  Object.defineProperty(request, 'clone', {
    value() {
      cloneCalls += 1;
      throw new Error('header context must not wait for clone().text()');
    },
  });

  assert.equal(await requestBodyText(request, undefined, request.headers), '');
  assert.equal(cloneCalls, 0);
});

test('extracts a workspace id from the body or a safe header', () => {
  assert.equal(extractSpaceId(JSON.stringify({ spaceId: SPACE_ID }), {}), SPACE_ID);
  assert.equal(
    extractSpaceId('', new Headers({ 'x-notion-space-id': SPACE_ID })),
    SPACE_ID,
  );
  assert.equal(extractSpaceId('{bad json', {}), null);
});

test('copies only allow-listed request headers', () => {
  const source = {
    'Content-Type': 'application/json',
    'X-Notion-Space-Id': SPACE_ID,
    'X-Notion-Active-User-Header': 'user-id',
    Cookie: 'token_v2=do-not-copy',
  };
  Object.defineProperty(source, 'Authorization', {
    enumerable: true,
    get() {
      throw new Error('authorization must never be read');
    },
  });
  const copied = safeHeaders(source);

  assert.deepEqual(copied, {
    'content-type': 'application/json',
    'x-notion-active-user-header': 'user-id',
    'x-notion-space-id': SPACE_ID,
  });
});

test('keeps a complete same-account recipe across sparse requests', () => {
  const complete = mergeRecipeHeaders(
    {},
    {
      'Notion-Client-Version': '23.13.0',
      'X-Notion-Active-User-Header': 'user-a',
      'X-Notion-Cell': 'cell-a',
      'X-Notion-Space-Id': SPACE_ID,
    },
    SPACE_ID,
    true,
  );
  const sparse = mergeRecipeHeaders(
    complete,
    { 'X-Notion-Space-Id': SPACE_ID },
    SPACE_ID,
    false,
  );

  assert.deepEqual(sparse, {
    'content-type': 'application/json',
    'notion-client-version': '23.13.0',
    'x-notion-active-user-header': 'user-a',
    'x-notion-cell': 'cell-a',
    'x-notion-space-id': SPACE_ID,
  });

  const otherSpace = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const reset = mergeRecipeHeaders(
    sparse,
    { 'X-Notion-Space-Id': otherSpace },
    otherSpace,
    true,
  );
  assert.equal(reset['x-notion-active-user-header'], undefined);
  assert.equal(reset['notion-client-version'], undefined);
  assert.equal(reset['x-notion-space-id'], otherSpace);
});

test('actively falls back when the first native current response is slow', () => {
  assert.deepEqual(usageRefreshPlan('current', false, 0), {
    reason: 'current-response-grace',
    delay: 1000,
  });
  assert.deepEqual(usageRefreshPlan('billing', false, 0), {
    reason: 'billing-space-id',
    delay: 400,
  });
  assert.deepEqual(usageRefreshPlan('legacy', true, 2000), {
    reason: 'legacy-space-id',
    delay: 400,
  });
  assert.equal(usageRefreshPlan('current', true, 0), null);
  assert.equal(usageRefreshPlan('legacy', false, 1000), null);
});

test('rejects a late passive response after a same-workspace user switch', () => {
  const token = Object.freeze({
    sequence: 1,
    contextVersion: 1,
    spaceId: SPACE_ID,
    activeUserId: 'user-a',
  });

  assert.equal(
    contextTokenMatches(token, {
      requestSequence: 1,
      acceptedContextSequence: 1,
      contextVersion: 1,
      spaceId: SPACE_ID,
      activeUserId: 'user-a',
    }),
    true,
  );
  assert.equal(
    contextTokenMatches(token, {
      requestSequence: 2,
      acceptedContextSequence: 2,
      contextVersion: 2,
      spaceId: SPACE_ID,
      activeUserId: 'user-b',
    }),
    false,
  );
  assert.equal(
    contextTokenMatches(token, {
      requestSequence: 2,
      acceptedContextSequence: 2,
      contextVersion: 1,
      spaceId: SPACE_ID,
      activeUserId: 'user-a',
    }),
    true,
  );
  assert.equal(
    contextTokenMatches(token, {
      requestSequence: 1,
      acceptedContextSequence: 1,
      contextVersion: 1,
      spaceId: SPACE_ID,
      activeUserId: 'user-b',
    }),
    false,
  );
});

test('orders only successfully accepted responses within the current endpoint', () => {
  assert.equal(responseSequenceIsFresh({ sequence: 1 }, 0), true);
  assert.equal(responseSequenceIsFresh({ sequence: 1 }, 2), false);
  assert.equal(responseSequenceIsFresh(null, 0), false);
});

test('ignores an active failure after a newer passive success or context switch', () => {
  const requestContext = {
    spaceId: SPACE_ID,
    contextVersion: 3,
    acceptedCurrentResponseSequence: 4,
  };
  assert.equal(
    activeFailureCanCommit(requestContext, {
      spaceId: SPACE_ID,
      contextVersion: 3,
      acceptedCurrentResponseSequence: 4,
    }),
    true,
  );
  assert.equal(
    activeFailureCanCommit(requestContext, {
      spaceId: SPACE_ID,
      contextVersion: 3,
      acceptedCurrentResponseSequence: 5,
    }),
    false,
  );
  assert.equal(
    activeFailureCanCommit(requestContext, {
      spaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      contextVersion: 4,
      acceptedCurrentResponseSequence: 0,
    }),
    false,
  );
});

test('ignores an active billing failure after a newer passive billing success', () => {
  const requestContext = {
    spaceId: SPACE_ID,
    activeUserId: 'user-a',
    contextVersion: 3,
    acceptedBillingResponseSequence: 4,
  };
  assert.equal(
    billingFailureCanCommit(requestContext, {
      ...requestContext,
      acceptedBillingResponseSequence: 4,
    }),
    true,
  );
  assert.equal(
    billingFailureCanCommit(requestContext, {
      ...requestContext,
      acceptedBillingResponseSequence: 5,
    }),
    false,
  );
  assert.equal(
    billingFailureCanCommit(requestContext, {
      ...requestContext,
      activeUserId: 'user-b',
    }),
    false,
  );
});

test('formats short reset countdowns', () => {
  assert.equal(
    formatReset(NOW + (3 * 60 + 48) * 60000, NOW, 'zh'),
    '3 小时 48 分钟后重置',
  );
  assert.equal(
    formatReset(NOW + (3 * 60 + 48) * 60000, NOW, 'en'),
    'Resets in 3h 48m',
  );
  assert.equal(currentUiLanguage(), 'en');
  assert.equal(currentUiTheme(), 'light');
  assert.equal(uiText('中文', 'English', 'zh'), '中文');
  assert.equal(uiText('中文', 'English', 'en'), 'English');
  assert.equal(cssColorTheme('rgb(25, 25, 25)'), 'dark');
  assert.equal(cssColorTheme('rgb(255 255 255)'), 'light');
  assert.equal(cssColorTheme('rgba(0, 0, 0, 0)'), null);
});
