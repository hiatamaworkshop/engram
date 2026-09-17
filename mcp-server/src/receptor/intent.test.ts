// Run: npx tsx --test src/receptor/intent.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildMatchers, matchDirectives } from "./intent.js";

const terms = (text: string, m?: ReturnType<typeof buildMatchers>) =>
  matchDirectives(text, m).map(x => x.term);

describe("English base", () => {
  it("matches whole words only", () => {
    assert.deepEqual(terms("stop"), ["stop"]);
    assert.deepEqual(terms("I know the document is not done"), []);
    assert.deepEqual(terms("no, use the other file instead"), ["no", "instead"]);
  });

  it("matches multi-word terms case-insensitively", () => {
    assert.deepEqual(terms("Go ahead and commit"), ["go ahead"]);
  });
});

describe("locale registration", () => {
  const lex = {
    intents: { proceed: ["continue"], stop: ["stop"] },
    locales: {
      xx: { segmentation: "none" as const, terms: { continue: ["zug"], stop: ["halt"] } },
      yy: { segmentation: "whitespace" as const, terms: { stop: ["arret"] } },
    },
  };
  const m = buildMatchers(lex);

  it("reports translations as the canonical English term and intent", () => {
    assert.deepEqual(matchDirectives("pleasezugnow", m), [{ intent: "proceed", term: "continue" }]);
  });

  it("segmentation none matches inside text, whitespace needs boundaries", () => {
    assert.deepEqual(terms("xhaltx", m), ["stop"]);
    assert.deepEqual(terms("xarretx", m), []);
    assert.deepEqual(terms("arret please", m), ["stop"]);
  });

  it("a term matched in two languages is reported once", () => {
    assert.deepEqual(terms("stop halt", m), ["stop"]);
  });

  it("rejects a translation of a term the English base lacks", () => {
    assert.throws(() => buildMatchers({
      intents: { stop: ["stop"] },
      locales: { xx: { segmentation: "none", terms: { pause: ["p"] } } },
    }), /unknown term "pause"/);
  });
});

describe("shipped lexicon", () => {
  it("loads, and every locale key is a known English term", () => {
    // buildMatchers ran at import; reaching here means the lexicon is consistent
    assert.ok(matchDirectives("continue").length === 1);
  });
});
