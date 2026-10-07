/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

type Listener = (mutations: MutationRecord[]) => void;

const listeners = new Set<Listener>();
let observer: MutationObserver | null = null;
let queue: MutationRecord[] = [];
let scheduled = false;

function flush() {
    scheduled = false;
    const batch = queue;
    queue = [];
    for (const listener of [...listeners]) {
        try {
            listener(batch);
        } catch {}
    }
}

function ensureObserver() {
    if (observer || !document.documentElement) return;
    observer = new MutationObserver(records => {
        queue.push(...records);
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(flush);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
}

export function onDomChange(listener: Listener) {
    ensureObserver();
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
        if (!listeners.size && observer) {
            observer.disconnect();
            observer = null;
            queue = [];
        }
    };
}
