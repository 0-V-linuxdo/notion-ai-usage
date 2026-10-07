/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

export type Role = "user" | "assistant";

export interface ChatMessage {
    id: string;
    role: Role;
    element: HTMLElement;
    text: string;
}

export const USER_STEP = "data-agent-chat-user-step-id";
const LEAF = "[data-content-editable-leaf]";
const TOGGLE = "[role='button'][aria-expanded]";
const COPY_ASSISTANT = /\bcopy\s+(?:response|answer)\b|复制(?:回复|回答|响应)/i;
const COPY_USER = /\bcopy\s+(?:text|message|prompt)\b|复制(?:文本|消息|提示词|问题)/i;
const MONTHS = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|January|February|March|April|June|July|August|September|October|November|December";
const DATE_RE = new RegExp(`^(?:Today|Yesterday|(?:${MONTHS})\\s+\\d{1,2}(?:,\\s*\\d{4})?(?:\\s+at\\s+\\d{1,2}:\\d{2}\\s*(?:AM|PM)?)?|\\d{1,2}:\\d{2}\\s*(?:AM|PM)?|\\d{4}[-/年]\\d{1,2}[-/月]\\d{1,2}日?(?:\\s+\\d{1,2}:\\d{2})?|\\d{1,2}月\\d{1,2}日(?:\\s+\\d{1,2}:\\d{2})?|今天|昨天)$`, "i");
const NOISE_RE = /^(?:\d+\s*steps?|thought(?:\s+for\s+.*)?|思考.*|noodling|contemplating|thinking|found\s+\d+\s+results?|searched the web|searching the web|loaded .*(?:skill|tools?)|loading web page:.*|updated to-dos|copy(?: text| response)?|undo|show changes|response copied to clipboard|copied to clipboard)$/i;

export function cleanLines(raw: string): string[] {
    return raw
        .split(/\n+/)
        .map(line => line.replace(/\s+/g, " ").trim())
        .filter(line => line && !DATE_RE.test(line) && !NOISE_RE.test(line));
}

export const isDateText = (text: string) => DATE_RE.test(text.replace(/\s+/g, " ").trim());

function readText(element: Element, skip: Element[] = []): string {
    if (!skip.length) return cleanLines((element as HTMLElement).innerText ?? element.textContent ?? "").join("\n");
    const parts: string[] = [];
    for (const child of element.children) {
        if (skip.some(node => node === child || node.contains(child))) continue;
        if (skip.some(node => child.contains(node))) parts.push(readText(child, skip));
        else parts.push((child as HTMLElement).innerText ?? child.textContent ?? "");
    }
    return cleanLines(parts.join("\n")).join("\n");
}

function turnOf(step: Element): Element {
    let turn = step;
    while (turn.parentElement && turn.parentElement !== document.body && turn.parentElement.querySelectorAll(`[${USER_STEP}]`).length === 1) {
        turn = turn.parentElement;
    }
    return turn;
}

function userBubble(step: HTMLElement): HTMLElement {
    const leaf = step.querySelector<HTMLElement>(LEAF);
    if (!leaf) return step;
    let node: HTMLElement = leaf;
    while (node.parentElement && node.parentElement !== step && !node.parentElement.querySelector("button, [role='button']")) {
        node = node.parentElement;
    }
    return node;
}

function userText(step: Element): string {
    const leaves = [...step.querySelectorAll(LEAF)].map(leaf => leaf.textContent?.trim() ?? "").filter(Boolean);
    return leaves.length ? leaves.join("\n") : readText(step);
}

function assistantBody(turn: HTMLElement): HTMLElement {
    const toggles = turn.querySelectorAll(TOGGLE);
    const column = toggles.length ? toggles[toggles.length - 1].parentElement?.parentElement : null;
    if (column && turn.contains(column)) {
        const bodies = [...column.children].filter((child): child is HTMLElement =>
            child instanceof HTMLElement && !child.querySelector(TOGGLE) && !child.matches(TOGGLE) && readText(child).length > 1);
        if (bodies.length) return bodies[bodies.length - 1];
    }
    return turn;
}

