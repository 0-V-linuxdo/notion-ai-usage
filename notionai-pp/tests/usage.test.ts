/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";

import { parseBilling, trialDaysLeft, visibleBilling } from "@plugins/usage/billing";
import { endpointKind, isAiMutation, spaceIdFrom, storedContext } from "@plugins/usage/context";
import { anchorFromBox, dockPoint, parseAnchor, pointFromAnchor } from "@plugins/usage/geometry";
import { meterViews, parseUsage } from "@plugins/usage/verdict";

const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const SPACE = "ecb751ab-49a8-818f-b0c6-0003002858fb";

describe("usage verdict", () => {
    test("within_limit with monthly window", () => {
        const snap = parseUsage({
            status: "within_limit",
            window: { window: "6h", used: 25, limit: 100 },
            resetsInSeconds: 600,
            billingPeriodWindow: { used: "50", limit: 200, periodEndMs: NOW + 1000 },
            enforcement: "preview",
        }, NOW)!;
        expect(snap.status).toBe("within_limit");
        if (snap.status === "not_applicable") throw new Error();
        expect(snap.rolling.percent).toBe(25);
        expect(snap.rolling.resetAt).toBe(NOW + 600_000);
        expect(snap.monthly?.percent).toBe(25);
        expect(snap.preview).toBe(true);
    });

    test("expired monthly window is dropped and percent is clamped", () => {
        const snap = parseUsage({ status: "within_limit", window: { used: 150, limit: 100 }, billingPeriodWindow: { used: 1, limit: 2, periodEndMs: NOW - 1 } }, NOW)!;
        if (snap.status === "not_applicable") throw new Error();
        expect(snap.rolling.percent).toBe(100);
        expect(snap.monthly).toBeNull();
        expect(snap.rolling.window).toBe("rolling");
    });

    test("rate_limited by billing period resumes at resumesAtMs", () => {
        const snap = parseUsage({ status: "rate_limited", window: { used: 1, limit: 1 }, limitedBy: "billing_period", resumesAtMs: NOW + 5, retryAfterSeconds: 9 }, NOW)!;
        if (snap.status === "not_applicable") throw new Error();
        expect(snap.rolling.resetAt).toBe(NOW + 5);
        expect(meterViews(snap, NOW).rolling.tone).toBe("danger");
    });

    test("nested verdict is found and not_applicable stays distinct", () => {
        expect(parseUsage({ data: { result: { status: "not_applicable" } } }, NOW)?.status).toBe("not_applicable");
        expect(meterViews(parseUsage({ status: "not_applicable" }, NOW), NOW).rolling.percent).toBeNull();
    });

    test("unsupported schema is rejected", () => {
        expect(parseUsage({ status: "within_limit", window: { used: -1, limit: 5 } }, NOW)).toBeNull();
        expect(parseUsage({ status: "weird" }, NOW)).toBeNull();
    });
});

describe("billing", () => {
    const sub = (product: string, extra = {}) => ({ billingData: { subscription: { status: "active", currentPeriodEnd: "2026-11-01T00:00:00Z", items: [{ price: { product } }], ...extra } } });

    test("active business subscription", () => {
        const status = parseBilling(sub("business"), NOW)!;
        expect(status.kind).toBe("subscription");
        if (status.kind !== "subscription") throw new Error();
        expect(status.plan).toBe("business");
        expect(status.periodEndAt).toBe(Date.parse("2026-11-01T00:00:00Z"));
    });

    test("free-only and missing subscription are none", () => {
        expect(parseBilling(sub("free"), NOW)?.kind).toBe("none");
        expect(parseBilling({ billingData: {} }, NOW)?.kind).toBe("none");
    });

    test("separate business trial counts days from local midnight", () => {
        const status = parseBilling({ billingData: { trial: { startDate: "2026-10-01T00:00:00Z", endDate: "2026-10-17T12:00:00Z", autoConvert: false, items: [{ price: { product: "business" } }] } } }, NOW)!;
        expect(status.kind).toBe("trial");
        if (status.kind !== "trial") throw new Error();
        expect(status.autoConvert).toBe(false);
        expect(trialDaysLeft(status, NOW)).toBeGreaterThanOrEqual(10);
        expect(visibleBilling(status, Date.parse("2026-10-18T00:00:00Z"))).toBeNull();
    });

    test("ambiguous or malformed trials are rejected", () => {
        expect(parseBilling({ billingData: { trial: { endDate: "x" }, subscription: { trialEnd: "2026-10-17T12:00:00Z" } } }, NOW)).toBeNull();
        expect(parseBilling({ billingData: { subscription: { trialEnd: "2026-10-17", items: [] } } }, NOW)).toBeNull();
    });

    test("unknown status stays unknown", () => {
        const status = parseBilling(sub("plus", { status: "mystery" }), NOW)!;
        if (status.kind !== "subscription") throw new Error();
        expect(status.status).toBe("unknown");
        expect(status.plan).toBe("plus");
    });
});

