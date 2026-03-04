import type { FeedbackRequest, FeedbackResponse } from "../types.js";
/**
 * POST /feedback
 */
export declare function handleFeedback(body: FeedbackRequest): Promise<FeedbackResponse>;
