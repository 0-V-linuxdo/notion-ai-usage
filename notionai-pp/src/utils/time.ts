/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

export function debounce<A extends unknown[]>(fn: (...args: A) => void, wait: number, maxWait = Infinity) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let firstAt = 0;
    const run = (...args: A) => {
        clearTimeout(timer);
        const now = Date.now();
        if (!firstAt) firstAt = now;
        const delay = Math.max(0, Math.min(wait, firstAt + maxWait - now));
        timer = setTimeout(() => {
            firstAt = 0;
            fn(...args);
        }, delay);
    };
    run.cancel = () => {
        clearTimeout(timer);
        firstAt = 0;
    };
    return run;
}

export function frameThrottle(fn: () => void) {
    let pending = false;
    return () => {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => {
            pending = false;
            fn();
        });
    };
}
