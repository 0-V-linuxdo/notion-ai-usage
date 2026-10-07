/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

export type Theme = "light" | "dark";

const DARK_RE = /(?:^|[\s_-])dark(?:$|[\s_-])/i;
const LIGHT_RE = /(?:^|[\s_-])light(?:$|[\s_-])/i;
const RGB_RE = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i;

export function colorTheme(value: string): Theme | null {
    const match = RGB_RE.exec(value);
    if (!match) return null;
    const alpha = match[4] === undefined ? 1 : Number(match[4]);
    if (!(alpha >= 0.35)) return null;
    const luminance = (0.2126 * Number(match[1]) + 0.7152 * Number(match[2]) + 0.0722 * Number(match[3])) / 255;
    return luminance < 0.52 ? "dark" : "light";
}

export function currentTheme(): Theme {
    const { documentElement: html, body } = document;
    const marker = [html, body]
        .flatMap(node => node ? [node.className, node.getAttribute("data-theme"), node.getAttribute("data-mode")] : [])
        .filter((value): value is string => typeof value === "string")
        .join(" ");
    if (DARK_RE.test(marker)) return "dark";
    if (LIGHT_RE.test(marker)) return "light";
    const inner = document.querySelector(".notion-app-inner");
    if (inner?.classList.contains("notion-dark-theme")) return "dark";
    if (inner?.classList.contains("notion-light-theme")) return "light";
    for (const node of [document.getElementById("notion-app"), inner, body, html]) {
        if (!node) continue;
        const theme = colorTheme(getComputedStyle(node).backgroundColor);
        if (theme) return theme;
    }
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

type Listener = (theme: Theme) => void;

const listeners = new Set<Listener>();
let observer: MutationObserver | null = null;
let last: Theme | null = null;

function notify() {
    const theme = currentTheme();
    if (theme === last) return;
    last = theme;
    for (const listener of [...listeners]) listener(theme);
}

export function onThemeChange(listener: Listener) {
    listeners.add(listener);
    if (!observer) {
        observer = new MutationObserver(notify);
        const options = { attributes: true, subtree: false, attributeFilter: ["class", "data-theme", "data-mode", "lang"] };
        observer.observe(document.documentElement, options);
        if (document.body) observer.observe(document.body, options);
        const inner = document.querySelector(".notion-app-inner");
        if (inner) observer.observe(inner, options);
        window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", notify);
    }
    last = null;
    queueMicrotask(notify);
    return () => {
        listeners.delete(listener);
        if (!listeners.size) {
            observer?.disconnect();
            observer = null;
        }
    };
}
