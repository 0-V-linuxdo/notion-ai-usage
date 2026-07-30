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
  LEGACY_POSITION_KEY,
  LEGACY_POSITION_KEY_PREFIX,
  POSITION_KEY,
  activeFailureCanCommit,
  activeBillingStatus,
  activeBusinessTrial,
  billingFailureMessage,
  billingSummaryPart,
  billingFailureCanCommit,
  businessTrialDaysRemaining,
  businessTrialEndsToday,
  clampOverlayPosition,
  compactUsagePercent,
  compactUsagePresentation,
  composerCandidateEligible,
  composerSemanticText,
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
  normalizeOverlayAnchor,
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
} = require('../notion-ai-usage.user.js');

const NOW = 1785360000000;
const SPACE_ID = '12345678-1234-4abc-8def-1234567890ab';
const SCRIPT_PATH = path.resolve(__dirname, '../notion-ai-usage.user.js');
const PACKAGE_PATH = path.resolve(__dirname, '../package.json');

function makeFakeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  const writes = [];
  return {
    writes,
    get length() {
      return values.size;
    },
    key(index) {
      return Array.from(values.keys())[index] || null;
    },
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      const serialized = String(value);
      writes.push({ key, value: serialized });
      values.set(key, serialized);
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

function makeEventTarget(rectangle) {
  const listeners = new Map();
  const capturedPointers = new Set();
  return {
    hidden: false,
    listeners,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    dispatch(type, event) {
      for (const listener of Array.from(listeners.get(type) || [])) listener(event);
    },
    getBoundingClientRect() {
      return rectangle();
    },
    setPointerCapture(pointerId) {
      capturedPointers.add(pointerId);
    },
    hasPointerCapture(pointerId) {
      return capturedPointers.has(pointerId);
    },
    releasePointerCapture(pointerId) {
      capturedPointers.delete(pointerId);
    },
  };
}

function loadPositionBrowserHarness(storage, viewport = { width: 1440, height: 900 }) {
  const source = fs.readFileSync(SCRIPT_PATH, 'utf8');
  const marker = '  function mountUi() {';
  assert.equal(source.includes(marker), true);
  const instrumented = source.replace(
    marker,
    `  root.__notionAiUsagePositionTestHooks = {
    runtime,
    installOverlayDragging,
    handleOverlayPositionStorage,
    restoreOverlayPosition,
    setMinimized,
  };
  return;

${marker}`,
  );
  const rootListeners = new Map();
  const sandbox = {
    URL,
    console: { warn() {} },
    document: {
      referrer: '',
      documentElement: {
        clientWidth: viewport.width,
        clientHeight: viewport.height,
      },
    },
    innerWidth: viewport.width,
    innerHeight: viewport.height,
    location: { href: 'https://app.notion.com/ai', ancestorOrigins: [] },
    localStorage: storage,
    addEventListener(type, listener) {
      if (!rootListeners.has(type)) rootListeners.set(type, new Set());
      rootListeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      if (rootListeners.has(type)) rootListeners.get(type).delete(listener);
    },
    setTimeout() {
      return 1;
    },
    clearTimeout() {},
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(instrumented, context, { filename: SCRIPT_PATH });
  return {
    hooks: context.__notionAiUsagePositionTestHooks,
    dispatchRoot(type, event) {
      for (const listener of Array.from(rootListeners.get(type) || [])) listener(event);
    },
  };
}

function installFakePositionUi(harness, initial = { left: 1100, top: 16 }) {
  let ui;
  const host = {
    dataset: { side: 'right' },
    style: {},
    getBoundingClientRect() {
      const width = ui && ui.minimized ? 48 : 300;
      const height = ui && ui.minimized ? 24 : 38;
      const styledLeft = Number.parseFloat(host.style.left);
      const styledTop = Number.parseFloat(host.style.top);
      const left = Number.isFinite(styledLeft) ? styledLeft : initial.left;
      const top = Number.isFinite(styledTop) ? styledTop : initial.top;
      return { left, right: left + width, top, bottom: top + height, width, height };
    },
  };
  const handleRect = (width, height = width) => () => {
    const rect = host.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.left + width,
      top: rect.top,
      bottom: rect.top + height,
      width,
      height,
    };
  };
  const summary = makeEventTarget(() => {
    const rect = host.getBoundingClientRect();
    return { ...rect, width: 300, height: 38, right: rect.left + 300, bottom: rect.top + 38 };
  });
  const orb = makeEventTarget(handleRect(48, 24));
  const header = makeEventTarget(() => host.getBoundingClientRect());
  ui = {
    host,
    shell: {
      dataset: {},
      removeAttribute(name) {
        delete this.dataset[name.replace(/^data-/, '')];
      },
    },
    orb,
    summary,
    header,
    card: {
      hidden: true,
      getBoundingClientRect() {
        return { width: 300, height: 300 };
      },
    },
    expanded: false,
    minimized: false,
    position: null,
    positionAnchor: null,
    dragActive: false,
    suppressSummaryClick: false,
  };
  harness.hooks.runtime.ui = ui;
  return ui;
}

function pointerEvent(overrides = {}) {
  return {
    pointerId: 1,
    clientX: 100,
    clientY: 100,
    button: 0,
    isPrimary: true,
    cancelable: true,
    target: null,
    preventDefault() {},
    ...overrides,
  };
}

test('uses AdGuard-compatible metadata and unsafeWindow realm constructors', () => {
  const source = fs.readFileSync(SCRIPT_PATH, 'utf8');
  assert.match(source, /^\/\/ @name\s+\[Notion AI\] Usage \[20260731\] v1\.1\.3$/m);
  assert.match(source, /^\/\/ @namespace\s+https:\/\/github\.com\/0-V-linuxdo\/notion-ai-usage$/m);
  assert.match(source, /^\/\/ @version\s+20260731\.1\.1\.3$/m);
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
  assert.equal(packageJson.version, '1.1.3');
  assert.equal(packageJson.releaseLabel, '[20260731] v1.1.3');
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

test('uses one stable page-local position key across top pages and rebuilt iframes', () => {
  assert.equal(POSITION_KEY, 'notion-ai-usage:position:v2');
  assert.equal(LEGACY_POSITION_KEY, 'notion-ai-usage:position:v1');
  assert.equal(LEGACY_POSITION_KEY_PREFIX, 'notion-ai-usage:position:v2:');

  const source = fs.readFileSync(SCRIPT_PATH, 'utf8');
  assert.doesNotMatch(source, /chatclub_frame_binding/);
  assert.doesNotMatch(source, /positionScope|positionStorageScope|overlayPositionScope/);
  assert.match(source, /root\.localStorage\.setItem\(POSITION_KEY, serialized\)/);
});

test('writes the canonical position exactly once only after a completed real drag', () => {
  const storage = makeFakeStorage();
  const harness = loadPositionBrowserHarness(storage);
  const ui = installFakePositionUi(harness);
  harness.hooks.installOverlayDragging(ui);
  const positionWrites = () => storage.writes.filter((write) => write.key === POSITION_KEY);

  ui.summary.dispatch('pointerdown', pointerEvent({ target: ui.summary }));
  harness.dispatchRoot('pointermove', pointerEvent({ clientX: 102, clientY: 103 }));
  harness.dispatchRoot('pointerup', pointerEvent());
  assert.equal(positionWrites().length, 0);

  ui.summary.dispatch(
    'pointerdown',
    pointerEvent({ pointerId: 2, target: ui.summary }),
  );
  harness.dispatchRoot(
    'pointermove',
    pointerEvent({ pointerId: 2, clientX: 104, clientY: 100 }),
  );
  harness.dispatchRoot('pointerup', pointerEvent({ pointerId: 2 }));
  harness.dispatchRoot('pointerup', pointerEvent({ pointerId: 2 }));
  assert.equal(positionWrites().length, 1);
  assert.ok(parseOverlayPosition(storage.getItem(POSITION_KEY)));

  ui.summary.dispatch(
    'pointerdown',
    pointerEvent({ pointerId: 3, target: ui.summary }),
  );
  harness.dispatchRoot(
    'pointermove',
    pointerEvent({ pointerId: 3, clientX: 120, clientY: 120 }),
  );
  harness.dispatchRoot('pointercancel', pointerEvent({ pointerId: 3 }));
  assert.equal(positionWrites().length, 1);
});

test('a stale drag session cannot move or persist a remounted UI', () => {
  const storage = makeFakeStorage();
  const harness = loadPositionBrowserHarness(storage);
  const staleUi = installFakePositionUi(harness);
  harness.hooks.installOverlayDragging(staleUi);
  staleUi.summary.dispatch('pointerdown', pointerEvent({ target: staleUi.summary }));

  const currentUi = installFakePositionUi(harness, { left: 600, top: 40 });
  harness.hooks.installOverlayDragging(currentUi);
  harness.dispatchRoot('pointermove', pointerEvent({ clientX: 180, clientY: 180 }));
  harness.dispatchRoot('pointerup', pointerEvent());

  assert.equal(currentUi.host.style.left, undefined);
  assert.equal(currentUi.host.style.top, undefined);
  assert.equal(currentUi.dragActive, false);
  assert.equal(storage.writes.length, 0);
});

test('applies only the newest canonical storage event and queues it during a drag', () => {
  const first = {
    xEdge: 'right',
    xOffset: 16,
    yEdge: 'top',
    yOffset: 16,
    side: 'right',
    verticalSide: 'down',
  };
  const second = { ...first, xOffset: 80 };
  const third = { ...first, xOffset: 120 };
  const storage = makeFakeStorage({ [POSITION_KEY]: serializeOverlayPosition(first) });
  const harness = loadPositionBrowserHarness(storage, { width: 720, height: 500 });
  const ui = installFakePositionUi(harness, { left: 404, top: 16 });
  harness.hooks.restoreOverlayPosition();
  harness.hooks.installOverlayDragging(ui);

  ui.summary.dispatch('pointerdown', pointerEvent({ target: ui.summary }));
  storage.setItem(POSITION_KEY, serializeOverlayPosition(second));
  harness.hooks.handleOverlayPositionStorage({
    key: POSITION_KEY,
    newValue: serializeOverlayPosition(second),
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.hooks.runtime.pendingExternalAnchor.anchor)),
    second,
  );

  storage.setItem(POSITION_KEY, serializeOverlayPosition(third));
  harness.dispatchRoot('pointercancel', pointerEvent());
  assert.deepEqual(JSON.parse(JSON.stringify(harness.hooks.runtime.positionAnchor)), first);

  harness.hooks.handleOverlayPositionStorage({
    key: POSITION_KEY,
    newValue: serializeOverlayPosition(second),
  });
  assert.deepEqual(JSON.parse(JSON.stringify(harness.hooks.runtime.positionAnchor)), first);
  harness.hooks.handleOverlayPositionStorage({
    key: POSITION_KEY,
    newValue: serializeOverlayPosition(third),
  });
  assert.deepEqual(JSON.parse(JSON.stringify(harness.hooks.runtime.positionAnchor)), third);
});

test('restores canonical and legacy positions without migration writes', () => {
  const anchor = {
    xEdge: 'right',
    xOffset: 16,
    yEdge: 'top',
    yOffset: 16,
    side: 'right',
    verticalSide: 'down',
  };
  const binding = `embedded-${'c'.repeat(64)}`;
  const cases = [
    {
      initial: { [POSITION_KEY]: serializeOverlayPosition(anchor) },
      expectedSource: anchor,
    },
    {
      initial: {
        [`${LEGACY_POSITION_KEY_PREFIX}${binding}`]: JSON.stringify({
          v: 2,
          scope: binding,
          ...anchor,
        }),
      },
      expectedSource: anchor,
    },
    {
      initial: {
        [LEGACY_POSITION_KEY]: JSON.stringify({
          v: 1,
          left: 100,
          top: 80,
          side: 'left',
          verticalSide: 'up',
        }),
      },
      expectedSource: {
        xEdge: 'left',
        xOffset: 100,
        yEdge: 'bottom',
        yOffset: 382,
        side: 'left',
        verticalSide: 'up',
      },
    },
  ];

  for (const { initial, expectedSource } of cases) {
    const storage = makeFakeStorage(initial);
    const harness = loadPositionBrowserHarness(storage, { width: 720, height: 500 });
    installFakePositionUi(harness, { left: 404, top: 16 });
    harness.hooks.restoreOverlayPosition();

    assert.deepEqual(
      JSON.parse(JSON.stringify(harness.hooks.runtime.positionAnchor)),
      expectedSource,
    );
    assert.equal(storage.writes.length, 0);
  }
});

test('remounts a minimized orb without rewriting its position or preference', () => {
  const anchor = {
    xEdge: 'right',
    xOffset: 16,
    yEdge: 'top',
    yOffset: 16,
    side: 'right',
    verticalSide: 'down',
  };
  const minimizedKey = 'notion-ai-usage:minimized:v1';
  const storage = makeFakeStorage({
    [POSITION_KEY]: serializeOverlayPosition(anchor),
    [minimizedKey]: '1',
  });

  const first = loadPositionBrowserHarness(storage, { width: 720, height: 500 });
  const firstUi = installFakePositionUi(first, { left: 404, top: 16 });
  first.hooks.setMinimized(storage.getItem(minimizedKey) === '1', false);
  first.hooks.restoreOverlayPosition();
  assert.equal(firstUi.minimized, true);
  assert.equal(firstUi.host.style.left, '656px');
  assert.equal(storage.writes.length, 0);

  first.hooks.setMinimized(false);
  first.hooks.setMinimized(true);
  assert.deepEqual(
    storage.writes.map((write) => write.key),
    [minimizedKey, minimizedKey],
  );
  assert.equal(storage.getItem(POSITION_KEY), serializeOverlayPosition(anchor));

  storage.writes.length = 0;
  const remount = loadPositionBrowserHarness(storage, { width: 1000, height: 600 });
  const remountedUi = installFakePositionUi(remount, { left: 940, top: 16 });
  remount.hooks.setMinimized(storage.getItem(minimizedKey) === '1', false);
  remount.hooks.restoreOverlayPosition();
  assert.equal(remountedUi.minimized, true);
  assert.equal(remountedUi.host.style.left, '936px');
  assert.equal(storage.writes.length, 0);
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

test('centers the minimized circles inside the composer bottom without changing an anchor', () => {
  const composer = {
    left: 260,
    top: 580,
    right: 980,
    bottom: 720,
    width: 720,
    height: 140,
  };
  assert.deepEqual(
    minimizedDockPosition(
      composer,
      { width: 48, height: 24 },
      { width: 1200, height: 800 },
    ),
    { left: 596, top: 689 },
  );
  assert.deepEqual(
    minimizedDockPosition(
      { left: -30, top: 750, right: 270, bottom: 830, width: 300, height: 80 },
      { width: 48, height: 24 },
      { width: 320, height: 800 },
    ),
    { left: 96, top: 768 },
  );
  assert.equal(
    minimizedDockPosition(null, { width: 48, height: 24 }, { width: 1200, height: 800 }),
    null,
  );
});

test('rejects ordinary Notion editors unless they have an AI composer signal', () => {
  for (const ordinary of [
    'comment-composer',
    'prompt-editor',
    '发送消息',
    '输入消息',
    '提问',
  ]) {
    assert.equal(composerSemanticText(ordinary), false, ordinary);
  }
  for (const aiComposer of [
    'notion-ai-prompt',
    'Do anything with AI',
    'Ask AI',
    '向 AI 提问',
  ]) {
    assert.equal(composerSemanticText(aiComposer), true, aiComposer);
  }
  assert.equal(
    composerCandidateEligible(
      { semantic: false, textarea: true, textbox: true, lexical: true },
      { aiQualified: false },
    ),
    false,
  );
  assert.equal(
    composerCandidateEligible(
      { semantic: true, textarea: false, textbox: true, lexical: false },
      { aiQualified: false },
    ),
    true,
  );
  assert.equal(
    composerCandidateEligible(
      { semantic: false, textarea: false, textbox: true, lexical: true },
      { aiQualified: true },
    ),
    true,
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

test('round-trips one canonical anchor and reads scoped v2 or v1 only as fallbacks', () => {
  const stored = {
    v: 2,
    xEdge: 'right',
    xOffset: 0,
    yEdge: 'bottom',
    yOffset: 16,
    side: 'right',
    verticalSide: 'up',
  };
  const anchor = {
    xEdge: 'right',
    xOffset: 0,
    yEdge: 'bottom',
    yOffset: 16,
    side: 'right',
    verticalSide: 'up',
  };
  assert.deepEqual(overlayPositionRecord(anchor), stored);
  assert.equal(serializeOverlayPosition(anchor), JSON.stringify(stored));
  assert.deepEqual(parseOverlayPosition(serializeOverlayPosition(anchor)), anchor);
  assert.deepEqual(normalizeOverlayAnchor(anchor, true), anchor);

  const invalid = [
    { ...stored, v: 1 },
    { ...stored, scope: 'top' },
    { ...stored, xEdge: 'center' },
    { ...stored, yEdge: 'middle' },
    { ...stored, side: 'center' },
    { ...stored, verticalSide: 'left' },
    { ...stored, xOffset: -1 },
    { ...stored, yOffset: '16' },
    { ...stored, xOffset: null },
  ];
  for (const value of invalid) {
    assert.equal(parseOverlayPosition(JSON.stringify(value)), null);
  }
  assert.equal(parseOverlayPosition('{"v":2,"xOffset":1e999}'), null);
  assert.equal(parseOverlayPosition('[1,2]'), null);
  assert.equal(parseOverlayPosition('not json'), null);

  const bindingA = `embedded-${'a'.repeat(64)}`;
  const bindingB = `embedded-${'b'.repeat(64)}`;
  const scopedA = {
    key: `${LEGACY_POSITION_KEY_PREFIX}${bindingA}`,
    raw: JSON.stringify({ ...stored, scope: bindingA, xOffset: 31 }),
  };
  const scopedB = {
    key: `${LEGACY_POSITION_KEY_PREFIX}${bindingB}`,
    raw: JSON.stringify({ ...stored, scope: bindingB, xOffset: 47 }),
  };
  const generic = {
    key: `${LEGACY_POSITION_KEY_PREFIX}embedded`,
    raw: JSON.stringify({ ...stored, scope: 'embedded', xOffset: 13 }),
  };
  assert.equal(parseOverlayPosition(scopedA.raw), null);
  assert.deepEqual(parseLegacyV2OverlayPosition(scopedA.key, scopedA.raw), {
    ...anchor,
    xOffset: 31,
  });
  assert.equal(
    parseLegacyV2OverlayPosition(scopedA.key, JSON.stringify({ ...stored, scope: bindingB })),
    null,
  );
  assert.deepEqual(
    orderedLegacyPositionEntries([generic, scopedA, scopedB]).map((entry) => entry.key),
    [scopedB.key, scopedA.key, generic.key],
  );

  const legacyRaw =
    '{"v":1,"left":100,"top":80,"side":"left","verticalSide":"up"}';
  const legacy = { left: 100, top: 80, side: 'left', verticalSide: 'up' };
  assert.deepEqual(parseLegacyOverlayPosition(legacyRaw), legacy);
  assert.equal(parseLegacyOverlayPosition('{"v":1,"left":"100","top":80}'), null);
  assert.deepEqual(
    selectStoredOverlayPosition(JSON.stringify(stored), [scopedA], legacyRaw),
    { kind: 'anchor', source: 'canonical', anchor },
  );
  assert.deepEqual(
    selectStoredOverlayPosition('broken', [generic, scopedA, scopedB], legacyRaw),
    { kind: 'anchor', source: 'legacy-v2', anchor: { ...anchor, xOffset: 47 } },
  );
  assert.deepEqual(selectStoredOverlayPosition('broken', [], legacyRaw), {
    kind: 'legacy',
    source: 'legacy-v1',
    position: legacy,
  });
  assert.equal(selectStoredOverlayPosition('broken', [], 'broken'), null);
});

test('keeps summary edge offsets stable across Arc, Tabbit, expansion, and resize clamps', () => {
  const anchor = {
    xEdge: 'right',
    xOffset: 16,
    yEdge: 'top',
    yOffset: 16,
    side: 'right',
    verticalSide: 'down',
  };
  const collapsed = { width: 300, height: 38, offsetLeft: 0, offsetTop: 0 };
  assert.deepEqual(
    overlayPositionFromAnchor(
      anchor,
      { width: 1440, height: 900 },
      { width: 300, height: 38 },
      collapsed,
    ),
    { left: 1124, top: 16 },
  );
  assert.deepEqual(
    overlayPositionFromAnchor(
      anchor,
      { width: 720, height: 500 },
      { width: 300, height: 38 },
      collapsed,
    ),
    { left: 404, top: 16 },
  );

  assert.deepEqual(
    overlayPositionFromAnchor(
      anchor,
      { width: 720, height: 500 },
      { width: 336, height: 345 },
      { width: 300, height: 38, offsetLeft: 36, offsetTop: 0 },
    ),
    { left: 368, top: 16 },
  );
  assert.deepEqual(
    overlayPositionFromAnchor(
      { ...anchor, yEdge: 'bottom', yOffset: 16, verticalSide: 'up' },
      { width: 720, height: 500 },
      { width: 336, height: 345 },
      { width: 300, height: 38, offsetLeft: 36, offsetTop: 307 },
    ),
    { left: 368, top: 139 },
  );

  const preserved = { ...anchor };
  assert.deepEqual(
    overlayPositionFromAnchor(
      preserved,
      { width: 280, height: 180 },
      { width: 336, height: 100 },
      collapsed,
    ),
    { left: 8, top: 16 },
  );
  assert.deepEqual(preserved, anchor);
  assert.deepEqual(
    overlayPositionFromAnchor(
      preserved,
      { width: 1440, height: 900 },
      { width: 200, height: 38 },
      { ...collapsed, width: 200 },
    ),
    { left: 1224, top: 16 },
  );

  for (const width of [720, 1440, 720, 1440, 720]) {
    const position = overlayPositionFromAnchor(
      anchor,
      { width, height: 900 },
      { width: 300, height: 38 },
      collapsed,
    );
    assert.deepEqual(
      overlayAnchorFromRect(
        {
          left: position.left,
          right: position.left + 300,
          top: position.top,
          bottom: position.top + 38,
          width: 300,
          height: 38,
        },
        { width, height: 900 },
        'right',
        'top',
      ),
      { xEdge: 'right', xOffset: 16, yEdge: 'top', yOffset: 16 },
    );
  }
});

test('chooses deterministic nearest edges and consumes one drag click', () => {
  assert.deepEqual(
    overlayAnchorFromRect(
      { left: 350, right: 650, top: 431, bottom: 469, width: 300, height: 38 },
      { width: 1000, height: 900 },
    ),
    { xEdge: 'left', xOffset: 350, yEdge: 'top', yOffset: 431 },
  );

  assert.deepEqual(summaryClickTransition(false, false), {
    expanded: true,
    suppressNextClick: false,
  });
  assert.deepEqual(summaryClickTransition(true, false), {
    expanded: false,
    suppressNextClick: false,
  });
  assert.deepEqual(summaryClickTransition(true, true), {
    expanded: true,
    suppressNextClick: false,
  });
});

test('switches expanded direction responsively without changing the stored anchor', () => {
  const anchor = {
    xEdge: 'left',
    xOffset: 20,
    yEdge: 'top',
    yOffset: 350,
    side: 'left',
    verticalSide: 'down',
  };
  const summary = { width: 300, height: 38 };
  assert.equal(
    responsiveOverlayVerticalSide(anchor, summary, 307, { width: 1000, height: 900 }, true),
    'down',
  );
  assert.equal(
    responsiveOverlayVerticalSide(anchor, summary, 307, { width: 1000, height: 500 }, true),
    'up',
  );
  assert.equal(
    responsiveOverlayVerticalSide(
      { ...anchor, verticalSide: 'up' },
      summary,
      307,
      { width: 1000, height: 900 },
      true,
    ),
    'up',
  );
  assert.equal(
    responsiveOverlayVerticalSide(
      { ...anchor, yOffset: 100, verticalSide: 'up' },
      summary,
      307,
      { width: 1000, height: 900 },
      true,
    ),
    'down',
  );
  assert.equal(
    responsiveOverlayVerticalSide(anchor, summary, 307, { width: 1000, height: 500 }, false),
    'down',
  );
  assert.deepEqual(anchor, {
    xEdge: 'left',
    xOffset: 20,
    yEdge: 'top',
    yOffset: 350,
    side: 'left',
    verticalSide: 'down',
  });
});

test('shows 6h and active monthly allowances separately in the minimized orb', () => {
  const snapshot = {
    status: 'within_limit',
    rolling: { percent: 79 },
    monthly: { percent: 64, resetAt: NOW + 1000 },
  };
  assert.equal(compactUsagePercent(snapshot, NOW), 79);
  assert.equal(
    compactUsagePercent(
      { ...snapshot, rolling: { percent: 51 }, monthly: { percent: 84, resetAt: NOW + 1 } },
      NOW,
    ),
    84,
  );
  assert.equal(
    compactUsagePercent(
      { ...snapshot, rolling: { percent: 51 }, monthly: { percent: 99, resetAt: NOW } },
      NOW,
    ),
    51,
  );
  assert.equal(compactUsagePercent({ status: 'not_applicable' }, NOW), null);
  assert.equal(compactUsagePercent(null, NOW), null);
  assert.deepEqual(compactUsagePresentation(snapshot, NOW), {
    status: 'available',
    rolling: { percent: 79, text: '79%', tone: 'warning', status: 'available' },
    monthly: { percent: 64, text: '64%', tone: 'normal', status: 'available' },
  });
  assert.deepEqual(compactUsagePresentation({ status: 'not_applicable' }, NOW), {
    status: 'not_applicable',
    rolling: {
      percent: null,
      text: '—',
      tone: 'neutral',
      status: 'not_applicable',
    },
    monthly: {
      percent: null,
      text: '—',
      tone: 'neutral',
      status: 'not_applicable',
    },
  });
  assert.deepEqual(
    compactUsagePresentation(
      {
        status: 'rate_limited',
        limitedBy: 'rolling',
        rolling: { percent: 42 },
        monthly: { percent: 17, resetAt: NOW + 1 },
      },
      NOW,
    ),
    {
      status: 'rate_limited',
      rolling: { percent: 42, text: '42%', tone: 'danger', status: 'rate_limited' },
      monthly: { percent: 17, text: '17%', tone: 'normal', status: 'available' },
    },
  );
  assert.deepEqual(compactUsagePresentation(null, NOW), {
    status: 'waiting',
    rolling: { percent: null, text: '…', tone: 'waiting', status: 'waiting' },
    monthly: { percent: null, text: '…', tone: 'waiting', status: 'waiting' },
  });
});

test('wires canonical position persistence, composer docking, dual circles, and spacing', () => {
  const source = fs.readFileSync(SCRIPT_PATH, 'utf8');
  assert.match(source, /const LEGACY_POSITION_KEY = 'notion-ai-usage:position:v1';/);
  assert.match(source, /const POSITION_KEY = 'notion-ai-usage:position:v2';/);
  assert.match(source, /const MINIMIZED_KEY = 'notion-ai-usage:minimized:v1';/);
  assert.match(source, /root\.localStorage\.getItem\(LEGACY_POSITION_KEY\)/);
  assert.match(source, /root\.localStorage\.getItem\(POSITION_KEY\)/);
  assert.match(source, /root\.localStorage\.setItem\(POSITION_KEY, serialized\)/);
  assert.match(source, /root\.localStorage\.getItem\(POSITION_KEY\) !== serialized/);
  assert.doesNotMatch(source, /setItem\(\s*LEGACY_POSITION_KEY/);
  assert.doesNotMatch(source, /removeItem\(\s*LEGACY_POSITION_KEY/);
  assert.doesNotMatch(source, /chatclub_frame_binding|restoreLateBoundOverlayPosition/);
  assert.match(source, /function installOverlayDragging\(ui\)/);
  assert.match(source, /handle\.addEventListener\('pointerdown'/);
  assert.match(source, /root\.addEventListener\('pointermove'/);
  assert.match(source, /root\.addEventListener\('pointerup'/);
  assert.match(source, /root\.addEventListener\('pointercancel'/);
  assert.match(source, /root\.removeEventListener\('pointermove'/);
  assert.match(source, /root\.removeEventListener\('pointerup'/);
  assert.match(source, /root\.removeEventListener\('pointercancel'/);
  assert.doesNotMatch(source, /handle\.addEventListener\('pointerleave'/);
  assert.match(source, /handle\.setPointerCapture\(event\.pointerId\)/);
  assert.match(source, /installOverlayDragging\(runtime\.ui\)/);
  assert.match(source, /root\.addEventListener\('resize', keepOverlayInViewport/);
  assert.match(source, /root\.addEventListener\('storage', handleOverlayPositionStorage\)/);
  assert.doesNotMatch(source, /keepOverlayInViewport\(true\)/);
  assert.match(source, /positionAnchor: null/);
  assert.match(source, /positionLoadStatus: 'unloaded'/);
  assert.match(source, /pendingExternalAnchor: null/);
  assert.match(source, /dragActive: false/);
  assert.match(source, /function setMinimized\(minimized, persist = true\)/);
  assert.doesNotMatch(source, /handle: ui\.orb/);
  assert.match(source, /ui\.minimized \|\|\n\s*runtime\.ui !== ui/);
  assert.match(source, /function minimizedDockPosition\(/);
  assert.match(source, /function findNotionAiComposer\(/);
  assert.match(source, /if \(!composerCandidateEligible\(signals, container\)\)/);
  assert.match(source, /let sawAiSemantic = composerSemanticText\(composerAttributeText\(editor\)\)/);
  assert.match(source, /if \(semantic\) sawAiSemantic = true;/);
  assert.match(source, /if \(sawAiSemantic\) best\.aiQualified = true;/);
  assert.match(source, /activeElement !== ui\.host/);
  assert.match(source, /function dockMinimizedOverlay\(/);
  assert.match(source, /ui\.host\.dataset\.docked = 'composer'/);
  assert.match(source, /new root\.MutationObserver\(\(\) =>/);
  assert.match(source, /new root\.ResizeObserver\(\(\) =>/);
  assert.match(source, /\{ childList: true, subtree: true \}/);
  assert.match(source, /root\.addEventListener\('scroll', scheduleMinimizedDock/);
  assert.match(source, /root\.addEventListener\('focusin', scheduleMinimizedDock/);
  assert.match(source, /const COMPOSER_SCAN_COOLDOWN_MS = 600;/);
  assert.match(source, /COMPOSER_SCAN_COOLDOWN_MS - elapsedSinceScan/);
  assert.ok(source.indexOf('restoreOverlayPosition();') < source.indexOf('setMinimized(minimized, false);'));

  const summaryRule = source.match(/\.summary \{([\s\S]*?)\n        \}/)?.[1] || '';
  const summaryToggleRule =
    source.match(/\.summary-toggle \{([\s\S]*?)\n        \}/)?.[1] || '';
  const orbRule = source.match(/\.orb \{([\s\S]*?)\n        \}/)?.[1] || '';
  const orbMetricRule = source.match(/\.orb-metric \{([\s\S]*?)\n        \}/)?.[1] || '';
  const orbRingRule = source.match(/\.orb-ring \{([\s\S]*?)\n        \}/)?.[1] || '';
  const orbValueRule = source.match(/\.orb-value \{([\s\S]*?)\n        \}/)?.[1] || '';
  const orbTooltipRule = source.match(/\.orb-tooltip \{([\s\S]*?)\n        \}/)?.[1] || '';
  const headerRule = source.match(/\.header \{([\s\S]*?)\n        \}/)?.[1] || '';
  assert.match(orbRule, /touch-action:\s*manipulation;/);
  assert.match(orbRule, /cursor:\s*pointer;/);
  assert.match(source, /conic-gradient\(/);
  assert.equal((source.match(/class="orb-metric"/g) || []).length, 2);
  assert.match(source, /class="orb-ring orb-rolling-ring"/);
  assert.match(source, /class="orb-ring orb-monthly-ring"/);
  assert.doesNotMatch(source, /class="orb-label"|orbMonthlyLabel/);
  assert.match(source, /class="summary-minimize"/);
  assert.doesNotMatch(source, /class="action icon-action minimize"/);
  assert.match(source, /ignoreSelector: '\.summary-minimize'/);
  assert.match(source, /runtime\.ui\.summary\.addEventListener\('click'/);
  assert.match(orbRule, /gap:\s*4px;/);
  assert.match(orbRule, /min-height:\s*24px;/);
  assert.match(orbRule, /padding:\s*2px;/);
  assert.match(orbRule, /overflow:\s*visible;/);
  assert.doesNotMatch(source, /\.orb:hover \{ transform:/);
  assert.match(orbMetricRule, /width:\s*20px;/);
  assert.match(orbMetricRule, /height:\s*20px;/);
  assert.match(orbMetricRule, /flex:\s*0 0 20px;/);
  assert.match(orbRingRule, /display:\s*block;/);
  assert.match(orbRingRule, /width:\s*20px;/);
  assert.match(orbRingRule, /height:\s*20px;/);
  assert.match(orbValueRule, /display:\s*none;/);
  assert.match(orbTooltipRule, /position:\s*absolute;/);
  assert.match(orbTooltipRule, /min-width:\s*166px;/);
  assert.match(orbTooltipRule, /background:\s*#2f2f2f;/);
  assert.match(orbTooltipRule, /opacity:\s*0;/);
  assert.match(source, /class="orb-tooltip" id="notion-ai-usage-orb-tooltip" role="tooltip"/);
  assert.match(source, /class="orb-tooltip-title"/);
  assert.match(source, /class="orb-tooltip-detail"/);
  assert.match(source, /aria-describedby="notion-ai-usage-orb-tooltip"/);
  assert.match(source, /\.shell\[data-minimized="true"\]:hover \.orb-tooltip,/);
  assert.match(source, /\.orb:focus-visible \+ \.orb-tooltip/);
  assert.match(source, /:host\(\[data-tooltip-side="up"\]\) \.orb-tooltip/);
  assert.match(source, /ORB_TOOLTIP_REQUIRED_SPACE/);
  assert.match(source, /`6h \$\{rollingText\} · Monthly \$\{monthlyText\}`/);
  assert.doesNotMatch(source, /\.orb:hover \.orb-value/);
  assert.doesNotMatch(source, /ui\.orb\.title\s*=/);
  assert.match(summaryRule, /gap:\s*2px;/);
  assert.match(summaryRule, /min-height:\s*38px;/);
  assert.match(summaryRule, /padding:\s*0 6px 0 0;/);
  assert.match(summaryRule, /touch-action:\s*none;/);
  assert.match(summaryRule, /user-select:\s*none;/);
  assert.match(summaryToggleRule, /gap:\s*var\(--usage-summary-item-gap\);/);
  assert.match(summaryToggleRule, /padding:\s*8px 5px 8px 13px;/);
  assert.match(headerRule, /cursor:\s*grab;/);
  assert.match(headerRule, /touch-action:\s*none;/);
  assert.doesNotMatch(source, />AI Usage<|`AI \$\{formatPercent/);
  assert.match(source, /\{ text: formatPercent\(snapshot\.rolling\.percent\) \}/);
  assert.match(source, /\.summary-part\[data-separator="usage"\]::before/);
  assert.match(source, /\.summary-part\[data-separator="billing"\]::before/);
  assert.doesNotMatch(source, /\.summary-part:nth-child/);
  assert.match(source, /margin: 0 var\(--usage-summary-separator-space\);/);
  assert.match(source, /:host\(\[data-vertical-side="up"\]\) \.shell/);
  assert.match(source, /class="action icon-action native-page"/);
  assert.match(source, /ui\.nativePage\.setAttribute\('aria-label'/);
  assert.match(source, /ui\.nativePage\.title = uiText/);
  assert.match(source, /<path d="M14 4h6v6"><\/path>/);
  assert.match(source, /<svg viewBox="0 0 24 24" aria-hidden="true">/);
  assert.match(source, /\.footer-actions \{ display: flex; flex: 0 0 auto; gap: 5px; \}/);
  assert.doesNotMatch(source, /ui\.nativePage\.textContent/);
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
