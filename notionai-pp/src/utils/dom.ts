/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

export interface Box {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
}

export function boxOf(el: Element): Box {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
}

export const sameBox = (a: Box | null, b: Box | null, tolerance = 0.5) =>
    !!a && !!b &&
    Math.abs(a.left - b.left) <= tolerance &&
    Math.abs(a.top - b.top) <= tolerance &&
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance;

export function viewport() {
    const doc = document.documentElement;
    return { width: window.innerWidth || doc?.clientWidth || 0, height: window.innerHeight || doc?.clientHeight || 0 };
}

export function visibleBox(el: Element | null | undefined): Box | null {
    if (!el || !el.isConnected) return null;
    if (el.closest("[aria-hidden='true'], [inert]")) return null;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) <= 0.02) return null;
    const box = boxOf(el);
    if (box.width <= 0 || box.height <= 0) return null;
    const vp = viewport();
    if (box.right <= 0 || box.bottom <= 0 || box.left >= vp.width || box.top >= vp.height) return null;
    return box;
}

export function scrollParentOf(el: Element): HTMLElement {
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
        const { overflowY } = getComputedStyle(node);
        if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return node;
    }
    return (document.scrollingElement as HTMLElement) ?? document.documentElement;
}

export const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

export function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    props: Partial<Record<string, string>> = {},
    ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value === undefined) continue;
        if (key === "class") node.className = value;
        else if (key === "text") node.textContent = value;
        else node.setAttribute(key, value);
    }
    node.append(...children);
    return node;
}
