/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

export function debounce<A extends unknown[]>(fn: (...args: A) => void, wait: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = (...args: A) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), wait);
    };
    run.cancel = () => clearTimeout(timer);
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
