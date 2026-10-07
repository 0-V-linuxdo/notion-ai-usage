/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";

import { observeNetwork, safeHeaders } from "@api/Network";

describe("network observer", () => {
    test("only allow-listed headers are kept", () => {
        const headers = safeHeaders({ Cookie: "token_v2=secret", Authorization: "Bearer x", "X-Notion-Space-Id": "abc", "Content-Type": "application/json" });
        expect(headers).toEqual({ "x-notion-space-id": "abc", "content-type": "application/json" });
        expect(JSON.stringify(headers)).not.toContain("secret");
    });

    test("matching requests are observed without consuming the response; others are untouched", async () => {
        const seen: string[] = [];
        const bodies: string[] = [];
        const original = window.fetch;
        window.fetch = (async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 })) as typeof fetch;
        const { installHooks } = await import("@api/Network");
        installHooks();
        const stop = observeNetwork({
            matches: url => url.pathname === "/api/v3/target",
            onExchange: exchange => {
                seen.push(exchange.url.pathname);
                exchange.body.then(body => bodies.push(body));
            },
        });
        const response = await window.fetch("/api/v3/target", { method: "POST", body: "{\"spaceId\":\"s\"}" });
        expect(await response.json()).toEqual({ ok: 1 });
        await window.fetch("/api/v3/other", { method: "POST", body: "private" });
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(seen).toEqual(["/api/v3/target"]);
        expect(bodies).toEqual(["{\"spaceId\":\"s\"}"]);
        stop();
        window.fetch = original;
    });
});
