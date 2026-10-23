// Understands what the person on the phone (the worker) said. Local, rule based,
// so calls work offline. On Amazon Connect, Nova Sonic does this instead and
// reports the same outcomes through the phone-agent tools.
import { parseTime, type ParsedTime } from "./time.js";

export type WorkerIntent = "accept" | "decline" | "done" | "blocked" | "question" | "optout" | "eta_only" | "unclear";

export interface WorkerReading {
  intent: WorkerIntent;
  eta?: ParsedTime;
  text: string;
}

const has = (s: string, re: RegExp) => re.test(s);

export function readWorker(raw: string, now = new Date()): WorkerReading {
  const text = raw.trim().replace(/\s+/g, " ").slice(0, 500);
  const s = ` ${text.toLowerCase().replace(/[’']/g, "'")} `;
  const eta = parseTime(text, now);

  if (has(s, /\b(don't|do not|stop|never) (call|calling|ring)\b|\bremove my (number|name)\b|\bunsubscribe\b|\bopt out\b|^ (please )?stop( it| please| now)?[ .!]*$/))
    return { intent: "optout", text };

  if (has(s, /\b(already )?(done|finished|completed|delivered|sent it|sent|handed (it )?over|it's ready|its ready|all set|kept it|placed it|ho gaya|ho gya)\b/) &&
      !has(s, /\b(not|n't|almost|nearly) (yet )?(done|finished|completed|delivered|ready)\b|\bwill be (done|ready)\b|\bwhen (it's |it is )?done\b|\b(done|ready) (in|by|within) /))
    return { intent: "done", eta, text };

  if (has(s, /\b(problem|issue|stuck|out of|no stock|ran out|run out|broken|not working|locked|missing|need (the |a )?(key|money|cash|approval|address|details))\b/))
    return { intent: "blocked", eta, text };

  if (has(s, /\b(can't|cannot|can not|won't|unable|not possible|not available|no time|busy|on leave|sorry,? no|no,? sorry|i'm off|im off|not today)\b/) ||
      has(s, /^ (no|nope|nah)\b/))
    return { intent: "decline", eta, text };

  const question = /\?\s*$/.test(text) || has(s, /^ (which|what|where|when|who|whom|how|why|should i|do you want|is it|are you|can you tell|tell me)\b/);
  // "Is that OK?" asks; it doesn't agree. Judge agreement on what comes before a closing question.
  const statement = question ? s.replace(/[^.!?]*\?\s*$/, " ") : s;
  const accept = has(statement, /\b(yes|yeah|yep|yup|sure|ok|okay|fine|alright|all right|will do|on it|on my way|coming|right away|no problem|got it|haan|han ji|ha ji|theek|of course|absolutely|i can|i will|i'll)\b/);

  if (question && !accept) return { intent: "question", eta, text };
  if (accept) return { intent: "accept", eta, text };
  if (eta) return { intent: "eta_only", eta, text };
  if (question) return { intent: "question", eta, text };
  return { intent: "unclear", text };
}
