// ============================================================
// Receptor — Directive matching for user prompts (GAPS §6)
// ============================================================
// Rule-based, no model: the gateway embedding (all-MiniLM-L6-v2) cannot
// separate intents — measured 2026-09-17, any Japanese prompt scored
// 0.45-0.75 against every prototype regardless of meaning.
//
// English-first. The code knows only the canonical English terms in
// intent-lexicon.json; other languages register translations of those terms
// as data. A match is reported as the canonical term, so logs and labels
// read the same whatever language the prompt was in.
//
// Record-only: no emotion impulse until labels show the signal is real.

import lexicon from "./intent-lexicon.json" with { type: "json" };

export type Intent = keyof typeof lexicon.intents;

export interface DirectiveMatch {
  intent: Intent;
  term: string;   // canonical English term
}

interface Matcher {
  test: (lower: string) => boolean;
  match: DirectiveMatch;
}

interface LocalePack {
  segmentation: "whitespace" | "none";
  terms: Record<string, string[]>;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wordMatcher(phrase: string): (lower: string) => boolean {
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escape(phrase.toLowerCase())}(?![\\p{L}\\p{N}])`, "u");
  return (lower) => re.test(lower);
}

function substringMatcher(phrase: string): (lower: string) => boolean {
  const p = phrase.toLowerCase();
  return (lower) => lower.includes(p);
}

/** Build matchers; throws if a locale registers a term the English base lacks. */
export function buildMatchers(lex: {
  intents: Record<string, string[]>;
  locales: Record<string, LocalePack>;
}): Matcher[] {
  const termIntent = new Map<string, Intent>();
  const matchers: Matcher[] = [];

  for (const [intent, terms] of Object.entries(lex.intents)) {
    for (const term of terms) {
      termIntent.set(term, intent as Intent);
      matchers.push({ test: wordMatcher(term), match: { intent: intent as Intent, term } });
    }
  }

  for (const [locale, pack] of Object.entries(lex.locales)) {
    for (const [term, translations] of Object.entries(pack.terms)) {
      const intent = termIntent.get(term);
      if (!intent) throw new Error(`intent-lexicon: locale "${locale}" translates unknown term "${term}"`);
      for (const t of translations) {
        const test = pack.segmentation === "none" ? substringMatcher(t) : wordMatcher(t);
        matchers.push({ test, match: { intent, term } });
      }
    }
  }
  return matchers;
}

const MATCHERS = buildMatchers(lexicon as Parameters<typeof buildMatchers>[0]);

/** Canonical directive terms found in a prompt, deduplicated, in lexicon order. */
export function matchDirectives(text: string, matchers: Matcher[] = MATCHERS): DirectiveMatch[] {
  const lower = text.toLowerCase();
  const seen = new Set<string>();
  const out: DirectiveMatch[] = [];
  for (const m of matchers) {
    if (seen.has(m.match.term)) continue;
    if (m.test(lower)) {
      seen.add(m.match.term);
      out.push(m.match);
    }
  }
  return out;
}
