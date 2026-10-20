// Turns spoken times ("in 10 minutes", "by 3:30 pm", "half an hour") into a
// date. Best effort: when nothing parses, the words are still kept as text.

const WORD_NUM: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, "forty five": 45, fortyfive: 45, sixty: 60, couple: 2, few: 3,
};

function num(s: string): number | undefined {
  const t = s.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  return WORD_NUM[t];
}

export interface ParsedTime {
  text: string;
  at?: Date;
}

/** Finds the first time expression in free text. */
export function parseTime(input: string, now = new Date()): ParsedTime | undefined {
  const s = ` ${input.toLowerCase().replace(/[,.!?]/g, " ").replace(/\s+/g, " ")} `;

  if (/\b(right now|right away|immediately|asap|now itself)\b/.test(s)) return { text: "right away", at: new Date(now.getTime() + 5 * 60_000) };

  const half = s.match(/\b(in )?(half an hour|half hour|30 mins?)\b/);
  if (half) return { text: "in half an hour", at: new Date(now.getTime() + 30 * 60_000) };

  const rel = s.match(/\b(?:in |within |about |around |another )?(\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty five|sixty|couple of|few)\s*(?:more\s+)?(minutes?|mins?|min|hours?|hrs?|hr)\b/);
  if (rel) {
    const n = num(rel[1].replace(/ of$/, ""));
    if (n !== undefined) {
      const mins = /^h/.test(rel[2]) ? n * 60 : n;
      const unit = /^h/.test(rel[2]) ? (n === 1 ? "hour" : "hours") : n === 1 ? "minute" : "minutes";
      return { text: `in ${n} ${unit}`, at: new Date(now.getTime() + mins * 60_000) };
    }
  }

  const clock = s.match(/\b(?:by|at|before|around|till|until)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a m|p m|o'?clock)?\b(?=\s)/);
  if (clock && (clock[2] || clock[3] || /\b(by|at|before|till|until)\s+\d/.test(s))) {
    let h = Number(clock[1]);
    const m = clock[2] ? Number(clock[2]) : 0;
    if (h <= 24 && m < 60) {
      const ap = clock[3]?.replace(/\s/g, "");
      if (ap === "pm" && h < 12) h += 12;
      if (ap === "am" && h === 12) h = 0;
      if (!ap && h >= 1 && h <= 7) h += 12; // "by 3" in office hours means 3 pm
      const at = new Date(now);
      at.setHours(h, m, 0, 0);
      if (/\btomorrow\b/.test(s) || at.getTime() < now.getTime() - 60_000) at.setDate(at.getDate() + 1);
      return { text: `by ${formatClock(at)}${/\btomorrow\b/.test(s) ? " tomorrow" : ""}`, at };
    }
  }

  if (/\btomorrow morning\b/.test(s)) return atHour(now, 10, "tomorrow morning", 1);
  if (/\btomorrow\b/.test(s)) return atHour(now, 10, "tomorrow", 1);
  if (/\b(end of (the )?day|eod|this evening|tonight)\b/.test(s)) return atHour(now, 18, "by end of day", 0);
  if (/\b(this afternoon|after lunch)\b/.test(s)) return atHour(now, 15, "this afternoon", 0);
  if (/\btoday\b/.test(s)) return atHour(now, 18, "today", 0);
  return undefined;
}

function atHour(now: Date, h: number, text: string, addDays: number): ParsedTime {
  const at = new Date(now);
  at.setDate(at.getDate() + addDays);
  at.setHours(h, 0, 0, 0);
  if (at.getTime() < now.getTime()) at.setTime(now.getTime() + 60 * 60_000);
  return { text, at };
}

export function formatClock(d: Date): string {
  let h = d.getHours();
  const m = d.getMinutes();
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return m ? `${h}:${String(m).padStart(2, "0")} ${ap}` : `${h} ${ap}`;
}
