export interface EngramContext {
    userId: string;
    gatewayUrl: string;
    defaultProjectId?: string;
}
export declare function loadContext(): EngramContext;
export type NodeStatus = "recent" | "fixed";
export interface NodeSeed {
    summary: string;
    tags: string[];
    content?: string;
}
export type IngestTrigger = "session-end" | "milestone" | "git-commit" | "error-resolved" | "manual" | "convention" | "environment";
export type FeedbackSignal = "outdated" | "incorrect" | "superseded" | "merged";
