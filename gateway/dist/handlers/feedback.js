import { applyFeedback } from "../upper-layer/index.js";
const VALID_SIGNALS = new Set(["outdated", "incorrect", "superseded", "merged"]);
/**
 * POST /feedback
 */
export async function handleFeedback(body) {
    if (!body.entryId) {
        return { status: "error", entryId: "", signal: "outdated" };
    }
    if (!body.signal || !VALID_SIGNALS.has(body.signal)) {
        return { status: "error", entryId: body.entryId, signal: body.signal ?? "unknown" };
    }
    return applyFeedback(body.entryId, body.signal, body.reason);
}
//# sourceMappingURL=feedback.js.map