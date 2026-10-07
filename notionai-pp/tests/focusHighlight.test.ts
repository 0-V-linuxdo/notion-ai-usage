/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getValue, reloadFromStorage, setValue } from "@api/Settings";
import plugin, { BOX_ATTR, colorFor, findPromptBoxes, inRightStrip, isPanelOpen, migrateLegacy, scan, settings } from "@plugins/focusHighlight";

/** Mirrors the Notion AI chat composer: container > … > rounded surface > … > editor. */
function composer() {
    const container = document.createElement("div");
    container.setAttribute("data-notion-chat-input-container", "true");
    container.innerHTML = `
        <div class="surface" style="border-radius: 16px; background-color: rgb(32, 32, 32);">
            <div style="position: relative;"><div role="textbox" contenteditable="true" placeholder="Do anything with AI…"></div></div>
        </div>`;
    document.body.append(container);
    return container.querySelector(".surface") as HTMLElement;
}

function rect(el: Element, left: number, top: number, width: number, height: number) {
    el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} }) as DOMRect;
}

const contextmenu = (x: number, y: number) => {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y });
    document.body.dispatchEvent(event);
    return event;
};

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
    reloadFromStorage(null);
});

afterEach(() => {
    if (plugin.started) plugin.stop();
    plugin.started = false;
});

describe("prompt box detection", () => {
    test("finds the rounded surface inside the chat input container", () => {
        const surface = composer();
        expect(findPromptBoxes()).toEqual([surface]);
    });

    test("falls back to AI-looking editors outside the container", () => {
        document.body.innerHTML = `<div class="box" style="border-radius: 10px; border: 1px solid red;"><div role="textbox" contenteditable="true" placeholder="Ask AI anything"></div></div>
            <div style="border-radius: 10px; border: 1px solid red;"><div role="textbox" contenteditable="true" placeholder="Type '/' for commands"></div></div>`;
        expect(findPromptBoxes()).toEqual([document.querySelector(".box")!]);
    });

    test("scan marks and unmarks boxes", () => {
        const surface = composer();
        scan();
        expect(surface.hasAttribute(BOX_ATTR)).toBe(true);
        surface.parentElement!.remove();
        scan();
        expect(surface.hasAttribute(BOX_ATTR)).toBe(false);
    });
});

describe("colours", () => {
    test("defaults per theme and rejects invalid values", () => {
        expect(colorFor("light")).toBe("#37352f");
        expect(colorFor("dark")).toBe("#ffffff");
        setValue("FocusHighlight", "darkColor", "red");
        expect(colorFor("dark")).toBe("#ffffff");
        settings.store.darkColor = "#FF8800";
        expect(colorFor("dark")).toBe("#ff8800");
    });

    test("start injects a style using the current theme colour", () => {
        settings.store.lightColor = "#123456";
        composer();
        plugin.start();
        plugin.started = true;
        const css = document.getElementById("notionai-pp-focus-highlight")!.textContent!;
        expect(css).toContain("#123456");
        expect(css).toContain(`[${BOX_ATTR}]`);
        plugin.stop();
        plugin.started = false;
        expect(document.getElementById("notionai-pp-focus-highlight")).toBeNull();
        expect(document.querySelector(`[${BOX_ATTR}]`)).toBeNull();
    });

    test("migrates the standalone script's localStorage colours once", () => {
        localStorage.setItem("notionAiFocusHighlightColorLight", "#abc");
        localStorage.setItem("notionAiFocusHighlightColorDark", "#00FF00");
        migrateLegacy();
        expect(getValue("FocusHighlight", "lightColor")).toBe("#aabbcc");
        expect(getValue("FocusHighlight", "darkColor")).toBe("#00ff00");
        settings.store.lightColor = "#111111";
        migrateLegacy();
        expect(colorFor("light")).toBe("#111111");
    });
});

describe("double right-click", () => {
    test("hit strip is just right of the box", () => {
        const surface = composer();
        rect(surface, 300, 700, 600, 100);
        expect(inRightStrip(950, 750, surface)).toBe(true);
        expect(inRightStrip(899, 750, surface)).toBe(false);
        expect(inRightStrip(990, 750, surface)).toBe(false);
        expect(inRightStrip(950, 820, surface)).toBe(false);
    });

    test("two right-clicks in the strip open the panel, two more close it", () => {
        const surface = composer();
        rect(surface, 300, 700, 600, 100);
        plugin.start();
        plugin.started = true;
        expect(contextmenu(950, 750).defaultPrevented).toBe(true);
        expect(isPanelOpen()).toBe(false);
        contextmenu(952, 751);
        expect(isPanelOpen()).toBe(true);
        expect(document.getElementById("notionai-pp-focus-panel")).not.toBeNull();
        contextmenu(950, 750);
        contextmenu(950, 750);
        expect(isPanelOpen()).toBe(false);
    });

    test("right-clicks elsewhere keep the native menu", () => {
        const surface = composer();
        rect(surface, 300, 700, 600, 100);
        plugin.start();
        plugin.started = true;
        expect(contextmenu(500, 750).defaultPrevented).toBe(false);
        contextmenu(500, 750);
        expect(isPanelOpen()).toBe(false);
    });
});
