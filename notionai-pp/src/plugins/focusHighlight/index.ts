/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { onDomChange } from "@api/DomWatch";
import { createOverlay, type Overlay } from "@api/Overlay";
import { definePlugin } from "@api/PluginManager";
import { onRouteChange } from "@api/Router";
import { definePluginSettings, getValue, isHexColor, setValue } from "@api/Settings";
import { currentTheme, onThemeChange, type Theme } from "@api/Theme";
import { CONTAINER_SELECTOR, surfaceFor } from "@plugins/usage/composer";
import { t } from "@utils/page";

/*
 * Paints the Notion AI prompt box (the rounded surface around the editor) with
 * a custom ring colour, one colour per light/dark theme. The box is found by
 * Notion's stable [data-notion-chat-input-container] anchor, falling back to
 * editors whose placeholder reads like an AI prompt ("Do anything with AI…").
 *
 * Double right-click just to the right of the box opens a small colour panel
 * for the current theme; the colours are also in the NotionAI++ settings.
 */

const PLUGIN = "FocusHighlight";
const STYLE_ID = "notionai-pp-focus-highlight";
const PANEL_ID = "notionai-pp-focus-panel";
export const BOX_ATTR = "data-notionai-pp-focus-box";
const COLOR_VAR = "--notionai-pp-focus-color";

const EDITOR = "[role='textbox'][contenteditable]:not([contenteditable='false']), textarea, [contenteditable]:not([contenteditable='false'])";
const PROMPT_HINT = /do anything with ai|ask\s+(?:notion\s+)?ai|notion\s*ai|(?:用|向|让|问)\s*(?:notion\s*)?ai/i;

export const RIGHT_HIT_PX = 72;
const RIGHT_HIT_Y_PAD_PX = 10;
const DOUBLE_CLICK_MS = 450;
const DOUBLE_CLICK_PX = 20;

const LEGACY_KEYS = { light: "notionAiFocusHighlightColorLight", dark: "notionAiFocusHighlightColorDark" } as const;
const LEGACY_SHARED_KEY = "notionAiFocusHighlightColor";

export const settings = definePluginSettings({
    lightColor: {
        type: "color",
        label: "普通模式高亮色 / Light mode color",
        default: "#37352f",
    },
    darkColor: {
        type: "color",
        label: "黑暗模式高亮色 / Dark mode color",
        default: "#ffffff",
    },
});

const colorKey = (theme: Theme) => (theme === "dark" ? "darkColor" : "lightColor");
export const colorFor = (theme: Theme) => settings.store[colorKey(theme)];

let boxes = new Set<Element>();
let lastEditor: HTMLElement | null = null;
let lastContextMenu: { box: Element; time: number; x: number; y: number } | null = null;
let panel: Overlay | null = null;
let cleanups: (() => void)[] = [];
let scheduled = false;

/* ---------- prompt box detection ---------- */

const hint = (editor: Element) =>
    ["placeholder", "aria-placeholder", "data-placeholder", "aria-label"].map(name => editor.getAttribute(name) ?? "").join(" ");

/** Every Notion AI prompt surface currently on the page. */
export function findPromptBoxes(root: ParentNode = document): Element[] {
    const found = new Set<Element>();
    for (const container of root.querySelectorAll(CONTAINER_SELECTOR)) {
        const editor = container.querySelector(EDITOR);
        if (editor) found.add(surfaceFor(editor, container));
    }
    for (const editor of root.querySelectorAll(EDITOR)) {
        if (editor.closest(CONTAINER_SELECTOR) || !PROMPT_HINT.test(hint(editor))) continue;
        found.add(surfaceFor(editor, null));
    }
    return [...found].filter(box => box !== document.body && box !== document.documentElement);
}

export function scan() {
    const next = new Set(findPromptBoxes());
    for (const box of boxes) if (!next.has(box)) box.removeAttribute(BOX_ATTR);
    for (const box of next) if (!box.hasAttribute(BOX_ATTR)) box.setAttribute(BOX_ATTR, "");
    boxes = next;
}

