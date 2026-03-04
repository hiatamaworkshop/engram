import { getUpperLayerStats, getNodeCounts } from "../upper-layer/index.js";
/**
 * GET /status
 */
export async function handleStatus(_projectId) {
    const counts = await getNodeCounts();
    return {
        store: getUpperLayerStats(),
        totalNodes: counts.total,
        recentNodes: counts.recent,
        fixedNodes: counts.fixed,
    };
}
//# sourceMappingURL=status.js.map