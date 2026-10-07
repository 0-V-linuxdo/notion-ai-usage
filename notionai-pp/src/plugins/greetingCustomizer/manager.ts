/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { createOverlay, type Overlay } from "@api/Overlay";
import { el } from "@utils/dom";

import { tr } from "./lang";
import { loadGreetings, MAX_COUNT, MAX_LEN, normalizeGreeting, saveGreetings, validateGreeting } from "./store";

export const MANAGER_HOST_ID = "notionai-pp-greetings";

export interface RotationControls {
    get(): { mode: string; order: string; intervalSec: number };
    set(key: "mode" | "order" | "intervalSec", value: string | number): void;
}

const CSS = `
:host { all: initial; position: fixed; inset: 0; z-index: 2147483647; display: block;
  --bg: #fff; --text: #37352f; --muted: #787774; --border: rgba(15,15,15,.1); --hover: rgba(15,15,15,.05); --accent: #2383e2; --danger: #eb5757;
  font: 14px/1.45 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
:host([data-theme="dark"]) { --bg: #252525; --text: #ebebea; --muted: #9b9b9b; --border: rgba(255,255,255,.1); --hover: rgba(255,255,255,.06); }
* { box-sizing: border-box; }
.backdrop { position: absolute; inset: 0; background: rgba(15,15,15,.45); display: grid; place-items: center; padding: 16px; }
.dialog { width: min(860px, 100%); max-height: min(84vh, 860px); display: flex; flex-direction: column; overflow: hidden;
  border-radius: 12px; color: var(--text); background: var(--bg); box-shadow: 0 24px 60px rgba(0,0,0,.35); }
header { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--border); }
h2 { margin: 0; font-size: 16px; }
.close { width: 28px; height: 28px; border: 0; border-radius: 6px; color: var(--muted); background: transparent; font-size: 18px; cursor: pointer; }
.close:hover { background: var(--hover); color: var(--text); }
.body { display: grid; grid-template-columns: 1.15fr .85fr; gap: 14px; padding: 14px 18px; overflow: auto; }
@media (max-width: 760px) { .body { grid-template-columns: 1fr; } }
.card { display: flex; flex-direction: column; gap: 8px; min-width: 0; border: 1px solid var(--border); border-radius: 10px; padding: 12px; }
.label { font-size: 12px; color: var(--muted); }
textarea { width: 100%; min-height: 88px; resize: vertical; font: inherit; font-size: 13px; color: var(--text); background: transparent;
  border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; outline: none; }
textarea:focus, select:focus, input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(35,131,226,.18); outline: none; }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.row.split { justify-content: space-between; }
.counter { margin-left: auto; font-size: 12px; color: var(--muted); }
.error { color: var(--danger); font-size: 12.5px; }
.hint { color: var(--muted); font-size: 12.5px; }
button.btn { font: inherit; font-size: 13px; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 4px 12px; cursor: pointer; }
button.btn:hover { background: var(--hover); }
button.primary { color: #fff; background: var(--accent); border-color: var(--accent); }
button.primary:hover { background: #0b6fcc; }
ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
li { display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; }
li[data-current] { border-color: var(--accent); }
li[data-editing] { background: var(--hover); }
.text { flex: 1; min-width: 0; white-space: pre-wrap; word-break: break-word; font-size: 13px; }
.icon { width: 26px; height: 26px; border: 0; border-radius: 6px; background: transparent; cursor: pointer; font-size: 13px; }
.icon:hover { background: var(--hover); }
label.field { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 13px; }
select, input[type=number] { font: inherit; font-size: 13px; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 3px 6px; }
input[type=number] { width: 80px; }
input:disabled { opacity: .5; }
footer { display: flex; justify-content: flex-end; padding: 12px 18px; border-top: 1px solid var(--border); }
:focus-visible { outline: 2px solid #4e9cff; outline-offset: 2px; }
`;

let overlay: Overlay | null = null;

export function closeManager() {
    overlay?.destroy();
    overlay = null;
}

export const isManagerOpen = () => !!overlay;

