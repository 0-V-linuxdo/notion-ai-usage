/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { reloadFromStorage } from "@api/Settings";
import plugin, { isThinkingToggle, scan, settings } from "@plugins/autoCollapseThinking";

let counter = 0;

/** Mirrors the markup Notion AI renders for one reply's thinking group. */
function group({ label = "10 steps", expanded = true, streaming = false } = {}) {
    const id = `:r${++counter}:`;
    const wrap = document.createElement("div");
    wrap.setAttribute("role", "article");
    wrap.innerHTML = `
        <div role="button" tabindex="0" aria-expanded="${expanded}" aria-controls="${id}">
            ${streaming
                ? `<div><div role="status" aria-live="polite">${label}</div><div class="nds-shimmer-text">${label}</div></div>`
                : `<div>${label}</div>`}
            <svg></svg>
        </div>
        <div id="${id}">
            <div role="button" tabindex="0" aria-expanded="false" aria-controls="${id}-1" class="x87ps6o">
                <div class="notion-agent-tool-use-title">Searched the web</div>
            </div>
        </div>`;
    document.body.append(wrap);
    const toggle = wrap.firstElementChild as HTMLElement;
    // Stand-in for Notion's React handler.
    toggle.addEventListener("click", () =>
        toggle.setAttribute("aria-expanded", String(toggle.getAttribute("aria-expanded") !== "true")));
    return toggle;
}

const flush = () => new Promise(resolve => setTimeout(resolve, 50));
const expanded = (el: Element) => el.getAttribute("aria-expanded") === "true";

beforeEach(() => {
    localStorage.clear();
    reloadFromStorage(null);
    settings.bind("AutoCollapseThinking");
    document.body.innerHTML = "";
});

afterEach(() => plugin.stop());

describe("AutoCollapseThinking", () => {
    test("recognises the thinking group but not single step rows or the sidebar", () => {
        const toggle = group();
        expect(isThinkingToggle(toggle)).toBe(true);
        expect(isThinkingToggle(document.querySelector(".x87ps6o")!)).toBe(false);

        const sidebar = document.createElement("div");
        sidebar.className = "notion-sidebar";
        sidebar.innerHTML = `<div role="button" aria-expanded="true" aria-controls="x">Chats</div>`;
        document.body.append(sidebar);
        expect(isThinkingToggle(sidebar.firstElementChild!)).toBe(false);
    });

    test("recognises a group by its panel even with an unknown label", () => {
        expect(isThinkingToggle(group({ label: "Réflexion" }))).toBe(true);
    });

    test("collapses expanded groups already on the page", () => {
        const toggle = group();
        plugin.start();
        expect(expanded(toggle)).toBe(false);
    });

    test("leaves earlier replies alone when collapseHistory is off", () => {
        settings.store.collapseHistory = false;
        const toggle = group();
        plugin.start();
        expect(expanded(toggle)).toBe(true);
    });

    test("waits for a streaming reply to finish, then collapses it", async () => {
        plugin.start();
        const live = group({ label: "Noodling", streaming: true });
        await flush();
        expect(expanded(live)).toBe(true);

        live.querySelector("[role='status']")!.parentElement!.replaceWith(Object.assign(document.createElement("div"), { textContent: "7 steps" }));
        await flush();
        expect(expanded(live)).toBe(false);
    });

    test("immediate mode collapses while streaming", async () => {
        settings.store.mode = "immediate";
        plugin.start();
        const live = group({ label: "Noodling", streaming: true });
        await flush();
        expect(expanded(live)).toBe(false);
    });

    test("a group the user opens by hand stays open", async () => {
        const toggle = group({ expanded: false });
        plugin.start();
        // A real click: isTrusted is true only for user input.
        const click = new MouseEvent("click", { bubbles: true });
        Object.defineProperty(click, "isTrusted", { value: true });
        toggle.dispatchEvent(click);
        expect(expanded(toggle)).toBe(true);
        await flush();
        scan();
        expect(expanded(toggle)).toBe(true);
    });

    test("Notion re-expanding a finished group is undone", async () => {
        const toggle = group({ expanded: false });
        plugin.start();
        toggle.setAttribute("aria-expanded", "true");
        await flush();
        expect(expanded(toggle)).toBe(false);
    });

    test("stop() stops collapsing", async () => {
        plugin.start();
        plugin.stop();
        const toggle = group();
        await flush();
        expect(expanded(toggle)).toBe(true);
    });
});
