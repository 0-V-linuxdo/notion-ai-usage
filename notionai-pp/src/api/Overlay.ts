/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { onDomChange } from "@api/DomWatch";
import { currentTheme, onThemeChange } from "@api/Theme";
import { trustedHtml } from "@utils/page";

export interface Overlay {
    host: HTMLElement;
    root: ShadowRoot;
    destroy(): void;
}

export function createOverlay(id: string, css: string, html: string): Overlay {
    document.getElementById(id)?.remove();
    const host = document.createElement("div");
    host.id = id;
    host.dataset.theme = currentTheme();
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = trustedHtml(`<style>${css}</style>${html}`);
    const mount = () => {
        if (document.body && host.parentNode !== document.body) document.body.appendChild(host);
    };
    mount();
    const stopDom = onDomChange(() => {
        if (!host.isConnected || host.parentNode !== document.body) mount();
    });
    const stopTheme = onThemeChange(theme => void (host.dataset.theme = theme));
    return {
        host,
        root,
        destroy() {
            stopDom();
            stopTheme();
            host.remove();
        },
    };
}
