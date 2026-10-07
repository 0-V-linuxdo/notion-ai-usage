/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { definePlugin, StartAt } from "@api/PluginManager";

import { UsageService } from "./service";
import { UsageWidget } from "./ui";

let service: UsageService | null = null;
let widget: UsageWidget | null = null;

function mount() {
    if (!service || widget || !document.body) return;
    widget = new UsageWidget(service);
}

export default definePlugin({
    name: "usageMeter",
    title: "AI 用量 / AI usage",
    description: "显示 Notion AI 6 小时与月度用量、套餐与试用状态；最小化后双圆环贴在 AI 输入框底部中央。",
    enabledByDefault: true,
    startAt: StartAt.DocumentStart,
    start() {
        service = new UsageService();
        service.start();
        if (document.body) mount();
        else document.addEventListener("DOMContentLoaded", mount, { once: true });
    },
    stop() {
        document.removeEventListener("DOMContentLoaded", mount);
        widget?.destroy();
        service?.stop();
        widget = null;
        service = null;
    },
});
