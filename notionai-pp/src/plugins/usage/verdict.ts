/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { clamp, isRecord, nonNegative } from "@utils/guards";

export type UsageStatus = "within_limit" | "rate_limited" | "not_applicable";

export interface Meter {
    used: number;
    limit: number;
    percent: number;
    resetAt: number | null;
}

export interface RollingMeter extends Meter {
    window: string;
}

export type UsageSnapshot =
    | { status: "not_applicable"; preview: boolean; updatedAt: number }
    | {
        status: "within_limit" | "rate_limited";
        rolling: RollingMeter;
        monthly: Meter | null;
        limitedBy: "rolling" | "billing_period" | null;
        preview: boolean;
        updatedAt: number;
    };

const STATUSES = new Set<UsageStatus>(["within_limit", "rate_limited", "not_applicable"]);
const PRIORITY_KEYS = ["creditRateLimitVerdict", "creditRateLimitStatus", "data", "result", "value"];
const MAX_DEPTH = 6;
const MAX_NODES = 240;

export function percentage(used: number, limit: number) {
    return limit > 0 && Number.isFinite(used) ? clamp((used / limit) * 100, 0, 100) : 0;
}

function isVerdict(value: unknown): value is Record<string, any> {
    if (!isRecord(value) || !STATUSES.has(value.status)) return false;
    if (value.status === "not_applicable") return true;
    return isRecord(value.window) && nonNegative(value.window.used) !== null && nonNegative(value.window.limit) !== null;
}

export function findVerdict(payload: unknown): Record<string, any> | null {
    const queue: { value: unknown; depth: number }[] = [{ value: payload, depth: 0 }];
    const seen = new Set<unknown>();
    for (let visited = 0; queue.length && visited < MAX_NODES; visited++) {
        const { value, depth } = queue.shift()!;
        if (isVerdict(value)) return value;
        if (depth >= MAX_DEPTH || typeof value !== "object" || value === null || seen.has(value)) continue;
        seen.add(value);
        const record = value as Record<string, unknown>;
        for (const key of PRIORITY_KEYS) {
            if (Object.hasOwn(record, key)) queue.unshift({ value: record[key], depth: depth + 1 });
        }
        for (const child of Object.values(record)) {
            if (child && typeof child === "object") queue.push({ value: child, depth: depth + 1 });
        }
    }
    return null;
}

function rollingReset(verdict: Record<string, any>, now: number): number | null {
    if (verdict.status === "within_limit") {
        const seconds = nonNegative(verdict.resetsInSeconds);
        return seconds === null ? null : now + seconds * 1000;
    }
    const retry = nonNegative(verdict.retryAfterSeconds);
    const resumes = nonNegative(verdict.resumesAtMs);
    if (verdict.limitedBy === "billing_period" && resumes !== null) return resumes;
    if (retry !== null) return now + retry * 1000;
    return resumes;
}

export function parseUsage(payload: unknown, now = Date.now()): UsageSnapshot | null {
    const verdict = findVerdict(payload);
    if (!verdict) return null;
    const preview = verdict.enforcement === "preview";
    if (verdict.status === "not_applicable") return { status: "not_applicable", preview, updatedAt: now };
    const used = nonNegative(verdict.window.used)!;
    const limit = nonNegative(verdict.window.limit)!;
    const windowName = verdict.window.window;
    const raw = verdict.billingPeriodWindow;
    let monthly: Meter | null = null;
    if (isRecord(raw)) {
        const mUsed = nonNegative(raw.used);
        const mLimit = nonNegative(raw.limit);
        const periodEnd = nonNegative(raw.periodEndMs);
        if (mUsed !== null && mLimit !== null && periodEnd !== null && periodEnd > now) {
            monthly = { used: mUsed, limit: mLimit, percent: percentage(mUsed, mLimit), resetAt: periodEnd };
        }
    }
    return {
        status: verdict.status,
        rolling: {
            used,
            limit,
            percent: percentage(used, limit),
            window: typeof windowName === "string" && windowName.length <= 16 ? windowName : "rolling",
            resetAt: rollingReset(verdict, now),
        },
        monthly,
        limitedBy: verdict.limitedBy === "rolling" || verdict.limitedBy === "billing_period" ? verdict.limitedBy : null,
        preview,
        updatedAt: now,
    };
}

export function activeMonthly(snapshot: UsageSnapshot, now = Date.now()): Meter | null {
    if (snapshot.status === "not_applicable" || !snapshot.monthly) return null;
    return (snapshot.monthly.resetAt ?? 0) > now ? snapshot.monthly : null;
}

export type Tone = "normal" | "warning" | "danger" | "waiting" | "neutral";

export const toneOf = (percent: number): Tone => percent >= 90 ? "danger" : percent >= 70 ? "warning" : "normal";

export interface MeterView {
    percent: number | null;
    tone: Tone;
}

export function meterViews(snapshot: UsageSnapshot | null, now = Date.now()): { rolling: MeterView; monthly: MeterView } {
    if (!snapshot) return { rolling: { percent: null, tone: "waiting" }, monthly: { percent: null, tone: "waiting" } };
    if (snapshot.status === "not_applicable") return { rolling: { percent: null, tone: "neutral" }, monthly: { percent: null, tone: "neutral" } };
    const limited = snapshot.status === "rate_limited";
    const view = (meter: Meter | null, isLimiter: boolean): MeterView => {
        if (!meter) return { percent: null, tone: limited && isLimiter ? "danger" : "neutral" };
        return { percent: meter.percent, tone: limited && isLimiter ? "danger" : toneOf(meter.percent) };
    };
    return {
        rolling: view(snapshot.rolling, snapshot.limitedBy !== "billing_period"),
        monthly: view(activeMonthly(snapshot, now), snapshot.limitedBy === "billing_period"),
    };
}
