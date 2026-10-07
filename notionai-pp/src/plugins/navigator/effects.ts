/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { reducedMotion } from "@utils/dom";

export type Effect = "none" | "border" | "pulse" | "fade" | "jiggle";

export const EFFECTS: { value: Effect; zh: string; en: string }[] = [
    { value: "border", zh: "高亮边框", en: "Highlight border" },
    { value: "pulse", zh: "脉冲光晕", en: "Pulse glow" },
    { value: "fade", zh: "背景淡入淡出", en: "Background fade" },
    { value: "jiggle", zh: "水平抖动", en: "Jiggle" },
    { value: "none", zh: "无（仅滚动）", en: "None (scroll only)" },
];

const running = new WeakMap<Element, Animation>();

const KEYFRAMES: Record<Exclude<Effect, "none">, { frames: Keyframe[]; duration: number }> = {
    border: {
        frames: [
            { outline: "2px solid rgba(255,196,0,.95)", outlineOffset: "4px", boxShadow: "0 0 0 0 rgba(255,196,0,.45)" },
            { outline: "2px solid rgba(255,196,0,.95)", outlineOffset: "4px", boxShadow: "0 0 0 12px rgba(255,196,0,0)", offset: 0.6 },
            { outline: "2px solid rgba(255,196,0,0)", outlineOffset: "4px", boxShadow: "0 0 0 12px rgba(255,196,0,0)" },
        ],
        duration: 2000,
    },
    pulse: {
        frames: [
            { boxShadow: "0 0 0 0 rgba(59,130,246,.7)" },
            { boxShadow: "0 0 0 15px rgba(59,130,246,0)", offset: 0.5 },
            { boxShadow: "0 0 0 0 rgba(59,130,246,0)" },
        ],
        duration: 2000,
    },
    fade: {
        frames: [
            { backgroundColor: "rgba(59,130,246,0)" },
            { backgroundColor: "rgba(59,130,246,.28)", offset: 0.5 },
            { backgroundColor: "rgba(59,130,246,0)" },
        ],
        duration: 1500,
    },
    jiggle: {
        frames: [0, -3, 3, -3, 3, -3, 3, -3, 3, 0].map(x => ({ transform: `translateX(${x}px)` })),
        duration: 400,
    },
};

export function playEffect(element: Element, effect: Effect) {
    if (effect === "none" || typeof element.animate !== "function") return;
    running.get(element)?.cancel();
    const { frames, duration } = KEYFRAMES[effect];
    const reduced = reducedMotion();
    const animation = element.animate(effect === "jiggle" && reduced ? KEYFRAMES.fade.frames : frames, {
        duration: reduced ? Math.min(duration, 1000) : duration,
        easing: "ease-in-out",
    });
    running.set(element, animation);
}
