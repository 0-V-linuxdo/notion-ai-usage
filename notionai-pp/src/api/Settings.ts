/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { isRecord, safeJson } from "@utils/guards";
import { Logger } from "@utils/Logger";

const logger = new Logger("Settings");

export const SETTINGS_KEY = "notionai-pp:settings:v1";

export type OptionValue = string | number | boolean;

export interface BooleanOption {
    type: "boolean";
    label: string;
    description?: string;
    default: boolean;
}

export interface SelectOption {
    type: "select";
    label: string;
    description?: string;
    default: string;
    options: { value: string; label: string }[];
}

export interface ColorOption {
    type: "color";
    label: string;
    description?: string;
    /** #rrggbb */
    default: string;
}

export type OptionDef = BooleanOption | SelectOption | ColorOption;

export const isHexColor = (value: unknown): value is string => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);

export type OptionsDef = Record<string, OptionDef>;

export type OptionValues<D extends OptionsDef> = {
    [K in keyof D]: D[K] extends BooleanOption ? boolean : string;
};

type Bag = Record<string, Record<string, OptionValue>>;

type Listener = (plugin: string, key: string) => void;

const listeners = new Set<Listener>();

function read(): Bag {
    try {
        const parsed = safeJson(localStorage.getItem(SETTINGS_KEY) ?? "");
        return isRecord(parsed) ? (parsed as Bag) : {};
    } catch {
        return {};
    }
}

let bag: Bag = read();

function persist() {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(bag));
    } catch (error) {
        logger.warn("Settings could not be saved:", error);
    }
}

export function getValue(plugin: string, key: string): OptionValue | undefined {
    return bag[plugin]?.[key];
}

export function setValue(plugin: string, key: string, value: OptionValue) {
    if (bag[plugin]?.[key] === value) return;
    bag = { ...bag, [plugin]: { ...bag[plugin], [key]: value } };
    persist();
    for (const listener of [...listeners]) {
        try {
            listener(plugin, key);
        } catch (error) {
            logger.error("Settings listener failed:", error);
        }
    }
}

export function onSettingsChange(listener: Listener) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
}

export function reloadFromStorage(raw: string | null) {
    const parsed = safeJson(raw ?? "");
    bag = isRecord(parsed) ? (parsed as Bag) : {};
    for (const listener of [...listeners]) listener("*", "*");
}

export interface PluginSettings<D extends OptionsDef> {
    def: D;
    store: OptionValues<D>;
    bind(plugin: string): void;
}

export function definePluginSettings<D extends OptionsDef>(def: D): PluginSettings<D> {
    let owner = "";
    const store = new Proxy({} as OptionValues<D>, {
        get: (_, key: string) => {
            const option = def[key];
            if (!option) return undefined;
            const value = getValue(owner, key);
            if (option.type === "boolean") return typeof value === "boolean" ? value : option.default;
            if (option.type === "color") return isHexColor(value) ? value.toLowerCase() : option.default;
            return typeof value === "string" && option.options.some(o => o.value === value) ? value : option.default;
        },
        set: (_, key: string, value: OptionValue) => {
            setValue(owner, key, value);
            return true;
        },
    });
    return { def, store, bind: (plugin: string) => void (owner = plugin) };
}
