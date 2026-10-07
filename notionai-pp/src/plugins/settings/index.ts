/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { on } from "@api/Events";
import { createOverlay, type Overlay } from "@api/Overlay";
import { allPlugins, definePlugin, isEnabled, setEnabled } from "@api/PluginManager";
import { setValue } from "@api/Settings";
import { t } from "@utils/page";

declare const GM_registerMenuCommand: ((name: string, fn: () => void) => unknown) | undefined;
declare const VERSION: string;

export const SETTINGS_HOST_ID = "notionai-pp-settings";

const CSS = `
:host { all: initial; position: fixed; inset: 0; z-index: 2147483647; display: block;
  --bg: #fff; --text: #37352f; --muted: #787774; --border: rgba(15,15,15,.1); --hover: rgba(15,15,15,.05); --accent: #2383e2;
  font: 14px/1.45 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
:host([data-theme="dark"]) { --bg: #252525; --text: #ebebea; --muted: #9b9b9b; --border: rgba(255,255,255,.1); --hover: rgba(255,255,255,.06); }
* { box-sizing: border-box; }
.backdrop { position: absolute; inset: 0; background: rgba(15,15,15,.45); display: grid; place-items: center; }
.dialog { width: min(520px, calc(100vw - 32px)); max-height: min(80vh, 680px); overflow: auto; border-radius: 12px;
  color: var(--text); background: var(--bg); box-shadow: 0 24px 60px rgba(0,0,0,.35); }
header { position: sticky; top: 0; display: flex; align-items: center; justify-content: space-between; padding: 16px 18px 12px;
  border-bottom: 1px solid var(--border); background: var(--bg); }
h2 { margin: 0; font-size: 16px; } small { color: var(--muted); font-weight: 400; margin-left: 6px; }
.close { width: 28px; height: 28px; border: 0; border-radius: 6px; color: var(--muted); background: transparent; font-size: 18px; cursor: pointer; }
.close:hover { background: var(--hover); color: var(--text); }
section { padding: 14px 18px; border-bottom: 1px solid var(--border); }
section:last-child { border-bottom: 0; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.name { font-weight: 600; } .desc { margin-top: 3px; color: var(--muted); font-size: 12.5px; }
.options { margin-top: 10px; display: grid; gap: 8px; padding-left: 2px; }
.options[data-off] { opacity: .45; pointer-events: none; }
label.opt { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 13px; }
select { font: inherit; font-size: 13px; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 3px 6px; }
.switch { position: relative; width: 32px; height: 18px; flex: 0 0 auto; appearance: none; margin: 0; border-radius: 99px;
  background: rgba(135,131,120,.3); cursor: pointer; transition: background .15s; }
.switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: transform .15s; }
.switch:checked { background: var(--accent); } .switch:checked::after { transform: translateX(14px); }
:focus-visible { outline: 2px solid #4e9cff; outline-offset: 2px; }
`;

let overlay: Overlay | null = null;
const cleanups: (() => void)[] = [];

function switchInput(checked: boolean, label: string, onChange: (value: boolean) => void) {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "switch";
    input.checked = checked;
    input.setAttribute("aria-label", label);
    input.addEventListener("change", () => onChange(input.checked));
    return input;
}

function close() {
    overlay?.destroy();
    overlay = null;
}

export function openSettings() {
    close();
    overlay = createOverlay(SETTINGS_HOST_ID, CSS, `<div class="backdrop"><div class="dialog" role="dialog" aria-modal="true"><header><h2>NotionAI++<small></small></h2><button class="close" type="button">×</button></header><div class="body"></div></div></div>`);
    const { root } = overlay;
    root.querySelector("small")!.textContent = typeof VERSION === "string" ? VERSION : "";
    const closeButton = root.querySelector<HTMLButtonElement>(".close")!;
    closeButton.setAttribute("aria-label", t("关闭", "Close"));
    closeButton.addEventListener("click", close);
    root.querySelector(".backdrop")!.addEventListener("click", event => event.target === event.currentTarget && close());
    root.addEventListener("keydown", event => (event as KeyboardEvent).key === "Escape" && close());
    const body = root.querySelector(".body")!;
    for (const plugin of allPlugins().filter(p => !p.required)) {
        const section = document.createElement("section");
        const row = document.createElement("div");
        row.className = "row";
        const info = document.createElement("div");
        const name = document.createElement("div");
        name.className = "name";
        name.textContent = plugin.title;
        const desc = document.createElement("div");
        desc.className = "desc";
        desc.textContent = plugin.description;
        info.append(name, desc);
        const options = document.createElement("div");
        options.className = "options";
        options.toggleAttribute("data-off", !isEnabled(plugin));
        row.append(info, switchInput(isEnabled(plugin), plugin.title, value => {
            setEnabled(plugin, value);
            options.toggleAttribute("data-off", !value);
        }));
        section.append(row);
        for (const [key, def] of Object.entries(plugin.settings?.def ?? {})) {
            const store = plugin.settings!.store as Record<string, unknown>;
            const label = document.createElement("label");
            label.className = "opt";
            const span = document.createElement("span");
            span.textContent = def.label;
            label.append(span);
            if (def.type === "boolean") {
                label.append(switchInput(Boolean(store[key]), def.label, value => setValue(plugin.name, key, value)));
            } else {
                const select = document.createElement("select");
                for (const option of def.options) select.append(new Option(option.label, option.value, false, store[key] === option.value));
                select.addEventListener("change", () => setValue(plugin.name, key, select.value));
                label.append(select);
            }
            if (def.description) label.title = def.description;
            options.append(label);
        }
        if (options.childElementCount) section.append(options);
        body.append(section);
    }
    closeButton.focus();
}

export default definePlugin({
    name: "settings",
    title: "Settings",
    description: "NotionAI++ settings dialog and userscript menu commands.",
    enabledByDefault: true,
    required: true,
    start() {
        cleanups.push(on("openSettings", openSettings));
        if (typeof GM_registerMenuCommand === "function") {
            try {
                GM_registerMenuCommand(t("⚙️ NotionAI++ 设置", "⚙️ NotionAI++ settings"), openSettings);
            } catch {}
        }
    },
    stop() {
        for (const cleanup of cleanups.splice(0)) cleanup();
        close();
    },
});