function regionsOf(turn: Element): Element[] {
    return [...turn.querySelectorAll(TOGGLE)]
        .map(toggle => toggle.getAttribute("aria-controls"))
        .map(id => id ? document.getElementById(id) : null)
        .filter((node): node is HTMLElement => !!node && turn.contains(node));
}

function fromUserSteps(root: ParentNode): ChatMessage[] {
    const steps = [...root.querySelectorAll<HTMLElement>(`[${USER_STEP}]`)].filter(step => !step.parentElement?.closest(`[${USER_STEP}]`));
    if (!steps.length) return [];
    const turns = steps.map(turnOf);
    const turnSet = new Set(turns);
    const messages: ChatMessage[] = [];
    turns.forEach((turn, index) => {
        const step = steps[index];
        const id = step.getAttribute(USER_STEP) || `user-${index}`;
        messages.push({ id, role: "user", element: userBubble(step), text: userText(step) });
        for (let sibling = turn.nextElementSibling; sibling && !turnSet.has(sibling); sibling = sibling.nextElementSibling) {
            if (!(sibling instanceof HTMLElement)) continue;
            const body = assistantBody(sibling);
            const bodyText = readText(body, body === sibling ? regionsOf(sibling) : []);
            const text = bodyText || readText(sibling, regionsOf(sibling));
            if (!text) continue;
            messages.push({ id: `${id}:assistant`, role: "assistant", element: body, text });
            break;
        }
    });
    return messages;
}

function copyRole(button: Element): Role | null {
    const label = [button.getAttribute("aria-label"), button.getAttribute("title"), button.getAttribute("data-testid")].filter(Boolean).join(" ");
    if (COPY_ASSISTANT.test(label)) return "assistant";
    if (COPY_USER.test(label)) return "user";
    return null;
}

function fromCopyButtons(root: ParentNode): ChatMessage[] {
    const messages: ChatMessage[] = [];
    const seen = new Set<Element>();
    root.querySelectorAll("button, [role='button']").forEach((button, index) => {
        if (button.closest("nav, aside, header, footer, form, pre, code")) return;
        const role = copyRole(button);
        if (!role) return;
        let target: HTMLElement | null = null;
        if (role === "user") {
            for (let node: Element | null = button; node && !target; node = node.parentElement) {
                const prev = node.previousElementSibling;
                if (prev instanceof HTMLElement && !prev.contains(button) && !prev.querySelector("button, [role='button']")) {
                    const text = readText(prev);
                    if (text.length >= 2 && !isDateText(text)) target = prev;
                }
                if (node === document.body) break;
            }
        } else {
            for (let node = button.parentElement; node && node !== document.body && !target; node = node.parentElement) {
                const content = [...node.children].find(child => !child.contains(button));
                if (!(content instanceof HTMLElement)) continue;
                const parts = [...content.children].filter((child): child is HTMLElement => child instanceof HTMLElement && readText(child).length >= 8);
                const body = parts[parts.length - 1];
                if (body && ![...body.querySelectorAll("button, [role='button']")].some(copyRole)) target = body;
            }
        }
        if (!target || seen.has(target)) return;
        seen.add(target);
        const text = readText(target);
        if (text) messages.push({ id: `copy-${role}-${index}`, role, element: target, text });
    });
    return messages.sort((a, b) => a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
}

export function collectMessages(root: ParentNode = document): ChatMessage[] {
    const primary = fromUserSteps(root);
    return primary.length ? primary : fromCopyButtons(root);
}

export function summarize(text: string, max = 60): string {
    const line = text.replace(/\s+/g, " ").trim();
    return line.length > max ? `${line.slice(0, max)}…` : line;
}
