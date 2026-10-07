/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { type Exchange, nativeFetch, nextSequence, observeNetwork, type SafeHeader } from "@api/Network";
import { safeJson } from "@utils/guards";
import { Logger } from "@utils/Logger";
import { pageWindow, t } from "@utils/page";

import { type BillingStatus, parseBilling, trialActive } from "./billing";
import { BILLING_PATH, CURRENT_PATH, endpointKind, type EndpointKind, isAiMutation, spaceIdFrom, storedContext, validUserId } from "./context";
import { parseUsage, type UsageSnapshot } from "./verdict";

const logger = new Logger("Usage");

const HEARTBEAT_MS = 30_000;
const POLL_MS = 60_000;
const NOT_APPLICABLE_POLL_MS = 6 * 3_600_000;
const MIN_REFRESH_MS = 15_000;
const MIN_ATTEMPT_MS = 5_000;
const BILLING_EVERY_MS = 3_600_000;
const TIMEOUT_MS = 12_000;
const NATIVE_GRACE_MS = 1_000;
const SEED_DELAY_MS = 1_200;
const MUTATION_DELAY_MS = 4_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const FIRST_BACKOFF_MS = 15_000;
const BILLING_RETRY_MS = 15 * 60_000;
const RATE_LIMIT_RETRY_MS = 60_000;

type Headers = Partial<Record<SafeHeader, string>>;

class HttpError extends Error {
    constructor(public status: number, public retryAfter: number | null) {
        super(`HTTP ${status}`);
    }
}

interface Track {
    timer: ReturnType<typeof setTimeout> | null;
    dueAt: number;
    busy: boolean;
    controller: AbortController | null;
    lastAttemptAt: number;
    lastSuccessAt: number;
    acceptedSequence: number;
    blockedUntil: number;
    backoff: number;
    disabled: boolean;
    error: string;
}

const newTrack = (): Track => ({
    timer: null, dueAt: 0, busy: false, controller: null, lastAttemptAt: 0, lastSuccessAt: 0,
    acceptedSequence: 0, blockedUntil: 0, backoff: 0, disabled: false, error: "",
});

export interface UsageState {
    snapshot: UsageSnapshot | null;
    billing: BillingStatus | null;
    spaceId: string | null;
    loading: boolean;
    error: string;
    canRefresh: boolean;
}

export class UsageService {
    snapshot: UsageSnapshot | null = null;
    billing: BillingStatus | null = null;
    spaceId: string | null = null;
    userId: string | null = null;
    private headers: Headers = {};
    private version = 0;
    private usage = newTrack();
    private bill = newTrack();
    private cleanups: (() => void)[] = [];
    private listeners = new Set<() => void>();

    onChange(listener: () => void) {
        this.listeners.add(listener);
        return () => void this.listeners.delete(listener);
    }

    private emit() {
        for (const listener of [...this.listeners]) listener();
    }

    get state(): UsageState {
        const now = Date.now();
        return {
            snapshot: this.snapshot,
            billing: this.billing,
            spaceId: this.spaceId,
            loading: this.usage.busy || this.bill.busy,
            error: [this.usage.error, this.bill.error].filter(Boolean).join(t("；", "; ")),
            canRefresh: !!this.spaceId && !this.usage.busy && !(this.usage.disabled && this.bill.disabled)
                && now >= Math.max(this.usage.blockedUntil, this.usage.lastSuccessAt + MIN_REFRESH_MS),
        };
    }

    start() {
        const origin = pageWindow.location.origin;
        this.cleanups.push(observeNetwork({
            matches: (url, method) => !!endpointKind(url, origin) || isAiMutation(url, method, origin),
            onExchange: exchange => this.observe(exchange, endpointKind(exchange.url, origin)),
        }));
        const seed = setTimeout(() => this.seedFromStorage(), SEED_DELAY_MS);
        const heartbeat = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
        const onVisible = () => !document.hidden && this.heartbeat();
        document.addEventListener("visibilitychange", onVisible);
        this.cleanups.push(() => {
            clearTimeout(seed);
            clearInterval(heartbeat);
            document.removeEventListener("visibilitychange", onVisible);
            for (const track of [this.usage, this.bill]) {
                if (track.timer) clearTimeout(track.timer);
                track.controller?.abort();
            }
        });
    }

