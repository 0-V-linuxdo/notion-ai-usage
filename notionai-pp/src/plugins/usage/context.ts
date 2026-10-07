/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { isRecord, isSpaceId, safeJson } from "@utils/guards";

export const CURRENT_PATH = "/api/v3/getCreditRateLimitStatus";
export const LEGACY_PATH = "/api/v3/getAIUsageEligibility";
export const BILLING_PATH = "/api/v3/getBillingData";
const AI_MUTATION_RE = /\/(?:runInference|invokeAgent|submitAi|sendAi|createInference)/i;
const SPACE_KEY = "LRU:KeyValueStore2:lastVisitedRouteSpaceId";
const USER_KEY = "LRU:KeyValueStore2:current-user-id";
const MAX_USER_ID = 128;

export type EndpointKind = "current" | "legacy" | "billing";

export function endpointKind(url: URL, origin: string): EndpointKind | null {
    if (url.origin !== origin) return null;
    switch (url.pathname) {
        case CURRENT_PATH: return "current";
        case LEGACY_PATH: return "legacy";
        case BILLING_PATH: return "billing";
        default: return null;
    }
}

export const isAiMutation = (url: URL, method: string, origin: string) =>
    method !== "GET" && url.origin === origin && !endpointKind(url, origin) && AI_MUTATION_RE.test(url.pathname);

export function spaceIdFrom(body: string, header: string | undefined): string | null {
    const parsed = safeJson(body);
    if (isRecord(parsed) && isSpaceId(parsed.spaceId)) return parsed.spaceId;
    return isSpaceId(header) ? header : null;
}

export function validUserId(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 && value.length <= MAX_USER_ID && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}

function storedValue(storage: Storage, key: string): unknown {
    const parsed = safeJson(storage.getItem(key) ?? "");
    return isRecord(parsed) ? parsed.value : null;
}

export function storedContext(storage: Storage): { spaceId: string; userId: string | null } | null {
    try {
        const spaceId = storedValue(storage, SPACE_KEY);
        if (!isSpaceId(spaceId)) return null;
        return { spaceId, userId: validUserId(storedValue(storage, USER_KEY)) };
    } catch {
        return null;
    }
}
