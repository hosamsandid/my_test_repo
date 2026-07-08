"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { formatAskUserQuestion } = require("./session-log");

test("single question with described options renders header, question, options", () => {
  const out = formatAskUserQuestion({
    questions: [
      {
        header: "Auth method",
        question: "Which auth method should we use?",
        options: [
          { label: "OAuth", description: "Delegated login via provider" },
          { label: "API key", description: "Static bearer token" },
        ],
      },
    ],
  });
  assert.ok(out.includes("**Auth method**"));
  assert.ok(out.includes("Which auth method should we use?"));
  assert.ok(out.includes("- **OAuth** — Delegated login via provider"));
  assert.ok(out.includes("- **API key** — Static bearer token"));
  // Human-readable, not raw JSON.
  assert.ok(!out.includes("{"));
});

test("multiple questions are all included (AC2)", () => {
  const out = formatAskUserQuestion({
    questions: [
      { header: "Q1", question: "First?", options: [{ label: "A" }] },
      { header: "Q2", question: "Second?", options: [{ label: "B" }] },
    ],
  });
  assert.ok(out.includes("**Q1**"));
  assert.ok(out.includes("First?"));
  assert.ok(out.includes("**Q2**"));
  assert.ok(out.includes("Second?"));
  assert.ok(out.includes("- **A**"));
  assert.ok(out.includes("- **B**"));
});

test("options without a description omit the em-dash", () => {
  const out = formatAskUserQuestion({
    questions: [{ header: "H", question: "Pick", options: [{ label: "Only" }] }],
  });
  assert.ok(out.includes("- **Only**"));
  assert.ok(!out.includes("- **Only** —"));
});

test("multiSelect adds a hint", () => {
  const out = formatAskUserQuestion({
    questions: [
      { header: "H", question: "Pick some", multiSelect: true, options: [{ label: "A" }, { label: "B" }] },
    ],
  });
  assert.ok(out.includes("pick more than one"));
});

test("non-multiSelect omits the hint", () => {
  const out = formatAskUserQuestion({
    questions: [{ header: "H", question: "Pick one", options: [{ label: "A" }] }],
  });
  assert.ok(!out.includes("pick more than one"));
});

test("reply always carries the answer hint so the user knows to reply in chat (AC3)", () => {
  const out = formatAskUserQuestion({
    questions: [{ header: "H", question: "Q", options: [{ label: "A" }] }],
  });
  assert.ok(out.includes("Reply here to answer"));
});

test("missing/empty/invalid input returns null so the caller falls back", () => {
  assert.equal(formatAskUserQuestion(null), null);
  assert.equal(formatAskUserQuestion(undefined), null);
  assert.equal(formatAskUserQuestion("nope"), null);
  assert.equal(formatAskUserQuestion({}), null);
  assert.equal(formatAskUserQuestion({ questions: [] }), null);
  assert.equal(formatAskUserQuestion({ questions: "x" }), null);
});

test("questions with no usable content are skipped; all-empty returns null", () => {
  assert.equal(formatAskUserQuestion({ questions: [{}, { options: [] }] }), null);
});

test("malformed option entries are skipped without throwing", () => {
  const out = formatAskUserQuestion({
    questions: [
      {
        header: "H",
        question: "Q",
        options: [null, "bad", { description: "no label" }, { label: "Good" }],
      },
    ],
  });
  assert.ok(out.includes("- **Good**"));
  assert.ok(!out.includes("no label"));
});
