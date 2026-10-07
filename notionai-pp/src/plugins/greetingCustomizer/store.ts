/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { getValue, setValue } from "@api/Settings";
import { safeJson } from "@utils/guards";

export const PLUGIN = "GreetingCustomizer";
export const MAX_LEN = 100;
export const MAX_COUNT = 30;

export const DEFAULT_GREETINGS = [
    "Ask not what your country can do for you\n— ask what you can do for your country.",
    "It always seems impossible until it is done.",
    "The best way to predict the future is to create it.",
];

export const normalizeGreeting = (text: string) => text.replace(/\r\n?/g, "\n").trim();

export function validateGreeting(text: string): "empty" | "tooLong" | null {
    const value = normalizeGreeting(text);
    if (!value) return "empty";
    if (value.length > MAX_LEN) return "tooLong";
    return null;
}

/** The greeting list lives beside the plugin's options in the settings bag, as JSON. */
export function loadGreetings(): string[] {
    const raw = getValue(PLUGIN, "greetings");
    const parsed = typeof raw === "string" ? safeJson(raw) : null;
    const list = Array.isArray(parsed)
        ? parsed.filter((s): s is string => typeof s === "string" && !!normalizeGreeting(s)).slice(0, MAX_COUNT)
        : [];
    return list.length ? list : DEFAULT_GREETINGS.slice();
}

export function saveGreetings(list: string[]) {
    const clean = list.map(normalizeGreeting).filter(Boolean).slice(0, MAX_COUNT);
    setValue(PLUGIN, "greetings", JSON.stringify(clean.length ? clean : DEFAULT_GREETINGS));
}

export function loadIndex(): number {
    const raw = getValue(PLUGIN, "index");
    return typeof raw === "number" && Number.isInteger(raw) ? raw : -1;
}

export const saveIndex = (index: number) => setValue(PLUGIN, "index", index);

/** Index to show now; `advance` moves on (sequential wraps, random never repeats the current one). */
export function pickIndex(length: number, order: string, current: number, advance: boolean, random = Math.random): number {
    if (length <= 1) return 0;
    const valid = current >= 0 && current < length;
    if (!advance) return valid ? current : 0;
    if (order === "random") {
        let next = Math.floor(random() * length);
        for (let guard = 0; valid && next === current && guard < 10; guard++) next = Math.floor(random() * length);
        if (valid && next === current) next = (current + 1) % length;
        return next;
    }
    return valid ? (current + 1) % length : 0;
}

export const escapeCssContent = (text: string) =>
    text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\a ");
