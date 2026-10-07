/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

export const USAGE_CSS = `
:host {
  all: initial;
  --text: #f7f7f5; --muted: #a8a8a8; --faint: #929292; --border: rgba(255,255,255,.14);
  --divider: rgba(255,255,255,.24); --pill: rgba(30,30,30,.94); --pill-hover: rgba(42,42,42,.97);
  --card: rgba(28,28,28,.97); --btn: rgba(255,255,255,.08); --btn-hover: rgba(255,255,255,.14);
  --row: rgba(255,255,255,.08); --bar: rgba(255,255,255,.10); --value: #c7c7c7; --billing: #d9c4ff;
  --info: #c6dfff; --info-bg: rgba(58,132,217,.14); --error: #ffc5c5; --error-bg: rgba(221,70,70,.14);
  --tip: #f7f7f5; --tip-bg: #2f2f2f; --tip-border: rgba(255,255,255,.12); --track: rgba(255,255,255,.18);
  --core: #202124; --shadow: 0 14px 42px rgba(0,0,0,.36);
  position: fixed; top: 16px; left: auto; right: 16px; z-index: 2147483646;
  display: block; width: max-content; max-width: calc(100vw - 16px);
  color: var(--text); font: 13px/1.4 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  pointer-events: none;
}
:host([data-theme="light"]) {
  --text: #252525; --muted: #686868; --faint: #787774; --border: rgba(15,15,15,.13); --divider: rgba(15,15,15,.2);
  --pill: rgba(255,255,255,.96); --pill-hover: rgba(247,247,245,.98); --card: rgba(255,255,255,.98);
  --btn: rgba(15,15,15,.06); --btn-hover: rgba(15,15,15,.11); --row: rgba(15,15,15,.09); --bar: rgba(15,15,15,.1);
  --value: #555; --billing: #6940a5; --info: #24588f; --info-bg: rgba(46,119,190,.11); --error: #a62d2f;
  --error-bg: rgba(190,46,48,.1); --tip: #252525; --tip-bg: #fff; --tip-border: rgba(15,15,15,.12);
  --track: rgba(15,15,15,.16); --shadow: 0 14px 38px rgba(15,15,15,.18);
}
:host([hidden]) { display: none; }
* { box-sizing: border-box; }
button { font: inherit; }
[hidden] { display: none !important; }
.shell { position: relative; display: flex; flex-direction: column; align-items: flex-end; gap: 7px; }
:host([data-side="left"]) .shell { align-items: flex-start; }
:host([data-up]) .shell { flex-direction: column-reverse; }
:host([data-docked]) .shell { align-items: center; }
.summary {
  pointer-events: auto; display: inline-flex; align-items: center; min-height: 36px; padding-right: 5px;
  border: 1px solid var(--border); border-radius: 999px; background: var(--pill);
  box-shadow: 0 7px 24px rgba(0,0,0,.2); backdrop-filter: blur(14px); cursor: grab; touch-action: none; user-select: none;
}
.summary:hover { background: var(--pill-hover); }
.toggle {
  display: inline-flex; align-items: center; gap: 10px; min-height: 34px; padding: 7px 4px 7px 12px;
  border: 0; color: inherit; background: transparent; cursor: inherit;
}
.dot { width: 8px; height: 8px; border-radius: 50%; background: #808080; box-shadow: 0 0 0 3px rgba(128,128,128,.13); }
.dot[data-status="ok"] { background: #35b46f; box-shadow: 0 0 0 3px rgba(53,180,111,.15); }
.dot[data-status="error"] { background: #f05d5e; box-shadow: 0 0 0 3px rgba(240,93,94,.16); }
.dot[data-status="waiting"] { background: #d3a832; box-shadow: 0 0 0 3px rgba(211,168,50,.16); }
.text { display: inline-flex; align-items: center; white-space: nowrap; font-weight: 650; letter-spacing: .01em; }
.part[data-sep="usage"]::before { content: "·"; margin: 0 10px; color: var(--muted); }
.part[data-sep="billing"]::before {
  content: ""; display: inline-block; width: 1px; height: 14px; margin: 0 10px; vertical-align: -2px; background: var(--divider);
}
.chevron { color: var(--muted); font-size: 11px; }
.icon-btn {
  display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; padding: 0;
  border: 0; border-radius: 7px; color: var(--muted); background: transparent; cursor: pointer;
}
.icon-btn:hover:not(:disabled) { color: var(--text); background: var(--btn-hover); }
.icon-btn:disabled { opacity: .45; cursor: default; }
.icon-btn.round { border-radius: 50%; width: 24px; height: 24px; }
svg.i { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }
.spin svg.i { animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
:focus-visible { outline: 2px solid #4e9cff; outline-offset: 2px; }
.card {
  pointer-events: auto; width: min(336px, calc(100vw - 24px)); max-height: calc(100vh - 70px); overflow: auto;
  border: 1px solid var(--border); border-radius: 14px; background: var(--card); box-shadow: var(--shadow); backdrop-filter: blur(18px);
}
.header { display: flex; align-items: center; justify-content: space-between; padding: 11px 10px 9px 14px; cursor: grab; touch-action: none; user-select: none; }
.title { display: flex; align-items: center; gap: 6px; font-size: 14px; font-weight: 700; }
.badge { padding: 1px 6px; border-radius: 6px; color: var(--muted); background: var(--btn); font-size: 10px; font-weight: 600; }
.actions { display: flex; gap: 4px; }
.notice { margin: 0 14px 10px; padding: 8px 9px; border-radius: 8px; color: var(--info); background: var(--info-bg); font-size: 11px; }
.notice[data-kind="error"] { color: var(--error); background: var(--error-bg); }
.metrics { padding: 0 14px 3px; }
.metric { padding: 8px 0 11px; }
.metric + .metric { border-top: 1px solid var(--row); }
.head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.label { font-weight: 620; }
.value { color: var(--value); font-variant-numeric: tabular-nums; }
.billing .value { color: var(--billing); font-weight: 650; }
.bar { height: 5px; margin: 7px 0 5px; overflow: hidden; border-radius: 99px; background: var(--bar); }
.fill { display: block; height: 100%; width: 0; border-radius: inherit; background: #3d9bff; transition: width .25s ease; }
.fill[data-tone="warning"] { background: #dfa83a; }
.fill[data-tone="danger"] { background: #ed6566; }
.sub { color: var(--faint); font-size: 11px; }
.footer {
  display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 10px 7px 14px;
  border-top: 1px solid var(--row); color: var(--faint); font-size: 10px;
}
.orb {
  pointer-events: auto; display: inline-flex; gap: 4px; padding: 2px; border: 0; border-radius: 999px;
  background: transparent; cursor: pointer; user-select: none;
}
.ring {
  --p: 0; --c: #35b46f; position: relative; width: 20px; height: 20px; border-radius: 50%;
  background: conic-gradient(from -90deg, var(--c) calc(var(--p) * 1%), var(--track) 0); box-shadow: 0 2px 7px rgba(0,0,0,.22);
}
.ring::after { content: ""; position: absolute; inset: 2.5px; border-radius: inherit; background: var(--core); }
.ring[data-tone="warning"] { --c: #dfa83a; }
.ring[data-tone="danger"] { --c: #ed6566; }
.ring[data-tone="waiting"], .ring[data-tone="neutral"] { --c: #8c8c8c; }
.tip {
  position: absolute; left: 50%; top: calc(100% + 8px); z-index: 3; min-width: 160px; padding: 7px 9px 8px;
  border: 1px solid var(--tip-border); border-radius: 8px; color: var(--tip); background: var(--tip-bg);
  box-shadow: 0 5px 18px rgba(0,0,0,.3); white-space: nowrap; pointer-events: none;
  opacity: 0; visibility: hidden; transform: translate(-50%, -2px); transition: opacity .12s, transform .12s, visibility .12s;
}
:host([data-tip-up]) .tip { top: auto; bottom: calc(100% + 8px); transform: translate(-50%, 2px); }
.tip b { display: block; font-size: 13px; font-weight: 600; }
.tip span { display: block; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.orb:hover + .tip, .orb:focus-visible + .tip { opacity: 1; visibility: visible; transform: translate(-50%, 0); }
.dragging, .dragging * { cursor: grabbing !important; }
@media (prefers-reduced-motion: reduce) { .fill, .tip { transition: none; } .spin svg.i { animation: none; opacity: .55; } }
`;

