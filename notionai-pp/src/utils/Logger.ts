/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

type Level = "log" | "info" | "warn" | "error" | "debug";

const CAP = "color:#fff;background:#2f2f2f;font-weight:700;padding:1px 6px;border-radius:6px 0 0 6px;";
const BODY = "background:#ededeb;color:#37352f;font-weight:600;padding:1px 6px;border-radius:0 6px 6px 0;";

export class Logger {
    constructor(public name: string) {}

    private emit(level: Level, args: unknown[]) {
        try {
            console[level](`%cNotionAI++%c${this.name}`, CAP, BODY, ...args);
        } catch {}
    }

    log(...args: unknown[]) { this.emit("log", args); }
    info(...args: unknown[]) { this.emit("info", args); }
    warn(...args: unknown[]) { this.emit("warn", args); }
    error(...args: unknown[]) { this.emit("error", args); }
    debug(...args: unknown[]) { this.emit("debug", args); }
}
