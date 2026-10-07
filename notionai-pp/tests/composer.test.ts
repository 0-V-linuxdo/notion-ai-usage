/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, test } from "bun:test";

import { locateComposer } from "@plugins/usage/composer";

afterEach(() => void (document.body.innerHTML = ""));

function rect(el: Element, left: number, top: number, width: number, height: number) {
    (el as any).getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} });
}

describe("composer locator", () => {
    test("prefers Notion's chat input container and picks its rounded surface", () => {
        document.body.innerHTML = `
          <div data-notion-chat-input-container="true" class="container">
            <div class="surface" style="border-radius:16px;background-color:rgb(32,32,32)">
              <div class="inner"><div role="textbox" contenteditable="true" placeholder="Do anything with AI…"></div></div>
            </div>
          </div>
          <div class="other" style="border-radius:12px;background-color:#fff"><textarea placeholder="Comment"></textarea></div>`;
        rect(document.querySelector(".container")!, 270, 771, 730, 100);
        rect(document.querySelector(".surface")!, 294, 771, 682, 100);
        rect(document.querySelector(".inner")!, 294, 771, 682, 60);
        rect(document.querySelector("[role=textbox]")!, 294, 771, 682, 60);
        rect(document.querySelector("textarea")!, 10, 850, 300, 40);
        const match = locateComposer()!;
        expect((match.surface as HTMLElement).className).toBe("surface");
        expect(match.box.width).toBe(682);
    });

    test("works when the composer sits high on an empty chat", () => {
        document.body.innerHTML = `<div data-notion-chat-input-container="true"><div class="surface" style="border-radius:16px;background-color:#fff"><div role="textbox" contenteditable="true"></div></div></div>`;
        rect(document.querySelector("[data-notion-chat-input-container]")!, 300, 200, 700, 120);
        rect(document.querySelector(".surface")!, 300, 200, 700, 120);
        rect(document.querySelector("[role=textbox]")!, 310, 210, 680, 60);
        expect(locateComposer()?.box.top).toBe(200);
    });

    test("falls back to AI-labelled editors outside the container", () => {
        document.body.innerHTML = `<div class="panel" style="border-radius:10px;box-shadow:0 0 0 1px red"><div role="textbox" contenteditable="true" aria-placeholder="Ask AI anything"></div></div><div role="textbox" contenteditable="true" placeholder="Type '/' for commands"></div>`;
        rect(document.querySelector(".panel")!, 900, 700, 400, 90);
        const editors = document.querySelectorAll("[role=textbox]");
        rect(editors[0], 910, 710, 380, 40);
        rect(editors[1], 100, 100, 600, 40);
        expect((locateComposer()!.surface as HTMLElement).className).toBe("panel");
    });

    test("returns null when nothing is visible", () => {
        document.body.innerHTML = `<div data-notion-chat-input-container="true"><div role="textbox" contenteditable="true"></div></div>`;
        expect(locateComposer()).toBeNull();
    });
});
