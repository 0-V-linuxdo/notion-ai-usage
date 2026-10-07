/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { installHooks } from "@api/Network";
import { registerPlugins, StartAt, startPlugins } from "@api/PluginManager";
import { reloadFromStorage, SETTINGS_KEY } from "@api/Settings";
import { Logger } from "@utils/Logger";
import { isTopmostNotionDocument, pageWindow } from "@utils/page";

import autoCollapseThinking from "@plugins/autoCollapseThinking/index";
import chatNavigator from "@plugins/navigator/index";
import settings from "@plugins/settings/index";
import usageMeter from "@plugins/usage/index";

declare const VERSION: string;

const FLAG = "__notionAiPlusPlus";
const logger = new Logger("Core");

function boot() {
    const win = pageWindow as unknown as Record<string, unknown>;
    if (win[FLAG] || !isTopmostNotionDocument()) return;
    win[FLAG] = typeof VERSION === "string" ? VERSION : true;
    installHooks();
    registerPlugins([settings, usageMeter, chatNavigator, autoCollapseThinking]);
    startPlugins(StartAt.DocumentStart);
    const ready = () => startPlugins(StartAt.DomReady);
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready, { once: true });
    else ready();
    pageWindow.addEventListener("storage", event => event.key === SETTINGS_KEY && reloadFromStorage(event.newValue));
    logger.info(`NotionAI++ ${typeof VERSION === "string" ? VERSION : ""} started`);
}

boot();
