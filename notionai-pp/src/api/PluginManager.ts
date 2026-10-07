/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { getValue, onSettingsChange, type OptionsDef, type PluginSettings, setValue } from "@api/Settings";
import { Logger } from "@utils/Logger";

const logger = new Logger("PluginManager");

export const enum StartAt {
    DocumentStart = "DocumentStart",
    DomReady = "DomReady",
}

export interface PluginDef {
    name: string;
    title: string;
    description: string;
    enabledByDefault: boolean;
    required?: boolean;
    startAt?: StartAt;
    settings?: PluginSettings<OptionsDef>;
    start(): void;
    stop(): void;
    onSettingsChange?(key: string): void;
}

export interface Plugin extends PluginDef {
    started: boolean;
}

export const definePlugin = (def: PluginDef): Plugin => ({ ...def, started: false });

const plugins = new Map<string, Plugin>();

export const allPlugins = () => [...plugins.values()];

export function isEnabled(plugin: Plugin) {
    if (plugin.required) return true;
    const value = getValue(plugin.name, "enabled");
    return typeof value === "boolean" ? value : plugin.enabledByDefault;
}

function startPlugin(plugin: Plugin) {
    if (plugin.started) return;
    try {
        plugin.start();
        plugin.started = true;
    } catch (error) {
        logger.error(`${plugin.name} failed to start:`, error);
    }
}

function stopPlugin(plugin: Plugin) {
    if (!plugin.started) return;
    plugin.started = false;
    try {
        plugin.stop();
    } catch (error) {
        logger.error(`${plugin.name} failed to stop:`, error);
    }
}

export function setEnabled(plugin: Plugin, enabled: boolean) {
    setValue(plugin.name, "enabled", enabled);
}

export function registerPlugins(list: Plugin[]) {
    for (const plugin of list) {
        plugin.settings?.bind(plugin.name);
        plugins.set(plugin.name, plugin);
    }
}

let phase: StartAt | null = null;

export function startPlugins(at: StartAt) {
    phase = at;
    for (const plugin of plugins.values()) {
        if ((plugin.startAt ?? StartAt.DomReady) !== at && at === StartAt.DocumentStart) continue;
        if (isEnabled(plugin)) startPlugin(plugin);
    }
}

onSettingsChange((name, key) => {
    for (const plugin of plugins.values()) {
        if (name !== "*" && name !== plugin.name) continue;
        const ready = phase === StartAt.DomReady || plugin.startAt === StartAt.DocumentStart;
        if (key === "enabled" || key === "*") {
            if (isEnabled(plugin) && ready) startPlugin(plugin);
            else if (!isEnabled(plugin)) stopPlugin(plugin);
        }
        if (key !== "enabled" && plugin.started) plugin.onSettingsChange?.(key);
    }
});
