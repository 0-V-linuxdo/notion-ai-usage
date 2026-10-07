/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanLines, collectMessages, summarize } from "@plugins/navigator/messages";

afterEach(() => void (document.body.innerHTML = ""));

function chat() {
    document.body.innerHTML = `
      <div id="transcript">
        <div><div><div data-agent-chat-user-step-id="u1"><div>
          <div class="bubble"><div><div data-content-editable-leaf="true" contenteditable="false">任务: 汇总红警2单位属性</div></div></div>
          <div><div>October 7 at 1:10 AM</div><div><div role="button" aria-label="Copy text"></div></div></div>
        </div></div></div></div>
        <div>
          <div class="col">
            <div><div role="button" aria-expanded="false" aria-controls=":r1:"><div>10 steps</div><svg></svg></div></div>
            <div class="body">汇总表已经改成数据库了</div>
          </div>
          <div><div role="button" aria-label="Copy response"></div></div>
        </div>
        <div><div><div data-agent-chat-user-step-id="u2"><div>
          <div class="bubble"><div><div data-content-editable-leaf="true">补上单位的图片!</div></div></div>
          <div><div>3:27 AM</div></div>
        </div></div></div></div>
        <div>
          <div class="col">
            <div><div role="button" aria-expanded="true" aria-controls=":r2:"><div>7 steps</div></div></div>
            <div id=":r2:">Searched the web</div>
            <div class="body">图片已补上</div>
          </div>
        </div>
      </div>`;
}

describe("chat navigator detection", () => {
    test("user steps and the assistant replies that follow them", () => {
        chat();
        const messages = collectMessages();
        expect(messages.map(m => [m.role, m.id])).toEqual([
            ["user", "u1"], ["assistant", "u1:assistant"], ["user", "u2"], ["assistant", "u2:assistant"],
        ]);
        expect(messages[0].text).toBe("任务: 汇总红警2单位属性");
        expect(messages[0].element.classList.contains("bubble")).toBe(true);
        expect(messages[1].element.classList.contains("body")).toBe(true);
        expect(messages[1].text).toBe("汇总表已经改成数据库了");
        expect(messages[3].text).toBe("图片已补上");
    });

    test("noise lines are removed and summaries are truncated", () => {
        expect(cleanLines("10 steps\nOctober 7 at 3:03 AM\nHello\nSearched the web")).toEqual(["Hello"]);
        expect(summarize("x".repeat(70))).toBe(`${"x".repeat(60)}…`);
    });

    test("falls back to copy buttons when Notion has no user step ids", () => {
        document.body.innerHTML = `
          <main>
            <div><div class="q">How do I export?</div><div><span>Today</span><button aria-label="Copy text"></button></div></div>
            <div><div class="content"><div>Thought for 3s</div><div class="answer">Use the export menu in settings.</div></div><div><button aria-label="Copy response"></button></div></div>
          </main>`;
        const messages = collectMessages();
        expect(messages.map(m => m.role)).toEqual(["user", "assistant"]);
        expect(messages[1].element.classList.contains("answer")).toBe(true);
    });
});
