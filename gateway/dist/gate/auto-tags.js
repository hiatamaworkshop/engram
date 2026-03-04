// ============================================================
// Gate — automatic tag generation (Engram v2)
// ============================================================
//
// Extracts tags from summary + content when tags are empty.
// Pure string processing — no LLM, no external dependencies.
const STOP_WORDS = new Set([
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "shall",
    "should", "may", "might", "must", "can", "could",
    "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
    "my", "your", "his", "its", "our", "their",
    "this", "that", "these", "those",
    "in", "on", "at", "to", "for", "of", "with", "by", "from", "as",
    "into", "through", "during", "before", "after", "above", "below",
    "between", "under", "over", "about", "against", "within", "without",
    "and", "but", "or", "nor", "not", "no", "so", "if", "then", "than",
    "when", "where", "how", "what", "which", "who", "whom", "why",
    "all", "each", "every", "both", "few", "more", "most", "other",
    "some", "such", "any", "only", "own", "same", "just", "also",
    "very", "too", "quite", "rather", "here", "there", "now",
    "new", "old", "first", "last", "next", "use", "used", "using",
    "set", "get", "add", "run", "file", "node", "data", "make",
]);
const MAX_TAGS = 3;
/**
 * Generate tags from summary and optional content.
 * Returns 1-3 lowercase hyphenated tags.
 */
export function autoGenerateTags(summary, content) {
    const text = content ? `${summary} ${content}` : summary;
    // Tokenize: split on non-alphanumeric, lowercase, filter short/stop words
    const words = text
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
    // Count frequency
    const freq = new Map();
    for (const w of words) {
        freq.set(w, (freq.get(w) ?? 0) + 1);
    }
    // Sort by frequency desc, then by first appearance for stability
    const order = [...new Set(words)];
    order.sort((a, b) => {
        const fa = freq.get(a) ?? 0;
        const fb = freq.get(b) ?? 0;
        if (fb !== fa)
            return fb - fa;
        return order.indexOf(a) - order.indexOf(b);
    });
    return order.slice(0, MAX_TAGS);
}
//# sourceMappingURL=auto-tags.js.map