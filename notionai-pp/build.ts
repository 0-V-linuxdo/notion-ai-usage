/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { readFileSync, writeFileSync } from "fs";

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
const VERSION_DATE = "20261007";
const displayVersion = `[${VERSION_DATE}] v${pkg.version}`;
const REPO = "https://github.com/0-V-linuxdo/NotionPP";
const RAW = "https://raw.githubusercontent.com/0-V-linuxdo/NotionPP/main/userscript/NotionPP.user.js";

const HEADER = `// ==UserScript==
// @name         NotionAI++ ${displayVersion}
// @namespace    ${REPO}
// @version      ${VERSION_DATE}.${pkg.version}
// @description  Notion AI usage meter docked to the AI composer, Notion-style chat outline, and more. No cookies or tokens are read.
// @author       NotionAI++ Contributors
// @homepageURL  ${REPO}
// @supportURL   ${REPO}/issues
// @downloadURL  ${RAW}
// @updateURL    ${RAW}
// @match        https://app.notion.com/*
// @match        https://www.notion.so/*
// @match        https://notion.so/*
// @run-at       document-start
// @inject-into  page
// @grant        unsafeWindow
// @grant        GM_registerMenuCommand
// @license      MIT
// ==/UserScript==
`;

const result = await Bun.build({
    entrypoints: ["src/index.ts"],
    target: "browser",
    format: "iife",
    minify: false,
    define: { VERSION: JSON.stringify(displayVersion) },
});

if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
}

const code = await result.outputs[0].text();
writeFileSync("userscript/NotionPP.user.js", `${HEADER}\n${code}`);
console.log(`Built userscript/NotionPP.user.js (${(code.length / 1024).toFixed(1)} KiB) ${displayVersion}`);
