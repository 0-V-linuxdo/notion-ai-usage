/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { MAX_COUNT, MAX_LEN } from "./store";

// Like the original script, the manager follows the browser language rather than Notion's UI language.
const zh = /^zh\b/i.test((navigator.languages?.[0] ?? navigator.language) || "");

const STRINGS = {
    title: ["问候语自定义 · 管理面板", "Greeting Customizer · Manager"],
    close: ["关闭", "Close"],
    newLabel: [`新问候语（支持换行，单条 ≤ ${MAX_LEN} 字符；最多 ${MAX_COUNT} 条）`, `New greeting (line breaks ok, max ${MAX_LEN} chars; up to ${MAX_COUNT} items)`],
    placeholder: ["输入问候语…（可用换行）", "Type a greeting... (line breaks allowed)"],
    add: ["添加", "Add"],
    cancelEdit: ["取消修改", "Cancel edit"],
    saveEdit: ["保存修改", "Save changes"],
    saved: ["已保存：{count}/{max} 条", "Saved: {count}/{max}"],
    edit: ["修改", "Edit"],
    delete: ["删除", "Delete"],
    empty: ["问候语不能为空（不能全是空格）。", "Greeting cannot be empty (whitespace only)."],
    tooLong: [`单条问候语不能超过 ${MAX_LEN} 字符。`, `A greeting cannot exceed ${MAX_LEN} characters.`],
    tooMany: [`最多只能保存 ${MAX_COUNT} 条问候语。`, `You can save up to ${MAX_COUNT} greetings.`],
    rotation: ["轮播设置（自动保存）", "Rotation (saved automatically)"],
    mode: ["轮播方式", "Mode"],
    modeRefresh: ["刷新/进入首页时切换", "Rotate on refresh / entering home"],
    modeInterval: ["按时间间隔自动切换", "Rotate on a timer"],
    modeManual: ["手动点击标题切换", "Click the greeting to rotate"],
    order: ["轮播顺序", "Order"],
    orderSequential: ["顺序循环", "Sequential"],
    orderRandom: ["随机选择", "Random"],
    interval: ["间隔（秒）", "Interval (seconds)"],
    tip: ["提示：手动模式下，点击首页问候语即可切换；定时模式离开首页会自动停止计时。双击右键问候语可随时打开本面板。", "Tip: in manual mode, click the home greeting to rotate. The timer stops when you leave the home page. Double right-click the greeting to open this panel."],
    done: ["完成", "Done"],
    clickHint: ["点击切换问候语", "Click to rotate greeting"],
    menu: ["💬 NotionAI++ 问候语设置", "💬 NotionAI++ greetings"],
} as const;

export type StringKey = keyof typeof STRINGS;

export function tr(key: StringKey, vars: Record<string, string | number> = {}) {
    const text: string = STRINGS[key][zh ? 0 : 1];
    return text.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}
