import { getUpperLayerStats, getNodeCounts, listProjects } from "../upper-layer/index.js";
/**
 * GET /status
 * When projectId is omitted, includes a project listing.
 */
export async function handleStatus(projectId) {
    const counts = await getNodeCounts(projectId);
    const result = {
        store: getUpperLayerStats(),
        totalNodes: counts.total,
        recentNodes: counts.recent,
        fixedNodes: counts.fixed,
    };
    // Include project listing when not scoped to a specific project
    if (!projectId) {
        result.projects = await listProjects();
    }
    return result;
}
//# sourceMappingURL=status.js.map