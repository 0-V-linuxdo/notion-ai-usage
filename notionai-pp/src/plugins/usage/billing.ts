/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { isRecord } from "@utils/guards";

export type Plan = "free" | "plus" | "business" | "enterprise" | "unknown";

export type SubscriptionStatus =
    | "active" | "trialing" | "past_due" | "unpaid" | "paused" | "canceled" | "incomplete" | "incomplete_expired" | "unknown";

export type BillingStatus =
    | { kind: "none"; updatedAt: number }
    | { kind: "subscription"; plan: Plan; status: SubscriptionStatus; periodEndAt: number | null; updatedAt: number }
    | {
        kind: "trial";
        plan: "business";
        startAt: number | null;
        endAt: number;
        autoConvert: boolean | null;
        serverNowAt: number | null;
        updatedAt: number;
    };

const PRODUCT_RANK = new Map<string, number>([
    ["free", 0], ["student", 1], ["personal", 2], ["plus", 3], ["business", 4], ["enterprise", 5], ["enterprise_limited", 5],
]);
const STATUSES = new Set<SubscriptionStatus>(["active", "trialing", "past_due", "unpaid", "paused", "canceled", "incomplete", "incomplete_expired"]);
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;
const DAY_MS = 86_400_000;
const MAX_TRIAL_MS = 2 * 366 * DAY_MS;
const MAX_ITEMS = 80;

export function parseIso(value: unknown): number | null {
    if (typeof value !== "string" || value.length < 20 || value.length > 80 || !ISO_RE.test(value)) return null;
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : null;
}

const items = (value: unknown): unknown[] =>
    Array.isArray(value) ? value.slice(0, MAX_ITEMS) : isRecord(value) ? Object.values(value).slice(0, MAX_ITEMS) : [];

const productOf = (item: unknown): string | null =>
    isRecord(item) && isRecord(item.price) && typeof item.price.product === "string" ? item.price.product : null;

function topProduct(list: unknown[]): string | null {
    let best: string | null = null;
    for (const product of list.map(productOf)) {
        if (product && PRODUCT_RANK.has(product) && (best === null || PRODUCT_RANK.get(product)! > PRODUCT_RANK.get(best)!)) best = product;
    }
    return best;
}

const hasUnknownProduct = (list: unknown[]) => list.some(item => {
    const product = productOf(item);
    return product !== null && !PRODUCT_RANK.has(product);
});

export function planOf(product: string | null): Plan {
    switch (product) {
        case "free": return "free";
        case "student":
        case "personal":
        case "plus": return "plus";
        case "business": return "business";
        case "enterprise":
        case "enterprise_limited": return "enterprise";
        default: return "unknown";
    }
}

export function billingDataOf(payload: unknown): Record<string, any> | null {
    if (!isRecord(payload)) return null;
    if (isRecord(payload.billingData)) return payload.billingData;
    return isRecord(payload.data) && isRecord(payload.data.billingData) ? payload.data.billingData : null;
}

export function parseBilling(payload: unknown, now = Date.now()): BillingStatus | null {
    const data = billingDataOf(payload);
    if (!data) return null;
    const subscription = isRecord(data.subscription) ? data.subscription : null;
    const trial = isRecord(data.trial) ? data.trial : null;
    const subTrialEnd = typeof subscription?.trialEnd === "string";
    const sepTrialEnd = typeof trial?.endDate === "string";
    if (subTrialEnd && sepTrialEnd) return null;
    const serverNowAt = isRecord(data.clock) && data.clock.externalId ? parseIso(data.clock.now) : null;
    const reference = serverNowAt ?? now;

    if (subTrialEnd || sepTrialEnd) {
        const source = subTrialEnd ? subscription! : trial!;
        const endAt = parseIso(subTrialEnd ? source.trialEnd : source.endDate);
        const startRaw = source.startDate;
        const startAt = parseIso(startRaw);
        if (endAt === null) return null;
        if (typeof startRaw === "string" && (startAt === null || startAt > endAt)) return null;
        if (endAt - reference > MAX_TRIAL_MS) return null;
        const list = items(source.items);
        const product = topProduct(list);
        if (endAt > reference && product === "business") {
            return {
                kind: "trial",
                plan: "business",
                startAt,
                endAt,
                autoConvert: !subTrialEnd && typeof trial!.autoConvert === "boolean" ? trial!.autoConvert : null,
                serverNowAt,
                updatedAt: now,
            };
        }
        if (endAt > reference && (product === null || hasUnknownProduct(list))) return null;
    }

    if (!subscription) return { kind: "none", updatedAt: now };
    const list = items(subscription.items);
    const product = topProduct(list);
    if (product === "free" && !hasUnknownProduct(list)) return { kind: "none", updatedAt: now };
    const plan = product && product !== "free" ? planOf(product) : "unknown";
    const planItem = list.find(item => productOf(item) !== null && (!product || productOf(item) === product));
    const periodEndAt = parseIso(subscription.currentPeriodEnd) ?? (isRecord(planItem) ? parseIso(planItem.currentPeriodEnd) : null);
    return {
        kind: "subscription",
        plan,
        status: STATUSES.has(subscription.status) ? subscription.status : "unknown",
        periodEndAt,
        updatedAt: now,
    };
}

export function trialNow(trial: Extract<BillingStatus, { kind: "trial" }>, now = Date.now()) {
    return trial.serverNowAt === null ? now : trial.serverNowAt + Math.max(0, now - trial.updatedAt);
}

export function trialActive(status: BillingStatus | null, now = Date.now()): boolean {
    return status?.kind === "trial" && status.endAt > trialNow(status, now);
}

export function trialDaysLeft(trial: Extract<BillingStatus, { kind: "trial" }>, now = Date.now()) {
    const reference = trialNow(trial, now);
    if (trial.endAt <= reference) return 0;
    const midnight = new Date(reference);
    midnight.setHours(0, 0, 0, 0);
    return Math.max(0, Math.ceil((trial.endAt - midnight.getTime()) / DAY_MS));
}

export function trialEndsToday(trial: Extract<BillingStatus, { kind: "trial" }>, now = Date.now()) {
    const today = new Date(trialNow(trial, now));
    const end = new Date(trial.endAt);
    return today.getFullYear() === end.getFullYear() && today.getMonth() === end.getMonth() && today.getDate() === end.getDate();
}

export function visibleBilling(status: BillingStatus | null, now = Date.now()): BillingStatus | null {
    if (!status) return null;
    if (status.kind === "trial") return trialActive(status, now) ? status : null;
    return status;
}
