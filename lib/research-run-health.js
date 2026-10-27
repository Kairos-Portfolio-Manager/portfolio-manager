const BUDGET_ERROR_RE = /\b(402|429|credit|spend|budget|quota|rate.?limit|usage.?limit)\b/i;
const PROVIDER_ERROR_RE = /\b(anthropic|api.?key|authentication|unauthori[sz]ed|forbidden|model.*(?:not found|unavailable)|overloaded|service unavailable)\b/i;

export function finiteNonNegative(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

export function classifyResearchFailure(error) {
  const message = error instanceof Error ? error.message : String(error ?? "unknown research failure");
  const code = error && typeof error === "object" ? String(error.code ?? "") : "";
  return {
    kind: code === "monthly_budget_exhausted"
      ? "monthly_budget_exhausted"
      : code === "monthly_budget_telemetry_unavailable" || code === "monthly_budget_config_invalid" || code === "anthropic_model_unpriced" || code === "anthropic_pricing_version_unknown" || code === "anthropic_request_unbounded"
        ? "provider_unavailable"
        : BUDGET_ERROR_RE.test(message)
          ? "budget_exhausted"
          : PROVIDER_ERROR_RE.test(message)
            ? "provider_unavailable"
            : "scan_error",
    message,
  };
}

export function needsImmediateResearchFailureAlert(failure) {
  return ["budget_exhausted", "monthly_budget_exhausted", "provider_unavailable"].includes(failure?.kind);
}

export function canCreateActionableProposal(agent) {
  return agent?.executionEligibility === "supervised";
}

// Fail closed: only an explicit "active" status may research. A missing or
// misspelled status is treated as frozen rather than silently spending budget.
export function isResearchActive(agent) {
  return agent?.researchStatus === "active";
}
