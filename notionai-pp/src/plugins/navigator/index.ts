/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { onDomChange } from "@api/DomWatch";
import { createOverlay, type Overlay } from "@api/Overlay";
import { definePlugin } from "@api/PluginManager";
import { onRouteChange } from "@api/Router";
import { definePluginSettings } from "@api/Settings";
import { scrollParentOf } from "@utils/dom";
import { isAiRoute, t } from "@utils/page";
import { debounce, frameThrottle } from "@utils/time";

import { EFFECTS, type Effect, playEffect } from "./effects";
import { type ChatMessage, collectMessages, summarize } from "./messages";
import { NAV_CSS, NAV_HTML } from "./styles";

export const NAV_HOST_ID = "notionai-pp-navigator";
const RESCAN_MS = 250;
const RESCAN_MAX_MS = 1200;
const ACTIVE_RATIO = 0.4;
const SCROLL_OFFSET = 72;
const SETTLE_MS = 150;

export const settings = definePluginSettings({
    showAssistant: { type: "boolean", label: "目录显示 AI 回复 / Show AI replies", default: true },
    effect: {
        type: "select",
        label: "跳转定位效果 / Jump effect",
        default: "border",
        options: EFFECTS.map(effect => ({ value: effect.value, label: `${effect.zh} / ${effect.en}` })),
    },
});

let overlay: Overlay | null = null;
let messages: ChatMessage[] = [];
let signature = "";
let activeId = "";
let cleanups: (() => void)[] = [];

const q = <T extends Element = HTMLElement>(selector: string) => overlay!.root.querySelector(selector) as T;

function visibleMessages(all: ChatMessage[]) {
    return settings.store.showAssistant ? all : all.filter(message => message.role === "user");
}

function build() {
    if (!overlay) return;
    const next = isAiRoute() ? visibleMessages(collectMessages()) : [];
    const nextSignature = next.map(m => `${m.id}\u0001${summarize(m.text)}`).join("\u0002");
    const sameElements = next.length === messages.length && next.every((m, i) => m.element === messages[i].element);
    messages = next;
    overlay.host.hidden = !next.length;
    if (nextSignature === signature) {
        if (!sameElements) updateActive();
        return;
    }
    signature = nextSignature;
    q(".head").textContent = t(`对话目录 · ${next.filter(m => m.role === "user").length} 问`, `Outline · ${next.filter(m => m.role === "user").length} prompts`);
    q(".lines").replaceChildren(...next.map(message => {
        const line = document.createElement("div");
        line.className = "line";
        line.dataset.id = message.id;
        line.dataset.role = message.role;
        return line;
    }));
    q("ul").replaceChildren(...next.map(message => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "item";
        button.dataset.id = message.id;
        button.dataset.role = message.role;
        const mark = document.createElement("span");
        mark.className = "mark";
        mark.textContent = message.role === "user" ? "❓" : "↳";
        const label = document.createElement("span");
        label.className = "label";
        label.textContent = summarize(message.text);
        button.title = summarize(message.text, 400);
        button.append(mark, label);
        button.addEventListener("click", () => jump(message.id));
        const item = document.createElement("li");
        item.append(button);
        return item;
    }));
    activeId = "";
    updateActive();
}

function setActive(id: string) {
    if (!overlay || id === activeId) return;
    activeId = id;
    for (const node of overlay.root.querySelectorAll<HTMLElement>("[data-id]")) node.classList.toggle("active", node.dataset.id === id);
    const lines = q(".lines");
    const rail = q(".rail");
    const line = lines.querySelector<HTMLElement>(".line.active");
    if (!line) return;
    const overflow = lines.scrollHeight - rail.clientHeight;
    const offset = overflow > 0 ? Math.min(overflow, Math.max(0, line.offsetTop - rail.clientHeight / 2)) : 0;
    lines.style.transform = `translateY(${-offset}px)`;
    const item = overlay.root.querySelector<HTMLElement>(`button.item.active`);
    item?.scrollIntoView({ block: "nearest" });
}

function updateActive() {
    if (!messages.length) return;
    const threshold = window.innerHeight * ACTIVE_RATIO;
    let current = messages[0].id;
    for (const message of messages) {
        if (!message.element.isConnected) continue;
        if (message.element.getBoundingClientRect().top < threshold) current = message.id;
        else break;
    }
    setActive(current);
}

function jump(id: string) {
    const message = messages.find(m => m.id === id);
    if (!message?.element.isConnected) return;
    const target = message.element;
    const scroller = scrollParentOf(target);
    const isRoot = scroller === document.scrollingElement || scroller === document.documentElement;
    const top = target.getBoundingClientRect().top - (isRoot ? 0 : scroller.getBoundingClientRect().top) + scroller.scrollTop - SCROLL_OFFSET;
    setActive(id);
    let timer = 0;
    const settle = () => {
        clearTimeout(timer);
        timer = window.setTimeout(() => {
            (isRoot ? window : scroller).removeEventListener("scroll", settle);
            playEffect(target, settings.store.effect as Effect);
        }, SETTLE_MS);
    };
    (isRoot ? window : scroller).addEventListener("scroll", settle, { passive: true });
    scroller.scrollTo({ top, behavior: "smooth" });
    settle();
}

export default definePlugin({
    name: "chatNavigator",
    title: "对话目录 / Chat navigator",
    description: "在 Notion AI 对话右侧显示 Notion 风格目录，悬停展开，点击跳到对应提问或回复。",
    enabledByDefault: true,
    settings,
    start() {
        overlay = createOverlay(NAV_HOST_ID, NAV_CSS, NAV_HTML);
        overlay.host.hidden = true;
        const rescan = debounce(build, RESCAN_MS, RESCAN_MAX_MS);
        const onScroll = frameThrottle(updateActive);
        window.addEventListener("scroll", onScroll, { capture: true, passive: true });
        window.addEventListener("resize", onScroll, { passive: true });
        cleanups = [
            onDomChange(rescan),
            onRouteChange(() => {
                signature = "";
                rescan();
            }),
            () => rescan.cancel(),
            () => window.removeEventListener("scroll", onScroll, { capture: true }),
            () => window.removeEventListener("resize", onScroll),
        ];
        build();
    },
    stop() {
        for (const cleanup of cleanups.splice(0)) cleanup();
        overlay?.destroy();
        overlay = null;
        messages = [];
        signature = "";
        activeId = "";
    },
    onSettingsChange() {
        signature = "";
        build();
    },
});