    stop() {
        for (const cleanup of this.cleanups.splice(0)) cleanup();
        this.listeners.clear();
    }

    refreshNow() {
        this.refreshBilling(true);
        this.refreshUsage();
    }

    private seedFromStorage() {
        if (this.spaceId) return;
        const stored = storedContext(pageWindow.localStorage);
        if (!stored) return;
        logger.info("Using the workspace remembered by Notion until a native request arrives.");
        const headers: Headers = stored.userId ? { "x-notion-active-user-header": stored.userId } : {};
        this.acceptContext(stored.spaceId, headers, 0);
        this.schedule(this.usage, 0, () => this.refreshUsage());
        this.schedule(this.bill, 250, () => this.refreshBilling());
    }

    private acceptContext(spaceId: string, headers: Headers, sequence: number) {
        const userId = validUserId(headers["x-notion-active-user-header"]);
        const changed = spaceId !== this.spaceId || (!!userId && !!this.userId && userId !== this.userId);
        if (changed) {
            this.version++;
            for (const track of [this.usage, this.bill]) {
                track.controller?.abort();
                if (track.timer) clearTimeout(track.timer);
                Object.assign(track, newTrack());
            }
            this.snapshot = null;
            this.billing = null;
            this.headers = {};
        }
        this.spaceId = spaceId;
        this.userId = userId ?? this.userId;
        this.headers = { ...this.headers, ...headers, "content-type": "application/json", "x-notion-space-id": spaceId };
        if (changed) this.emit();
        return { version: this.version, sequence };
    }

    private observe(exchange: Exchange, kind: EndpointKind | null) {
        if (!kind) {
            exchange.response.then(response => response?.ok && this.schedule(this.usage, MUTATION_DELAY_MS, () => this.refreshUsage()));
            return;
        }
        if (kind === "current") this.usage.lastAttemptAt = Date.now();
        const context = exchange.body.then(body => {
            const spaceId = spaceIdFrom(body, exchange.headers["x-notion-space-id"]);
            return spaceId ? this.acceptContext(spaceId, exchange.headers, exchange.sequence) : null;
        });
        context.then(token => {
            if (!token) return;
            if (!this.snapshot) {
                const delay = kind === "current" ? NATIVE_GRACE_MS : 400;
                this.schedule(this.usage, delay, () => this.refreshUsage());
            }
            this.schedule(this.bill, kind === "billing" ? 1_500 : 250, () => this.refreshBilling());
        });
        if (kind === "legacy") return;
        Promise.all([exchange.response, context]).then(async ([response, token]) => {
            if (!response?.ok || !token || token.version !== this.version) return;
            const payload = safeJson(await response.text());
            if (token.version !== this.version) return;
            this.accept(kind, payload, token.sequence);
        }).catch(() => logger.debug(`Could not read native ${kind} response.`));
    }

    private accept(kind: "current" | "billing", payload: unknown, sequence: number): boolean {
        const track = kind === "current" ? this.usage : this.bill;
        if (sequence <= track.acceptedSequence) return true;
        if (kind === "current") {
            const snapshot = parseUsage(payload);
            if (!snapshot) {
                track.error = t("Notion 返回了暂不支持的用量数据结构", "Notion returned an unsupported usage schema");
                this.emit();
                return false;
            }
            this.snapshot = snapshot;
        } else {
            const billing = parseBilling(payload);
            if (!billing) return false;
            this.billing = billing;
        }
        Object.assign(track, { acceptedSequence: sequence, lastSuccessAt: Date.now(), backoff: 0, blockedUntil: 0, disabled: false, error: "" });
        this.emit();
        return true;
    }

    private schedule(track: Track, delay: number, run: () => void) {
        if (!this.spaceId || document.hidden || track.disabled) return;
        const now = Date.now();
        const dueAt = Math.max(now + delay, track.blockedUntil, track.lastAttemptAt ? track.lastAttemptAt + MIN_ATTEMPT_MS : 0);
        if (track.timer && track.dueAt <= dueAt) return;
        if (track.timer) clearTimeout(track.timer);
        track.dueAt = dueAt;
        track.timer = setTimeout(() => {
            track.timer = null;
            run();
        }, dueAt - now);
    }

