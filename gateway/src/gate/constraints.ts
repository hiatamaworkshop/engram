// ============================================================
// Gate — constraints (single source of truth)
// ============================================================
//
// Periphery Rulebook パターン準拠。
// 全バリデーション制約をここに集約。
// Gate は「処理する価値があるか」を構造判定する膜。
// LLM 不使用。ルールベースのみ。

export const COMPACT_CONSTRAINTS = {
  /** compact テキストの最小文字数 */
  minLength: 20,
  /** compact テキストの最大文字数 (超過は切り詰め対象) */
  maxLength: 50_000,
  /** compact テキストの最大バイト数 */
  maxPayloadBytes: 100_000,
} as const;

export const META_CONSTRAINTS = {
  /** projectId の最大長 */
  maxProjectIdLength: 128,
  /** sessionId の最大長 */
  maxSessionIdLength: 128,
  /** timestamp の有効範囲: 2020-01-01 以降 */
  minTimestamp: 1_577_836_800,
  /** filesModified の最大数 */
  maxFilesModified: 200,
  /** 単一ファイルパスの最大長 */
  maxFilePathLength: 512,
  /** commitMessages の最大数 */
  maxCommitMessages: 50,
  /** 単一コミットメッセージの最大長 */
  maxCommitMessageLength: 500,
  /** gitDiffStat の最大長 */
  maxGitDiffStatLength: 256,
} as const;

/** テンプレート検知パターン — 中身のない定型出力を弾く */
export const TEMPLATE_PATTERNS: readonly RegExp[] = [
  /^no significant changes/i,
  /^session summary:?\s*$/i,
  /^nothing notable/i,
  /^no changes were made/i,
  /^the session was brief/i,
  /^no code was modified/i,
  /^<summary>\s*<\/summary>/i,
  /^todo:\s*$/i,
];

/** 低品質検知パターン — 情報量ゼロのコンテンツ */
export const LOW_QUALITY_PATTERNS: readonly RegExp[] = [
  /^(.)\1{10,}$/,               // 同一文字の繰り返し
  /^[\s\n\r\t]+$/,              // 空白のみ
  /^[.\-_=*#]{10,}$/,           // 装飾文字のみ
];

export const GATE_ERROR_CODES = {
  EMPTY_BODY: "EMPTY_BODY",
  COMPACT_TOO_SHORT: "COMPACT_TOO_SHORT",
  COMPACT_TOO_LONG: "COMPACT_TOO_LONG",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  MISSING_PROJECT_ID: "MISSING_PROJECT_ID",
  MISSING_SESSION_ID: "MISSING_SESSION_ID",
  MISSING_TIMESTAMP: "MISSING_TIMESTAMP",
  INVALID_TIMESTAMP: "INVALID_TIMESTAMP",
  PROJECT_ID_TOO_LONG: "PROJECT_ID_TOO_LONG",
  SESSION_ID_TOO_LONG: "SESSION_ID_TOO_LONG",
  TEMPLATE_CONTENT: "TEMPLATE_CONTENT",
  LOW_QUALITY_CONTENT: "LOW_QUALITY_CONTENT",
  TOO_MANY_FILES: "TOO_MANY_FILES",
  FILE_PATH_TOO_LONG: "FILE_PATH_TOO_LONG",
  TOO_MANY_COMMITS: "TOO_MANY_COMMITS",
  COMMIT_MESSAGE_TOO_LONG: "COMMIT_MESSAGE_TOO_LONG",
  INVALID_OUTCOME: "INVALID_OUTCOME",
} as const;

export type GateErrorCode = typeof GATE_ERROR_CODES[keyof typeof GATE_ERROR_CODES];

/** NodeSeed 正規化制約 — ボランティア/Extractor 出力のサニタイズ */
export const NODE_SEED_LIMITS = {
  maxSummaryLength: 200,
  maxTags: 5,
  maxContentLength: 2000,
} as const;
