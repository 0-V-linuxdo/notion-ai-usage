/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { pageWindow } from "@utils/page";

export interface RouteChange {
    href: string;
    previous: string;
}

type Listener = (change: RouteChange) => void;

const listeners = new Set<Listener>();
const POLL_MS = 1000;
let last = "";
let installed = false;

function check() {
    const href = pageWindow.location.href;
    if (href === last) return;
    const change = { href, previous: last };
    last = href;
    for (const listener of [...listeners]) {
        try {
            listener(change);
        } catch {}
    }
}

function install() {
    if (installed) return;
    installed = true;
    last = pageWindow.location.href;
    const schedule = () => queueMicrotask(check);
    const nav = (pageWindow as any).navigation;
    if (nav && typeof nav.addEventListener === "function") {
        nav.addEventListener("navigatesuccess", schedule);
        nav.addEventListener("currententrychange", schedule);
    }
    for (const method of ["pushState", "replaceState"] as const) {
        const native = pageWindow.history[method];
        pageWindow.history[method] = function (this: History) {
            const result = Reflect.apply(native, this, arguments);
            schedule();
            return result;
        } as typeof native;
    }
    pageWindow.addEventListener("popstate", schedule);
    pageWindow.addEventListener("hashchange", schedule);
    setInterval(check, POLL_MS);
}

export function onRouteChange(listener: Listener) {
    install();
    listeners.add(listener);
    return () => void listeners.delete(listener);
}
