/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

/*
 * The Notion AI home (/ai) shows the AI face (a role=button "Open personalization
 * settings" that can wear an accessory) above a greeting line whose wording
 * changes with Notion's theme ("Where are we off to first?", "How can I help you
 * today?", ...). Neither carries a stable class, so we find the face and take the
 * nearest sibling branch that holds plain text and no controls. The old default
 * wording is a fallback for when the face is missing.
 */

export const TARGET_ATTR = "data-npp-greeting";
export const TARGET_SELECTOR = `[${TARGET_ATTR}="1"]`;

const ORIGINAL_GREETING = "How can I help you today?";
const FACE = "img[alt='Notion AI face'], [role='img'][aria-label='Notion AI face']";
const CONTROL = "button, [role='button']";
const INTERACTIVE = "button, a, input, textarea, select, [contenteditable='true'], [role='button'], [role='textbox']";
const MAX_DEPTH = 6;

export const isHomePath = (pathname = location.pathname) => /^\/ai\/?$/.test(pathname);

const normalize = (text: string | null | undefined) => String(text ?? "").replace(/\s+/g, " ").trim();

function textSibling(container: Element, branch: Element): Element | null {
    const children = [...container.children];
    const at = children.indexOf(branch);
    const candidates = children.filter(child =>
        child !== branch &&
        normalize(child.textContent) &&
        !child.matches(INTERACTIVE) &&
        !child.querySelector(INTERACTIVE));
    return candidates.find(child => children.indexOf(child) > at) ?? candidates[0] ?? null;
}

function fromFace(scope: Element): Element | null {
    for (const face of scope.querySelectorAll(FACE)) {
        const control = face.closest(CONTROL);
        if (!control) continue;
        let container = control.parentElement;
        for (let depth = 0; container && depth < MAX_DEPTH; depth++) {
            if (container !== scope && !scope.contains(container)) break;
            const branch = [...container.children].find(child => child === control || child.contains(control));
            const target = branch && textSibling(container, branch);
            if (target) return target;
            if (container === scope) break;
            container = container.parentElement;
        }
    }
    return null;
}

function fromOriginalText(scope: Element): Element | null {
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (normalize(node.nodeValue) !== ORIGINAL_GREETING) continue;
        let target: Element | null = node.parentElement;
        while (target?.parentElement && target !== scope) {
            const parent: Element = target.parentElement;
            if (normalize(parent.textContent) !== ORIGINAL_GREETING || parent.querySelector("button")) break;
            target = parent;
        }
        return target;
    }
    return null;
}

export function findGreeting(scope: Element | null = document.body): Element | null {
    if (!scope) return null;
    return fromFace(scope) ?? fromOriginalText(scope);
}

export function clearMarks(except: Element | null = null) {
    for (const el of document.querySelectorAll(TARGET_SELECTOR)) {
        if (el !== except) el.removeAttribute(TARGET_ATTR);
    }
}

/** Marks the greeting on the home page (and only there); returns it. */
export function syncMark(): Element | null {
    if (!isHomePath()) {
        clearMarks();
        return null;
    }
    const target = findGreeting();
    clearMarks(target);
    if (target && target.getAttribute(TARGET_ATTR) !== "1") target.setAttribute(TARGET_ATTR, "1");
    return target;
}