describe("context", () => {
    const origin = "https://app.notion.com";

    test("only exact same-origin paths match", () => {
        expect(endpointKind(new URL("/api/v3/getCreditRateLimitStatus", origin), origin)).toBe("current");
        expect(endpointKind(new URL("/api/v3/getCreditRateLimitStatus/x", origin), origin)).toBeNull();
        expect(endpointKind(new URL("https://evil.test/api/v3/getBillingData"), origin)).toBeNull();
        expect(isAiMutation(new URL("/api/v3/runInferenceTranscript", origin), "POST", origin)).toBe(true);
        expect(isAiMutation(new URL("/api/v3/runInferenceTranscript", origin), "GET", origin)).toBe(false);
    });

    test("space id comes from body or header and must look like a uuid", () => {
        expect(spaceIdFrom(JSON.stringify({ spaceId: SPACE }), undefined)).toBe(SPACE);
        expect(spaceIdFrom("", SPACE)).toBe(SPACE);
        expect(spaceIdFrom(JSON.stringify({ spaceId: "nope" }), "also-nope")).toBeNull();
    });

    test("stored workspace context is read from Notion's own key-value store", () => {
        localStorage.setItem("LRU:KeyValueStore2:lastVisitedRouteSpaceId", JSON.stringify({ id: "x", value: SPACE }));
        localStorage.setItem("LRU:KeyValueStore2:current-user-id", JSON.stringify({ id: "y", value: "37ad872b-594c-815d-85ea-00025d6b5fe2" }));
        expect(storedContext(localStorage)).toEqual({ spaceId: SPACE, userId: "37ad872b-594c-815d-85ea-00025d6b5fe2" });
        localStorage.setItem("LRU:KeyValueStore2:lastVisitedRouteSpaceId", "garbage");
        expect(storedContext(localStorage)).toBeNull();
        localStorage.clear();
    });
});

describe("geometry", () => {
    const vp = { width: 1344, height: 894 };

    test("orb docks centered inside the composer bottom", () => {
        const composer = { left: 294, top: 771, right: 976, bottom: 871, width: 682, height: 100 };
        const point = dockPoint(composer, { width: 48, height: 24 }, vp)!;
        expect(point.left).toBe(294 + (682 - 48) / 2);
        expect(point.top).toBe(871 - 24 - 7);
    });

    test("dock point stays inside the viewport when the composer is clipped", () => {
        const composer = { left: 10, top: 880, right: 400, bottom: 980, width: 390, height: 100 };
        const point = dockPoint(composer, { width: 48, height: 24 }, vp)!;
        expect(point.top).toBeLessThanOrEqual(vp.height - 24 - 8);
    });

    test("anchor round-trips through the nearest edges", () => {
        const box = { left: 1000, top: 700, right: 1200, bottom: 736, width: 200, height: 36 };
        const anchor = anchorFromBox(box, vp);
        expect(anchor).toEqual({ xEdge: "right", xOffset: 144, yEdge: "bottom", yOffset: 158 });
        expect(pointFromAnchor(anchor, vp, box)).toEqual({ left: 1000, top: 700 });
        expect(pointFromAnchor(anchor, { width: 800, height: 600 }, box)).toEqual({ left: 456, top: 406 });
        expect(parseAnchor({ xEdge: "left", xOffset: -1, yEdge: "top", yOffset: 0 })).toBeNull();
    });
});
