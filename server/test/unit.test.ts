import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTime } from "../src/time.js";
import { readWorker } from "../src/understand.js";
import { normalize, toQuestion, toRecipient, toThirdPerson } from "../src/emulator/brain.js";
import { makeTitle } from "../src/assistant.js";
import { Store } from "../src/store.js";
import { SEED } from "./helpers.js";

const NOW = new Date(2026, 9, 21, 11, 0, 0); // 11:00 AM local

test("parseTime: relative times", () => {
  const cases: [string, string, number][] = [
    ["in 10 minutes", "in 10 minutes", 10],
    ["give me 5 mins", "in 5 minutes", 5],
    ["about an hour", "in 1 hour", 60],
    ["half an hour", "in half an hour", 30],
    ["two hours", "in 2 hours", 120],
    ["within fifteen minutes", "in 15 minutes", 15],
    ["right away", "right away", 5],
    ["a couple of minutes", "in 2 minutes", 2],
  ];
  for (const [input, text, mins] of cases) {
    const p = parseTime(input, NOW);
    assert.ok(p, input);
    assert.equal(p.text, text, input);
    assert.equal(Math.round((p.at!.getTime() - NOW.getTime()) / 60000), mins, input);
  }
});

test("parseTime: clock times and days", () => {
  assert.equal(parseTime("by 3 pm", NOW)?.text, "by 3 PM");
  assert.equal(parseTime("by 3", NOW)?.text, "by 3 PM"); // office hours
  assert.equal(parseTime("at 3:30pm", NOW)?.text, "by 3:30 PM");
  assert.equal(parseTime("by 10 am", NOW)?.at?.getDate(), 22); // already past → tomorrow
  assert.equal(parseTime("tomorrow morning", NOW)?.text, "tomorrow morning");
  assert.equal(parseTime("by end of day", NOW)?.text, "by end of day");
  assert.equal(parseTime("no time words here", NOW), undefined);
  assert.equal(parseTime("I have 3 kids", NOW), undefined); // a bare number is not a time
});

test("readWorker: what people say on the phone", () => {
  const cases: [string, string][] = [
    ["Yes, I'll bring it in 10 minutes", "accept"],
    ["Okay sir", "accept"],
    ["sure, on my way", "accept"],
    ["give me 15 minutes", "eta_only"],
    ["Already done", "done"],
    ["It's done, I kept it on his desk", "done"],
    ["not done yet, 5 more minutes", "eta_only"],
    ["Sorry, I can't today, I'm on leave", "decline"],
    ["No", "decline"],
    ["We ran out of milk", "blocked"],
    ["The room is locked, I need the key", "blocked"],
    ["Which conference room?", "question"],
    ["How many people?", "question"],
    ["Please don't call me again", "optout"],
    ["stop calling me", "optout"],
    ["hmm", "unclear"],
  ];
  for (const [said, intent] of cases) assert.equal(readWorker(said, NOW).intent, intent, said);
  assert.equal(readWorker("yes, 10 minutes", NOW).eta?.text, "in 10 minutes");
});

test("emulator language helpers", () => {
  assert.equal(normalize("Alexa, get me a coffee!"), "get me a coffee");
  assert.equal(toThirdPerson("bring my charger to me", "Madhu"), "bring Madhu's charger to Madhu");
  assert.equal(toRecipient("I'll pick her up at 5", "Madhu"), "Madhu will pick you up at 5.");
  assert.equal(toQuestion("if she needs anything from the store"), "Do you need anything from the store?");
  assert.equal(toQuestion("whether the car is free"), "Is the car free?");
  assert.equal(toQuestion("if he can come at 4"), "Can you come at 4?");
});

test("makeTitle keeps titles short and tidy", () => {
  assert.equal(makeTitle("to book the conference room for 3 pm."), "Book the conference room for 3 pm");
  assert.ok(makeTitle("x ".repeat(100)).length <= 60);
});

test("store persists tasks and opt-outs to disk and reloads them", () => {
  const file = join(mkdtempSync(join(tmpdir(), "ca-")), "state.json");
  const a = new Store(SEED, file);
  const t = a.createTask({ kind: "task", title: "T", details: "D", assigneeId: "c_raju", assigneeName: "Raju" });
  a.contact("c_lakshmi")!.optedOut = true;
  a.updateTask(t.id, { status: "accepted" });
  const b = new Store(SEED, file);
  assert.equal(b.tasks.get(t.id)?.status, "accepted");
  assert.equal(b.contact("c_lakshmi")?.optedOut, true);
  assert.equal(SEED.contacts.find((c) => c.id === "c_lakshmi")?.optedOut, false, "seed is never mutated");
});
