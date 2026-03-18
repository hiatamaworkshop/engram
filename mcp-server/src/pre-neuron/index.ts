// ============================================================
// Pre-Neuron Monitor Layer — immune system before neuron firing
// ============================================================
// Monitors that run before neuron evaluation.
// Unlike receptor signals, these detect what the agent is NOT seeing.
// Each monitor pushes alerts to the shared FIFO; hot-memo Layer 7 drains it.

export interface PreNeuronAlert {
  source: string;       // monitor name, e.g. "staleness-detector"
  message: string;      // one-line human-readable alert
  severity: "info" | "warn" | "critical";
  timestamp: number;
}

const MAX_ALERTS = 10;
const alerts: PreNeuronAlert[] = [];
let shownUpTo = 0; // index of first unseen alert

// ---- Push (called by individual monitors) ----

export function pushAlert(alert: Omit<PreNeuronAlert, "timestamp">): void {
  alerts.push({ ...alert, timestamp: Date.now() });
  if (alerts.length > MAX_ALERTS) {
    const dropped = alerts.length - MAX_ALERTS;
    alerts.splice(0, dropped);
    shownUpTo = Math.max(0, shownUpTo - dropped);
  }
}

// ---- Drain (called by hot-memo Layer 7) ----

export function formatPreNeuronAlerts(limit = 3): string {
  if (shownUpTo >= alerts.length) return "";

  const unseen = alerts.slice(shownUpTo, shownUpTo + limit);
  shownUpTo += unseen.length;

  const lines = unseen.map((a) => {
    const tag = a.severity === "critical" ? "!!" : a.severity === "warn" ? "!" : "·";
    return `${tag} ${a.source}: ${a.message}`;
  });

  return `[pre-neuron] ${lines.join(" | ")}`;
}

// ---- Utility ----

export function getPendingAlertCount(): number {
  return Math.max(0, alerts.length - shownUpTo);
}
