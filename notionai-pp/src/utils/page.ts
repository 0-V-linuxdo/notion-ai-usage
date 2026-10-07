/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

declare const unsafeWindow: (Window & typeof globalThis) | undefined;

export const pageWindow: Window & typeof globalThis =
    typeof unsafeWindow !== "undefined" && unsafeWindow ? unsafeWindow : window;

const NOTION_HOSTS = new Set(["app.notion.com", "www.notion.so", "notion.so"]);

export function isNotionUrl(value: unknown): boolean {
    try {
        const url = new URL(String(value));
        return url.protocol === "https:" && NOTION_HOSTS.has(url.hostname);
    } catch {
        return false;
    }
}

export function isTopmostNotionDocument(win: Window = pageWindow): boolean {
    if (!isNotionUrl(win.location.href)) return false;
    const ancestors = win.location.ancestorOrigins;
    if (ancestors) {
        for (let index = 0; index < ancestors.length; index++) {
            if (isNotionUrl(ancestors[index])) return false;
        }
    }
    let current: Window = win;
    for (let depth = 0; depth < 32; depth++) {
        let parent: Window;
        try {
            parent = current.parent;
        } catch {
            return true;
        }
        if (!parent || parent === current) return true;
        try {
            if (isNotionUrl(parent.location.href)) return false;
        } catch {
            return true;
        }
        current = parent;
    }
    return true;
}

export const isAiRoute = (pathname = pageWindow.location.pathname) => /^\/(?:ai|chat)(?:\/|$)/i.test(pathname);

export function uiLanguage(): "zh" | "en" {
    return /^zh(?:-|$)/i.test(document.documentElement?.lang ?? "") ? "zh" : "en";
}

export const t = (zh: string, en: string) => (uiLanguage() === "zh" ? zh : en);

export function trustedHtml(html: string): string {
    const policy = (globalThis as any).ADG_policyApi;
    try {
        if (policy && typeof policy.createHTML === "function") return policy.createHTML(html);
    } catch {}
    return html;
}
