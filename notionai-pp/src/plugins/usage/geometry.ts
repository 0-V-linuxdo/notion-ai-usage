/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { clamp, isRecord } from "@utils/guards";
import type { Box } from "@utils/dom";

export const VIEWPORT_INSET = 8;
export const DOCK_BOTTOM_INSET = 7;

export interface Size {
    width: number;
    height: number;
}

export interface Point {
    left: number;
    top: number;
}

export interface Anchor {
    xEdge: "left" | "right";
    xOffset: number;
    yEdge: "top" | "bottom";
    yOffset: number;
}

export function clampPoint(point: Point, viewport: Size, size: Size, inset = VIEWPORT_INSET): Point {
    const maxLeft = Math.max(inset, viewport.width - size.width - inset);
    const maxTop = Math.max(inset, viewport.height - size.height - inset);
    return { left: clamp(point.left, inset, maxLeft), top: clamp(point.top, inset, maxTop) };
}

export function anchorFromBox(box: Box, viewport: Size): Anchor {
    const left = Math.max(0, box.left);
    const right = Math.max(0, viewport.width - box.right);
    const top = Math.max(0, box.top);
    const bottom = Math.max(0, viewport.height - box.bottom);
    return {
        xEdge: left <= right ? "left" : "right",
        xOffset: Math.round(Math.min(left, right)),
        yEdge: top <= bottom ? "top" : "bottom",
        yOffset: Math.round(Math.min(top, bottom)),
    };
}

export function pointFromAnchor(anchor: Anchor, viewport: Size, size: Size): Point {
    return clampPoint({
        left: anchor.xEdge === "left" ? anchor.xOffset : viewport.width - anchor.xOffset - size.width,
        top: anchor.yEdge === "top" ? anchor.yOffset : viewport.height - anchor.yOffset - size.height,
    }, viewport, size);
}

export function parseAnchor(raw: unknown): Anchor | null {
    if (!isRecord(raw)) return null;
    const { xEdge, xOffset, yEdge, yOffset } = raw;
    if (xEdge !== "left" && xEdge !== "right") return null;
    if (yEdge !== "top" && yEdge !== "bottom") return null;
    if (typeof xOffset !== "number" || !(xOffset >= 0) || typeof yOffset !== "number" || !(yOffset >= 0)) return null;
    return { xEdge, xOffset, yEdge, yOffset };
}

export function dockPoint(composer: Box, orb: Size, viewport: Size, bottomInset = DOCK_BOTTOM_INSET): Point | null {
    if (composer.width <= 0 || composer.height <= 0 || orb.width <= 0 || orb.height <= 0) return null;
    const side = Math.min(6, Math.max(2, composer.width / 8));
    const minLeft = composer.left + side;
    const maxLeft = Math.max(minLeft, composer.right - orb.width - side);
    const minTop = composer.top + Math.min(4, Math.max(0, composer.height - orb.height));
    const maxTop = Math.max(minTop, composer.bottom - orb.height - 4);
    return clampPoint({
        left: clamp(composer.left + (composer.width - orb.width) / 2, minLeft, maxLeft),
        top: clamp(composer.bottom - orb.height - bottomInset, minTop, maxTop),
    }, viewport, orb);
}

export function opensUpward(handle: Box, required: number, viewport: Size): boolean {
    const below = viewport.height - handle.bottom - VIEWPORT_INSET;
    const above = handle.top - VIEWPORT_INSET;
    if (required <= below) return false;
    if (required <= above) return true;
    return above > below;
}

export const dragDistanceReached = (dx: number, dy: number, threshold = 4) => dx * dx + dy * dy >= threshold * threshold;