export function openManager(rotation: RotationControls, currentIndex: () => number) {
    closeManager();
    overlay = createOverlay(MANAGER_HOST_ID, CSS, `<div class="backdrop"><div class="dialog" role="dialog" aria-modal="true"></div></div>`);
    const { root } = overlay;
    const dialog = root.querySelector(".dialog")!;
    root.querySelector(".backdrop")!.addEventListener("click", event => event.target === event.currentTarget && closeManager());
    root.addEventListener("keydown", event => (event as KeyboardEvent).key === "Escape" && closeManager());

    let greetings = loadGreetings();
    let editing = -1;

    const close = el("button", { class: "close", type: "button", "aria-label": tr("close"), title: tr("close"), text: "×" });
    close.addEventListener("click", closeManager);
    const header = el("header", {}, el("h2", { text: tr("title") }), close);

    // Left: editor + list.
    const textarea = el("textarea", { placeholder: tr("placeholder"), maxlength: String(MAX_LEN) });
    textarea.setAttribute("aria-label", tr("placeholder"));
    const error = el("div", { class: "error", role: "alert" });
    const submit = el("button", { class: "btn primary", type: "button", text: tr("add") });
    const cancel = el("button", { class: "btn", type: "button", text: tr("cancelEdit") });
    const counter = el("span", { class: "counter" });
    const saved = el("div", { class: "hint" });
    const list = el("ul");
    const left = el("div", { class: "card" },
        el("div", { class: "label", text: tr("newLabel") }),
        textarea, error,
        el("div", { class: "row" }, submit, cancel, counter),
        saved, list);

    const setError = (key: Parameters<typeof tr>[0] | null) => {
        error.textContent = key ? tr(key) : "";
        error.hidden = !key;
    };
    const syncCounter = () => void (counter.textContent = `${textarea.value.length}/${MAX_LEN}`);
    const stopEditing = () => {
        editing = -1;
        textarea.value = "";
        submit.textContent = tr("add");
        cancel.hidden = true;
        syncCounter();
    };

    function persist() {
        saveGreetings(greetings);
        greetings = loadGreetings();
    }

    function render() {
        saved.textContent = tr("saved", { count: greetings.length, max: MAX_COUNT });
        const current = currentIndex();
        list.replaceChildren(...greetings.map((greeting, index) => {
            const edit = el("button", { class: "icon", type: "button", title: tr("edit"), "aria-label": tr("edit"), text: "✍️" });
            const remove = el("button", { class: "icon", type: "button", title: tr("delete"), "aria-label": tr("delete"), text: "🗑️" });
            edit.addEventListener("click", () => {
                editing = index;
                textarea.value = greetings[index];
                submit.textContent = tr("saveEdit");
                cancel.hidden = false;
                setError(null);
                syncCounter();
                render();
                textarea.focus();
            });
            remove.addEventListener("click", () => {
                greetings.splice(index, 1);
                if (editing === index) stopEditing();
                else if (editing > index) editing--;
                persist();
                render();
            });
            const item = el("li", {}, el("div", { class: "text", text: greeting }), edit, remove);
            item.toggleAttribute("data-current", index === current);
            item.toggleAttribute("data-editing", index === editing);
            return item;
        }));
    }

    submit.addEventListener("click", () => {
        const problem = validateGreeting(textarea.value);
        if (problem) return setError(problem);
        if (editing < 0 && greetings.length >= MAX_COUNT) return setError("tooMany");
        const text = normalizeGreeting(textarea.value);
        if (editing >= 0) greetings[editing] = text;
        else greetings.push(text);
        setError(null);
        stopEditing();
        persist();
        render();
    });
    cancel.addEventListener("click", () => {
        stopEditing();
        setError(null);
        render();
    });
    textarea.addEventListener("input", syncCounter);
    textarea.addEventListener("keydown", event => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit.click();
    });

    // Right: rotation settings, shared with the NotionAI++ settings dialog.
    const values = rotation.get();
    const select = (key: "mode" | "order", options: [string, Parameters<typeof tr>[0]][]) => {
        const node = el("select");
        for (const [value, label] of options) node.append(el("option", { value, text: tr(label) }));
        node.value = values[key];
        node.addEventListener("change", () => {
            rotation.set(key, node.value);
            syncInterval();
        });
        return node;
    };
    const mode = select("mode", [["refresh", "modeRefresh"], ["interval", "modeInterval"], ["manual", "modeManual"]]);
    const order = select("order", [["sequential", "orderSequential"], ["random", "orderRandom"]]);
    const interval = el("input", { type: "number", min: "1", max: "3600", step: "1", value: String(values.intervalSec) });
    interval.addEventListener("change", () => {
        const value = Math.min(3600, Math.max(1, Math.round(Number(interval.value) || values.intervalSec)));
        interval.value = String(value);
        rotation.set("intervalSec", value);
    });
    const syncInterval = () => void (interval.disabled = mode.value !== "interval");
    const field = (label: Parameters<typeof tr>[0], control: HTMLElement) => el("label", { class: "field" }, el("span", { text: tr(label) }), control);
    const right = el("div", { class: "card" },
        el("div", { class: "label", text: tr("rotation") }),
        field("mode", mode), field("order", order), field("interval", interval),
        el("div", { class: "hint", text: tr("tip") }));

    const done = el("button", { class: "btn primary", type: "button", text: tr("done") });
    done.addEventListener("click", closeManager);

    dialog.append(header, el("div", { class: "body" }, left, right), el("footer", {}, done));
    stopEditing();
    setError(null);
    syncInterval();
    render();
    textarea.focus();
}
