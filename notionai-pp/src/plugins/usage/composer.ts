/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { onDomChange } from "@api/DomWatch";
import { onRouteChange } from "@api/Router";
import { type Box, sameBox, viewport, visibleBox } from "@utils/dom";

export const CONTAINER_SELECTOR = "[data-notion-chat-input-container]";
const EDITOR_SELECTOR = "[role='textbox'][contenteditable='true'], [role='textbox'][contenteditable='plaintext-only'], textarea, [contenteditable='true']";
const SEMANTIC_RE = /notion\s*ai|do anything with ai|ask\s+(?:notion\s+)?ai|ask anything|(?:用|向|让|问)\s*(?:notion\s*)?ai|ai\s*(?:助手|输入|对话|提问)/i;
const SURFACE_MIN_RADIUS = 8;
const MAX_CLIMB = 10;
const IDLE_RESCAN_MS = 500;

export interface ComposerMatch {
    editor: Element;
    surface: Element;
}

function hasSurface(node: Element) {
    const style = getComputedStyle(node);
    if ((parseFloat(style.borderTopLeftRadius) || 0) < SURFACE_MIN_RADIUS) return false;
    const background = style.backgroundColor.replace(/\s+/g, "");
    const painted = background !== "" && background !== "transparent" && background !== "rgba(0,0,0,0)";
    return painted || (style.boxShadow !== "" && style.boxShadow !== "none") || (parseFloat(style.borderTopWidth) || 0) > 0;
}

export function surfaceFor(editor: Element, limit: Element | null): Element {
    let best: Element | null = null;
    let node: Element | null = editor;
    for (let depth = 0; node && depth < MAX_CLIMB; depth++, node = node.parentElement) {
        if (node === document.body) break;
        if (hasSurface(node)) best = node;
        if (node === limit) break;
    }
    return best ?? limit ?? editor;
}

const editorText = (editor: Element) =>
    ["placeholder", "aria-placeholder", "data-placeholder", "aria-label"].map(name => editor.getAttribute(name) ?? "").join(" ");

function rank(match: ComposerMatch, box: Box): number {
    const active = document.activeElement;
    let score = box.bottom / Math.max(1, viewport().height) * 10 + box.width / Math.max(1, viewport().width) * 4;
    if (active && (match.editor === active || match.editor.contains(active) || match.surface.contains(active))) score += 100;
    return score;
}

function fromContainers(): ComposerMatch[] {
    const found: ComposerMatch[] = [];
    for (const container of document.querySelectorAll(CONTAINER_SELECTOR)) {
        const editor = container.querySelector(EDITOR_SELECTOR);
        if (!editor || !visibleBox(editor)) continue;
        found.push({ editor, surface: surfaceFor(editor, container) });
    }
    return found;
}

function fromHeuristics(): ComposerMatch[] {
    const found: ComposerMatch[] = [];
    for (const editor of document.querySelectorAll(EDITOR_SELECTOR)) {
        if (!SEMANTIC_RE.test(editorText(editor))) continue;
        const box = visibleBox(editor);
        if (!box || box.width < 180) continue;
        found.push({ editor, surface: surfaceFor(editor, null) });
    }
    return found;
}

export function locateComposer(): (ComposerMatch & { box: Box }) | null {
    const candidates = fromContainers();
    const pool = candidates.length ? candidates : fromHeuristics();
    let best: (ComposerMatch & { box: Box; score: number }) | null = null;
    for (const match of pool) {
        const box = visibleBox(match.surface);
        if (!box) continue;
        const score = rank(match, box);
        if (!best || score > best.score) best = { ...match, box, score };
    }
    return best;
}

export class ComposerTracker {
    private frame = 0;
    private match: ComposerMatch | null = null;
    private box: Box | null = null;
    private dirty = true;
    private lastScan = 0;
    private cleanups: (() => void)[] = [];

    constructor(private readonly onChange: (box: Box | null) => void) {}

    start() {
        if (this.frame) return;
        const markDirty = () => void (this.dirty = true);
        this.cleanups = [
            onDomChange(markDirty),
            onRouteChange(markDirty),
        ];
        for (const type of ["focusin", "resize"] as const) {
            window.addEventListener(type, markDirty, { capture: true, passive: true });
            this.cleanups.push(() => window.removeEventListener(type, markDirty, { capture: true }));
        }
        this.dirty = true;
        this.tick();
    }

    stop() {
        cancelAnimationFrame(this.frame);
        this.frame = 0;
        for (const cleanup of this.cleanups) cleanup();
        this.cleanups = [];
        this.match = null;
        this.box = null;
    }

    get current() {
        return this.box;
    }

    private tick = () => {
        this.frame = requestAnimationFrame(this.tick);
        if (document.hidden) return;
        const now = performance.now();
        let box = this.match ? visibleBox(this.match.surface) : null;
        const shouldScan = this.dirty || (!box && now - this.lastScan >= IDLE_RESCAN_MS);
        if (shouldScan) {
            this.dirty = false;
            this.lastScan = now;
            const next = locateComposer();
            this.match = next;
            box = next?.box ?? null;
        }
        if (sameBox(box, this.box) || (!box && !this.box)) return;
        this.box = box;
        this.onChange(box);
    };
}
