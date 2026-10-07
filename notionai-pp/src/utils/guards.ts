/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

export const isRecord = (value: unknown): value is Record<string, any> =>
    value !== null && typeof value === "object" && !Array.isArray(value);

export function finiteNumber(value: unknown): number | null {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value !== "string" || !value.trim()) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

export function nonNegative(value: unknown): number | null {
    const parsed = finiteNumber(value);
    return parsed !== null && parsed >= 0 ? parsed : null;
}

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export const SPACE_ID_RE = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export const isSpaceId = (value: unknown): value is string => typeof value === "string" && SPACE_ID_RE.test(value);

export function safeJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}