const icon = (paths: string) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;

export const ICONS = {
    refresh: icon('<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>'),
    minimize: icon('<path d="M6 12h12"/>'),
    external: icon('<path d="M14 4h6v6"/><path d="m20 4-9 9"/><path d="M20 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4"/>'),
    settings: icon('<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>'),
};

export const USAGE_HTML = `
<div class="shell">
  <button class="orb" type="button" hidden><span class="ring r-rolling"></span><span class="ring r-monthly"></span></button>
  <span class="tip" role="tooltip" hidden><b class="tip-title"></b><span class="tip-detail"></span></span>
  <div class="summary">
    <button class="toggle" type="button" aria-expanded="false"><span class="dot" data-status="waiting"></span><span class="text"></span><span class="chevron">▾</span></button>
    <button class="icon-btn round minimize" type="button">${ICONS.minimize}</button>
  </div>
  <section class="card" hidden>
    <div class="header">
      <div class="title"><span class="title-text"></span><span class="badge" hidden>preview</span></div>
      <div class="actions">
        <button class="icon-btn settings" type="button">${ICONS.settings}</button>
        <button class="icon-btn refresh" type="button">${ICONS.refresh}</button>
      </div>
    </div>
    <div class="notice" hidden></div>
    <div class="metrics">
      <div class="metric m-rolling"><div class="head"><span class="label"></span><span class="value"></span></div><div class="bar"><span class="fill"></span></div><div class="sub"></div></div>
      <div class="metric m-monthly"><div class="head"><span class="label"></span><span class="value"></span></div><div class="bar"><span class="fill"></span></div><div class="sub"></div></div>
      <div class="metric billing"><div class="head"><span class="label"></span><span class="value"></span></div><div class="sub"></div></div>
    </div>
    <div class="footer"><span class="updated"></span><button class="icon-btn native" type="button">${ICONS.external}</button></div>
  </section>
</div>`;
