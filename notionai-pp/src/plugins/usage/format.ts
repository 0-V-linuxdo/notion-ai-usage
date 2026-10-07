/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { t, uiLanguage } from "@utils/page";

import { type BillingStatus, type Plan, type SubscriptionStatus, trialDaysLeft, trialEndsToday } from "./billing";

export const formatPercent = (value: number | null) => value === null ? "—" : `${Math.round(value)}%`;

const locale = () => uiLanguage() === "zh" ? "zh-CN" : "en";

export function formatDate(time: number | null, withYear = false) {
    if (time === null || !Number.isFinite(time)) return t("未知", "Unknown");
    return new Intl.DateTimeFormat(locale(), {
        ...(withYear ? { year: "numeric" } : {}),
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    }).format(new Date(time));
}

export function formatReset(resetAt: number | null, now = Date.now()) {
    if (resetAt === null) return t("重置时间未知", "Reset time unavailable");
    const diff = resetAt - now;
    if (diff <= 0) return t("即将重置", "Resetting soon");
    if (diff > 86_400_000) return t(`${formatDate(resetAt)} 重置`, `Resets ${formatDate(resetAt)}`);
    const minutes = Math.max(1, Math.ceil(diff / 60_000));
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h && m) return t(`${h} 小时 ${m} 分钟后重置`, `Resets in ${h}h ${m}m`);
    if (h) return t(`${h} 小时后重置`, `Resets in ${h}h`);
    return t(`${m} 分钟后重置`, `Resets in ${m}m`);
}

export function formatUpdated(time: number | null, now = Date.now()) {
    if (time === null) return t("尚未更新", "Not updated yet");
    const s = Math.max(0, Math.floor((now - time) / 1000));
    if (s < 10) return t("刚刚更新", "Updated just now");
    if (s < 60) return t(`${s} 秒前更新`, `Updated ${s}s ago`);
    if (s < 3600) return t(`${Math.floor(s / 60)} 分钟前更新`, `Updated ${Math.floor(s / 60)}m ago`);
    return t(`${Math.floor(s / 3600)} 小时前更新`, `Updated ${Math.floor(s / 3600)}h ago`);
}

export function windowLabel(window: string) {
    if (window === "6h") return t("当前窗口（6 小时）", "Current window (6h)");
    if (window === "24h") return t("当前窗口（24 小时）", "Current window (24h)");
    return t("当前窗口", "Current window");
}

export function planName(plan: Plan) {
    switch (plan) {
        case "free": return "Free";
        case "plus": return "Plus";
        case "business": return "Business";
        case "enterprise": return "Enterprise";
        case "unknown": return t("未知", "Unknown");
    }
}

export function statusName(status: SubscriptionStatus) {
    switch (status) {
        case "active": return t("有效", "Active");
        case "trialing": return t("试用中", "Trialing");
        case "past_due": return t("逾期", "Past due");
        case "unpaid": return t("未付款", "Unpaid");
        case "paused": return t("已暂停", "Paused");
        case "canceled": return t("已取消", "Canceled");
        case "incomplete": return t("未完成", "Incomplete");
        case "incomplete_expired": return t("已失效", "Expired");
        case "unknown": return t("状态未知", "Status unavailable");
    }
}

export function billingSummary(status: BillingStatus | null, now = Date.now()): string | null {
    if (!status || status.kind === "none") return null;
    if (status.kind === "trial") {
        return trialEndsToday(status, now)
            ? t("试用 今天结束", "Trial ends today")
            : t(`试用 ${trialDaysLeft(status, now)}天`, `Trial ${trialDaysLeft(status, now)}d`);
    }
    return `${planName(status.plan)} · ${statusName(status.status)}`;
}

export interface BillingRow {
    label: string;
    value: string;
    detail: string;
}

export function billingRow(status: BillingStatus, now = Date.now()): BillingRow {
    switch (status.kind) {
        case "none":
            return { label: t("Free 套餐", "Free Plan"), value: t("未订阅", "No subscription"), detail: "" };
        case "trial":
            return {
                label: t("Business 试用", "Business Trial"),
                value: trialEndsToday(status, now)
                    ? t("今天结束", "Ends today")
                    : t(`剩余 ${trialDaysLeft(status, now)} 天`, `${trialDaysLeft(status, now)} days left`),
                detail: t(`${formatDate(status.endAt, true)} 结束`, `Ends ${formatDate(status.endAt, true)}`),
            };
        case "subscription":
            return {
                label: t(`${planName(status.plan)} 套餐`, `${planName(status.plan)} Plan`),
                value: statusName(status.status),
                detail: status.periodEndAt === null ? "" : t(`当前周期至 ${formatDate(status.periodEndAt, true)}`, `Current period ends ${formatDate(status.periodEndAt, true)}`),
            };
    }
}