function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
        scheduled = false;
        scan();
    });
}

/* ---------- colour style ---------- */

function renderStyle() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
        style = document.createElement("style");
        style.id = STYLE_ID;
    }
    if (!style.isConnected) (document.head ?? document.documentElement).appendChild(style);
    const color = colorFor(currentTheme());
    style.textContent = `
:root { ${COLOR_VAR}: ${color}; }
[${BOX_ATTR}] {
  outline: 1px solid var(${COLOR_VAR}) !important;
  box-shadow: 0 0 0 1px var(${COLOR_VAR}), 0 0 0 4px color-mix(in srgb, var(${COLOR_VAR}) 20%, transparent) !important;
}`;
}

/* ---------- colour panel ---------- */

const PANEL_CSS = `
:host { all: initial; position: fixed; top: 72px; right: 24px; z-index: 2147483647; display: block;
  --bg: #fff; --text: #37352f; --muted: #787774; --border: rgba(15,15,15,.12); --row: rgba(55,53,47,.05); --hover: rgba(55,53,47,.09);
  font: 13px/1.4 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color-scheme: light; }
:host([data-theme="dark"]) { --bg: #202020; --text: #f5f5f5; --muted: rgba(255,255,255,.68); --border: rgba(255,255,255,.14);
  --row: rgba(255,255,255,.07); --hover: rgba(255,255,255,.11); color-scheme: dark; }
* { box-sizing: border-box; }
.panel { width: 300px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg); color: var(--text);
  box-shadow: 0 12px 34px rgba(15,15,15,.22); }
header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 14px 8px; }
h2 { margin: 0; font-size: 14px; font-weight: 650; }
.close { width: 26px; height: 26px; border: 0; border-radius: 6px; background: transparent; color: var(--muted); font-size: 17px; cursor: pointer; }
.close:hover { background: var(--hover); color: var(--text); }
.body { display: grid; gap: 8px; padding: 0 14px 14px; }
label, .row { display: grid; grid-template-columns: minmax(0,1fr) auto; align-items: center; gap: 12px; min-height: 46px;
  padding: 8px 10px; border-radius: 8px; background: var(--row); }
label { cursor: pointer; } label:hover { background: var(--hover); }
.muted { color: var(--muted); font-size: 12px; font-weight: 500; }
.chip { position: relative; width: 52px; height: 30px; border: 1px solid var(--border); border-radius: 7px; overflow: hidden; }
.chip input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; border: 0; padding: 0; cursor: pointer; }
.value { font: 600 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
:focus-visible { outline: 2px solid #4e9cff; outline-offset: 2px; }
`;

function syncPanel() {
    if (!panel) return;
    const theme = currentTheme();
    const color = colorFor(theme);
    const { root } = panel;
    root.querySelector("h2")!.textContent = theme === "dark" ? t("黑暗模式高亮色", "Dark Mode Highlight") : t("普通模式高亮色", "Light Mode Highlight");
    root.querySelector<HTMLInputElement>("input")!.value = color;
    root.querySelector<HTMLElement>(".chip")!.style.background = color;
    root.querySelector(".value")!.textContent = color.toUpperCase();
}

export const isPanelOpen = () => !!panel;

export function openPanel() {
    closePanel(false);
    panel = createOverlay(PANEL_ID, PANEL_CSS, `<div class="panel" role="dialog"><header><h2></h2><button class="close" type="button">×</button></header>
<div class="body"><label><span class="muted"></span><span class="chip"><input type="color"></span></label>
<div class="row"><span class="muted"></span><span class="value"></span></div></div></div>`);
    const { root } = panel;
    root.querySelector(".panel")!.setAttribute("aria-label", t("配置输入框高亮色", "Configure prompt highlight color"));
    const [chooseLabel, currentLabel] = root.querySelectorAll(".muted");
    chooseLabel.textContent = t("选择颜色", "Choose Color");
    currentLabel.textContent = t("当前颜色", "Current Color");
    const close = root.querySelector<HTMLButtonElement>(".close")!;
    close.setAttribute("aria-label", t("关闭", "Close"));
    close.addEventListener("click", () => closePanel());
    root.addEventListener("keydown", event => {
        if ((event as KeyboardEvent).key !== "Escape") return;
        event.stopPropagation();
        closePanel();
    });
    const input = root.querySelector<HTMLInputElement>("input")!;
    const apply = () => {
        if (isHexColor(input.value)) settings.store[colorKey(currentTheme())] = input.value.toLowerCase();
    };
    input.addEventListener("input", apply);
    input.addEventListener("change", apply);
    syncPanel();
}

