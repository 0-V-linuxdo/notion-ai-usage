/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

export interface EventMap {
    openSettings: void;
}

type Handler<K extends keyof EventMap> = (payload: EventMap[K]) => void;

const handlers = new Map<keyof EventMap, Set<Handler<any>>>();

export function on<K extends keyof EventMap>(event: K, handler: Handler<K>) {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event)!.add(handler);
    return () => void handlers.get(event)?.delete(handler);
}

export function emit<K extends keyof EventMap>(event: K, payload: EventMap[K]) {
    for (const handler of [...(handlers.get(event) ?? [])]) handler(payload);
}
