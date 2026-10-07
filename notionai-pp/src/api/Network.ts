/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { Logger } from "@utils/Logger";
import { pageWindow } from "@utils/page";

const logger = new Logger("Network");

export const SAFE_HEADERS = [
    "content-type",
    "notion-client-version",
    "x-notion-active-user-header",
    "x-notion-cell",
    "x-notion-space-id",
] as const;

export type SafeHeader = typeof SAFE_HEADERS[number];

export const MAX_BODY_CHARS = 2_000_000;

export interface ObservedResponse {
    ok: boolean;
    status: number;
    text(): Promise<string>;
}

export interface Exchange {
    url: URL;
    method: string;
    sequence: number;
    headers: Partial<Record<SafeHeader, string>>;
    body: Promise<string>;
    response: Promise<ObservedResponse | null>;
}

export interface NetworkObserver {
    matches(url: URL, method: string): boolean;
    onExchange(exchange: Exchange): void;
}

const original: typeof fetch | null = typeof pageWindow.fetch === "function" ? pageWindow.fetch.bind(pageWindow) : null;
const observers = new Set<NetworkObserver>();
let sequence = 0;
let installed = false;

export function observeNetwork(observer: NetworkObserver) {
    installHooks();
    observers.add(observer);
    return () => void observers.delete(observer);
}

export const nextSequence = () => ++sequence;

export function readHeader(headers: unknown, name: string): string | null {
    if (!headers) return null;
    try {
        if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name);
        if (Array.isArray(headers)) {
            const entry = headers.find(item => Array.isArray(item) && String(item[0]).toLowerCase() === name);
            return entry ? String(entry[1]) : null;
        }
        if (typeof headers === "object") {
            const key = Object.keys(headers as object).find(k => k.toLowerCase() === name);
            return key ? String((headers as Record<string, unknown>)[key]) : null;
        }
    } catch {}
    return null;
}

export function safeHeaders(headers: unknown): Partial<Record<SafeHeader, string>> {
    const result: Partial<Record<SafeHeader, string>> = {};
    for (const name of SAFE_HEADERS) {
        const value = readHeader(headers, name);
        if (typeof value === "string" && value.length <= 512) result[name] = value;
    }
    return result;
}

function interested(url: URL, method: string) {
    return [...observers].filter(observer => {
        try {
            return observer.matches(url, method);
        } catch {
            return false;
        }
    });
}

function resolveUrl(raw: string): URL | null {
    try {
        return new URL(raw, pageWindow.location.href);
    } catch {
        return null;
    }
}

function dispatch(targets: NetworkObserver[], exchange: Exchange) {
    for (const observer of targets) {
        try {
            observer.onExchange(exchange);
        } catch (error) {
            logger.error("Network observer failed:", error);
        }
    }
}

const isInstance = (value: unknown, name: string) => {
    const ctor = (pageWindow as any)[name];
    return typeof ctor === "function" && value instanceof ctor;
};

function fetchBody(input: unknown, init: RequestInit | undefined): Promise<string> {
    if (init && "body" in init) {
        const { body } = init;
        if (typeof body === "string") return Promise.resolve(body);
        if (isInstance(body, "URLSearchParams")) return Promise.resolve(String(body));
        return Promise.resolve("");
    }
    if (isInstance(input, "Request")) {
        try {
            return (input as Request).clone().text().catch(() => "");
        } catch {
            return Promise.resolve("");
        }
    }
    return Promise.resolve("");
}

function wrapFetchResponse(response: Response): ObservedResponse {
    const copy = response.clone();
    return {
        ok: response.ok,
        status: response.status,
        async text() {
            const declared = Number(response.headers.get("content-length"));
            if (declared > MAX_BODY_CHARS) throw new Error("response-too-large");
            const text = await copy.text();
            if (text.length > MAX_BODY_CHARS) throw new Error("response-too-large");
            return text;
        },
    };
}

function installFetch() {
    const nativeFetch = pageWindow.fetch;
    if (typeof nativeFetch !== "function") return;
    function fetch(this: unknown, input: RequestInfo | URL, init?: RequestInit) {
        let targets: NetworkObserver[] = [];
        let partial: Omit<Exchange, "response"> | null = null;
        try {
            const isRequest = isInstance(input, "Request");
            const url = resolveUrl(isRequest ? (input as Request).url : String(input));
            const method = String(init?.method ?? (isRequest ? (input as Request).method : "GET")).toUpperCase();
            targets = url ? interested(url, method) : [];
            if (url && targets.length) {
                const headers = init?.headers ?? (isRequest ? (input as Request).headers : undefined);
                partial = { url, method, sequence: nextSequence(), headers: safeHeaders(headers), body: fetchBody(input, init) };
            }
        } catch {}
        const result = Reflect.apply(nativeFetch, this, arguments) as Promise<Response>;
        if (partial) {
            const response = Promise.resolve(result).then(wrapFetchResponse, () => null);
            dispatch(targets, { ...partial, response });
        }
        return result;
    }
    try {
        pageWindow.fetch = fetch as typeof pageWindow.fetch;
    } catch (error) {
        logger.warn("fetch hook unavailable:", error);
    }
}

function installXhr() {
    const proto = pageWindow.XMLHttpRequest?.prototype;
    if (!proto) return;
    const { open, send, setRequestHeader } = proto;
    const meta = new WeakMap<XMLHttpRequest, { url: URL | null; method: string; headers: Record<string, string> }>();
    proto.open = function (this: XMLHttpRequest, method: string, url: string | URL) {
        meta.set(this, { url: resolveUrl(String(url)), method: String(method || "GET").toUpperCase(), headers: {} });
        return Reflect.apply(open, this, arguments);
    } as typeof proto.open;
    proto.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
        const record = meta.get(this);
        const lower = String(name).toLowerCase();
        if (record && (SAFE_HEADERS as readonly string[]).includes(lower)) record.headers[lower] = String(value);
        return Reflect.apply(setRequestHeader, this, arguments);
    };
    proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
        const record = meta.get(this);
        const targets = record?.url ? interested(record.url, record.method) : [];
        if (record?.url && targets.length) {
            const xhr = this;
            const response = new Promise<ObservedResponse | null>(resolve => {
                xhr.addEventListener("loadend", () => resolve({
                    ok: xhr.status >= 200 && xhr.status < 300,
                    status: xhr.status,
                    async text() {
                        if (xhr.responseType === "json") return JSON.stringify(xhr.response);
                        if (xhr.responseType && xhr.responseType !== "text") return "";
                        if (xhr.responseText.length > MAX_BODY_CHARS) throw new Error("response-too-large");
                        return xhr.responseText;
                    },
                }), { once: true });
            });
            dispatch(targets, {
                url: record.url,
                method: record.method,
                sequence: nextSequence(),
                headers: safeHeaders(record.headers),
                body: Promise.resolve(typeof body === "string" ? body : ""),
                response,
            });
        }
        return Reflect.apply(send, this, arguments);
    };
}

export function installHooks() {
    if (installed) return;
    installed = true;
    installFetch();
    try {
        installXhr();
    } catch (error) {
        logger.warn("XHR hook unavailable:", error);
    }
}

export function nativeFetch(): typeof fetch {
    return original ?? pageWindow.fetch.bind(pageWindow);
}