export function closePanel(refocus = true) {
    if (!panel) return;
    panel.destroy();
    panel = null;
    if (refocus && lastEditor?.isConnected) {
        try {
            lastEditor.focus({ preventScroll: true });
        } catch {}
    }
}

/* ---------- double right-click gesture ---------- */

/** True when the point lies in the strip just right of the box (where Notion has no menu of its own). */
export function inRightStrip(x: number, y: number, box: Element) {
    const rect = box.getBoundingClientRect();
    const dx = x - rect.right;
    return dx > 0 && dx <= RIGHT_HIT_PX && y >= rect.top - RIGHT_HIT_Y_PAD_PX && y <= rect.bottom + RIGHT_HIT_Y_PAD_PX;
}

function onContextMenu(event: MouseEvent) {
    if (panel && event.composedPath().includes(panel.host)) return;
    const box = [...boxes].find(b => b.isConnected && inRightStrip(event.clientX, event.clientY, b));
    if (!box) {
        lastContextMenu = null;
        return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    const editor = box.querySelector(EDITOR);
    if (editor instanceof HTMLElement) lastEditor = editor;
    const now = Date.now();
    const prev = lastContextMenu;
    if (prev && prev.box === box && now - prev.time <= DOUBLE_CLICK_MS &&
        Math.hypot(event.clientX - prev.x, event.clientY - prev.y) <= DOUBLE_CLICK_PX) {
        lastContextMenu = null;
        if (panel) closePanel();
        else openPanel();
        return;
    }
    lastContextMenu = { box, time: now, x: event.clientX, y: event.clientY };
}

/* ---------- legacy migration ---------- */

/** Carries colours over from the standalone "Focus Highlight Color" script when it used localStorage. */
export function migrateLegacy() {
    for (const theme of ["light", "dark"] as const) {
        if (getValue(PLUGIN, colorKey(theme)) !== undefined) continue;
        let legacy: string | null = null;
        try {
            legacy = localStorage.getItem(LEGACY_KEYS[theme]) ?? (theme === "light" ? localStorage.getItem(LEGACY_SHARED_KEY) : null);
        } catch {}
        const color = legacy?.trim().replace(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i, "#$1$1$2$2$3$3");
        if (isHexColor(color)) setValue(PLUGIN, colorKey(theme), color.toLowerCase());
    }
}

export default definePlugin({
    name: PLUGIN,
    title: "输入框高亮色",
    description: "给 Notion AI 输入框描一圈自定义颜色（普通 / 黑暗模式各一种）。在输入框右侧空白处连按两次右键，可打开取色面板。",
    enabledByDefault: true,
    settings,

    start() {
        migrateLegacy();
        renderStyle();
        window.addEventListener("contextmenu", onContextMenu, true);
        cleanups = [
            () => window.removeEventListener("contextmenu", onContextMenu, true),
            onDomChange(schedule),
            onRouteChange(schedule),
            onThemeChange(() => {
                renderStyle();
                syncPanel();
            }),
        ];
        scan();
    },

    stop() {
        for (const cleanup of cleanups.splice(0)) cleanup();
        closePanel(false);
        for (const box of boxes) box.removeAttribute(BOX_ATTR);
        boxes = new Set();
        lastContextMenu = null;
        document.getElementById(STYLE_ID)?.remove();
    },

    onSettingsChange() {
        renderStyle();
        syncPanel();
    },
});
