/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getValue, reloadFromStorage, setValue } from "@api/Settings";
import plugin, { settings, STYLE_ID } from "@plugins/greetingCustomizer";
import { MANAGER_HOST_ID } from "@plugins/greetingCustomizer/manager";
import { escapeCssContent, loadGreetings, pickIndex, saveGreetings } from "@plugins/greetingCustomizer/store";
import { findGreeting, TARGET_ATTR } from "@plugins/greetingCustomizer/target";

/** Mirrors the Notion AI home: the AI face button (with accessory) above the themed greeting. */
function home(greeting = "Where are we off to first?") {
    document.body.innerHTML = `
        <div class="hero">
            <div><div><div style="position: relative">
                <div role="button" aria-label="Open personalization settings"><div>
                    <img alt="Notion AI face"><img alt="propeller accessory">
                </div></div>
                <div role="button" aria-label="Personalize" aria-hidden="true">Personalize</div>
            </div></div></div>
            <div id="greeting"><div style="font-size: 30px"><span>${greeting}</span></div></div>
            <div data-notion-chat-input-container><div role="textbox" contenteditable="true"></div></div>
        </div>`;
    return document.getElementById("greeting")!;
}

const flush = () => new Promise(resolve => setTimeout(resolve, 50));
const css = () => document.getElementById(STYLE_ID)?.textContent ?? "";
const go = (path: string) => history.pushState({}, "", path);
const rightClick = (el: Element) => el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));

beforeEach(() => {
    localStorage.clear();
    reloadFromStorage(null);
    settings.bind("GreetingCustomizer");
    go("/ai");
});

afterEach(() => {
    plugin.stop();
    document.body.innerHTML = "";
});

describe("GreetingCustomizer", () => {
    test("finds the greeting beside the AI face, whatever its wording", () => {
        const greeting = home("Ready when you are");
        expect(findGreeting()).toBe(greeting);
    });

    test("falls back to the old default wording without the face", () => {
        document.body.innerHTML = `<main><h1><span>How can I help you today?</span></h1><button>x</button></main>`;
        expect(findGreeting()?.tagName).toBe("H1");
    });

    test("marks and repaints the greeting on /ai only", async () => {
        saveGreetings(["Hello GG", "Second"]);
        const greeting = home();
        plugin.start();
        expect(greeting.getAttribute(TARGET_ATTR)).toBe("1");
        expect(css()).toContain('content: "Hello GG"');

        go("/chat?t=abc");
        await flush();
        expect(greeting.hasAttribute(TARGET_ATTR)).toBe(false);
    });

    test("refresh mode moves on once per entry to the home page", async () => {
        saveGreetings(["A", "B", "C"]);
        home();
        plugin.start();
        expect(css()).toContain('content: "A"');
        home();
        await flush();
        expect(css()).toContain('content: "A"');

        go("/chat?t=1");
        await flush();
        go("/ai");
        home();
        await flush();
        expect(css()).toContain('content: "B"');
    });

    test("manual mode rotates on click and shows a hint", async () => {
        saveGreetings(["A", "B"]);
        settings.store.mode = "manual";
        const greeting = home();
        plugin.start();
        expect(greeting.title).not.toBe("");
        expect(css()).toContain("cursor: pointer");
        const before = css();
        (greeting.querySelector("span") as HTMLElement).click();
        expect(css()).not.toBe(before);
    });

    test("interval mode rotates on a timer while home", async () => {
        saveGreetings(["A", "B"]);
        settings.store.mode = "interval";
        setValue("GreetingCustomizer", "intervalSec", 0.05);
        expect(settings.store.intervalSec).toBe(1);
        home();
        plugin.start();
        const first = css();
        await new Promise(resolve => setTimeout(resolve, 1100));
        expect(css()).not.toBe(first);
    });

    test("double right-click opens the manager, which adds greetings", () => {
        const greeting = home();
        plugin.start();
        rightClick(greeting);
        expect(document.getElementById(MANAGER_HOST_ID)).toBeNull();
        rightClick(greeting);
        const host = document.getElementById(MANAGER_HOST_ID)!;
        expect(host).not.toBeNull();
        const root = host.shadowRoot!;
        const textarea = root.querySelector("textarea")!;
        textarea.value = "  New line\nsecond  ";
        root.querySelector<HTMLButtonElement>("button.primary")!.click();
        expect(loadGreetings().at(-1)).toBe("New line\nsecond");
        expect(root.querySelectorAll("li").length).toBe(loadGreetings().length);
    });

    test("stop removes the paint and the mark", () => {
        const greeting = home();
        plugin.start();
        plugin.stop();
        expect(document.getElementById(STYLE_ID)).toBeNull();
        expect(greeting.hasAttribute(TARGET_ATTR)).toBe(false);
    });

    test("rotation and escaping helpers", () => {
        expect(pickIndex(3, "sequential", 2, true)).toBe(0);
        expect(pickIndex(3, "sequential", 7, false)).toBe(0);
        expect(pickIndex(3, "random", 1, true, () => 0.4)).not.toBe(1);
        expect(escapeCssContent('a"b\\c\nd')).toBe('a\\"b\\\\c\\a d');
        saveGreetings([]);
        expect(loadGreetings().length).toBe(3);
        expect(getValue("GreetingCustomizer", "greetings")).toBeString();
    });
});