    private heartbeat() {
        this.emit();
        if (document.hidden || !this.spaceId) return;
        const now = Date.now();
        const trialEnded = this.billing?.kind === "trial" && !trialActive(this.billing, now);
        if (trialEnded || now - this.bill.lastSuccessAt >= BILLING_EVERY_MS) this.refreshBilling(trialEnded);
        const interval = this.snapshot?.status === "not_applicable" ? NOT_APPLICABLE_POLL_MS : POLL_MS;
        if (now - Math.max(this.usage.lastSuccessAt, this.usage.lastAttemptAt) >= interval) this.refreshUsage();
    }

    private refreshUsage() {
        if (Date.now() - this.usage.lastSuccessAt < MIN_REFRESH_MS) return;
        void this.request(this.usage, CURRENT_PATH, "current");
    }

    private refreshBilling(force = false) {
        const track = this.bill;
        if (!force && Date.now() - track.lastSuccessAt < BILLING_EVERY_MS) return;
        if (Date.now() - track.lastAttemptAt < MIN_REFRESH_MS) return;
        void this.request(track, BILLING_PATH, "billing");
    }

    private async request(track: Track, path: string, kind: "current" | "billing") {
        const now = Date.now();
        if (!this.spaceId || track.busy || track.disabled || document.hidden || now < track.blockedUntil) return;
        if (kind === "current" && now - track.lastAttemptAt < MIN_ATTEMPT_MS) return;
        const version = this.version;
        const sequence = nextSequence();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
        Object.assign(track, { busy: true, controller, lastAttemptAt: now });
        this.emit();
        try {
            const response = await nativeFetch()(new URL(path, pageWindow.location.origin).href, {
                method: "POST",
                credentials: "include",
                cache: "no-store",
                headers: { ...this.headers },
                body: JSON.stringify({ spaceId: this.spaceId }),
                signal: controller.signal,
            });
            if (!response.ok) throw new HttpError(response.status, Number(response.headers.get("retry-after")) || null);
            const text = await response.text();
            if (version !== this.version) return;
            if (!this.accept(kind, safeJson(text), sequence)) throw new Error("unsupported-schema");
        } catch (error) {
            if (version !== this.version || sequence <= track.acceptedSequence) return;
            this.fail(track, kind, error);
        } finally {
            clearTimeout(timeout);
            if (track.controller === controller) {
                track.busy = false;
                track.controller = null;
            }
            this.emit();
        }
    }

    private fail(track: Track, kind: "current" | "billing", error: unknown) {
        const status = error instanceof HttpError ? error.status : 0;
        const retryAfter = error instanceof HttpError && error.retryAfter ? error.retryAfter * 1000 : null;
        const aborted = (error as Error)?.name === "AbortError";
        if (status === 401 || status === 403) {
            track.disabled = true;
            track.error = kind === "current"
                ? t("主动读取没有权限；请打开原生用量页触发 Notion 自身请求", "Active refresh is not permitted; open the native Usage page")
                : t("无法读取订阅状态：当前账户没有账单数据权限", "Subscription status unavailable for this account");
            return;
        }
        if (kind === "current") {
            track.backoff = track.backoff ? Math.min(track.backoff * 2, MAX_BACKOFF_MS) : FIRST_BACKOFF_MS;
            track.blockedUntil = Date.now() + Math.max(track.backoff, retryAfter ?? 0);
            track.error = status === 429
                ? t("请求过于频繁，稍后自动重试", "Too many requests; retrying later")
                : aborted ? t("读取用量超时", "Usage request timed out") : t("暂时无法读取 Notion AI 用量", "Unable to load Notion AI usage");
            return;
        }
        if (status === 429) track.blockedUntil = Date.now() + (retryAfter ?? RATE_LIMIT_RETRY_MS);
        else if (!aborted) track.blockedUntil = Date.now() + BILLING_RETRY_MS;
        track.error = status === 429
            ? t("订阅状态请求过于频繁，稍后自动重试", "Subscription status was rate limited; retrying later")
            : aborted ? t("读取订阅状态超时", "Subscription status timed out") : t("暂时无法读取订阅状态", "Unable to load subscription status");
    }
}
