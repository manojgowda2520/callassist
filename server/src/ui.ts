// MCP Apps: the interactive card CallAssist's tools return. Hosts that support
// MCP Apps render it inline in a sandboxed iframe; hosts that don't (Alexa+ as
// documented today) use the same structuredContent as plain data.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";

export const CARD_URI = "ui://callassist/card.html";
export const UI_MIME = RESOURCE_MIME_TYPE;

const here = dirname(fileURLToPath(import.meta.url));
let cached: string | undefined;

/** The card's HTML, with the MCP Apps view library inlined so it is self-contained. */
export function cardHtml(): string {
  if (cached) return cached;
  const template = readFileSync(join(here, "ui/card.html"), "utf8");
  const lib = readFileSync(join(here, "ui/vendor/mcp-apps-view.js"), "utf8").replace(/<\/script/gi, "<\\/script");
  cached = template.replace("/*__MCP_APPS_VIEW__*/", () => lib);
  return cached;
}

/** The CallAssist Agent Skill (skills/callassist/SKILL.md), without its YAML header. */
let skillCache: { description: string; body: string } | undefined;
export function skillText(): { description: string; body: string } {
  if (skillCache) return skillCache;
  const raw = readFileSync(join(here, "../../skills/callassist/SKILL.md"), "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const description = m?.[1].match(/^description:\s*(.+)$/m)?.[1] ?? "CallAssist personal-assistant skill";
  skillCache = { description, body: (m?.[2] ?? raw).trim() };
  return skillCache;
}
