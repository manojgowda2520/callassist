// Written follow-through for the user (Alexa+ Test CX: "designed, not plain
// text; details match what was confirmed"). Locally the emails land in an
// outbox folder; on AWS the same message goes out through Amazon SES.
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Business, Task, User } from "./store.js";

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  taskId: string;
}

export interface Mailer {
  send(msg: EmailMessage): void;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const LABEL: Record<Task["status"], [string, string]> = {
  calling: ["Calling", "#2f6fe4"],
  accepted: ["On it", "#15a46a"],
  blocked: ["Needs you", "#a86a00"],
  done: ["Done", "#0f9fa3"],
  declined: ["Declined", "#d8433b"],
  unreachable: ["No answer", "#d8433b"],
  cancelled: ["Cancelled", "#4a505b"],
};

export function renderEmail(task: Task, update: string, user: User, business?: Business): EmailMessage {
  const [label, color] = LABEL[task.status];
  const rows: [string, string | undefined][] = [
    ["Task", task.details],
    ["Person", task.assigneeName],
    ["Needed", task.dueText],
    ["Their time", task.eta],
    ["They said", task.reply ? `“${task.reply}”` : undefined],
  ];
  const subject = `CallAssist: ${task.title} · ${label}`;
  const html = `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#14161a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" style="max-width:520px;background:#fff;border:1px solid #e3e6eb;border-radius:14px" cellpadding="0" cellspacing="0">
<tr><td style="padding:20px 24px 8px"><div style="font-weight:700;font-size:15px;color:#0a7cff">CallAssist</div>
<div style="font-size:20px;font-weight:700;margin-top:6px">${esc(task.title)}</div>
<div style="display:inline-block;margin-top:8px;padding:3px 10px;border-radius:999px;background:${color}1a;color:${color};font-weight:700;font-size:12px">${label}</div></td></tr>
<tr><td style="padding:8px 24px 4px;font-size:15px;line-height:1.5">Hi ${esc(user.name)}, ${esc(update)}</td></tr>
<tr><td style="padding:8px 24px 16px"><table role="presentation" width="100%" style="font-size:14px;border-top:1px solid #eef0f3">
${rows.filter(([, v]) => v).map(([k, v]) => `<tr><td style="padding:8px 0;color:#8a909b;width:110px;vertical-align:top">${k}</td><td style="padding:8px 0">${esc(v!)}</td></tr>`).join("")}
</table></td></tr>
<tr><td style="padding:12px 24px 20px;font-size:12px;color:#8a909b;border-top:1px solid #eef0f3">CallAssist only calls people who agreed to it, and every call says it's an AI assistant${business ? ` on behalf of ${esc(business.name)}` : ""}. Ask Alexa “what's pending?” any time. Call data is deleted after 30 days.</td></tr>
</table></td></tr></table></body></html>`;
  const text = [`CallAssist: ${task.title} (${label})`, "", `Hi ${user.name}, ${update}`, "", ...rows.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`)].join("\n");
  return { to: user.email, subject, html, text, taskId: task.id };
}

/** Writes each email as an .html file you can open. */
export class LocalOutbox implements Mailer {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  send(msg: EmailMessage): void {
    const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${msg.taskId.slice(0, 8)}`;
    writeFileSync(join(this.dir, `${name}.html`), msg.html);
    writeFileSync(join(this.dir, `${name}.json`), JSON.stringify({ to: msg.to, subject: msg.subject, text: msg.text }, null, 2));
  }

  list(limit = 20): { file: string; subject: string; at: string }[] {
    try {
      return readdirSync(this.dir)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .reverse()
        .slice(0, limit)
        .map((f) => {
          const meta = JSON.parse(readFileSync(join(this.dir, f), "utf8"));
          return { file: f.replace(/\.json$/, ".html"), subject: meta.subject, at: f.slice(0, 24) };
        });
    } catch {
      return [];
    }
  }
}
