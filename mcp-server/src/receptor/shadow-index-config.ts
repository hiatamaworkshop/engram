// ============================================================
// Shadow Index — Configuration
// ============================================================
// All tunable parameters. No hardcoded magic numbers.

import type { AgentState } from "./types.js";

export interface ShadowIndexConfig {
  // --- 時間減衰 ---
  halfLife: number;               // デフォルト: 7200000 (2時間)

  // --- StalenessDetector ---
  minSiblingCount: number;        // 発火に必要な最小兄弟数。デフォルト: 3
  stalenessPercentile: number;    // 下位何%を「古い」とするか。デフォルト: 0.25
  minTimeDelta: number;           // 最新兄弟との最小時間差。デフォルト: 86400000 (24時間)

  // --- 視野拡大 ---
  ancestorDepth: number;          // Stage 2 の最大祖先走査階層。デフォルト: 2
  levenshteinThreshold: number;   // Stage 3 のファイル名編集距離閾値。デフォルト: 3

  // --- lastTouchedState 感度 ---
  stateMultipliers: Record<AgentState, number>;

  // --- ライフサイクル ---
  activeWindow: number;           // Active HeatNode の生存期間。デフォルト: 172800000 (48時間)
  indexVectorTTL: number;         // Index Vector の生存期間。デフォルト: 1209600000 (2週間)
  indexVectorMaxCount: number;    // Index Vector の上限件数。デフォルト: 500

  // --- receptor 統合 ---
  uncertaintyCoefficient: number; // staleness_warning の uncertainty 寄与係数。デフォルト: 0.15
}

export const shadowIndexConfig: ShadowIndexConfig = {
  halfLife: 2 * 60 * 60 * 1000,              // 2時間
  minSiblingCount: 3,
  stalenessPercentile: 0.25,
  minTimeDelta: 24 * 60 * 60 * 1000,         // 24時間
  ancestorDepth: 2,
  levenshteinThreshold: 3,
  stateMultipliers: {
    idle: 1.0,
    exploring: 0.8,
    delegating: 0.5,
    stuck: 0.4,
    deep_work: 0.1,
  },
  activeWindow: 48 * 60 * 60 * 1000,         // 48時間
  indexVectorTTL: 14 * 24 * 60 * 60 * 1000,  // 2週間
  indexVectorMaxCount: 500,
  uncertaintyCoefficient: 0.15,
};
