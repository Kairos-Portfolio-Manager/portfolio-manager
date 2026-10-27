import { sendMessage } from "./telegram.js";

const compact = (text, limit) => {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`;
};

export function formatProposalTelegram(proposal, { dashboardUrl = process.env.SYSLOOP_DASHBOARD_URL } = {}) {
  const amount = Number(proposal.amountDollars).toLocaleString("en-US", { style: "currency", currency: "USD" });
  const agent = proposal.agentId === "agent-1" ? "Agent 1" : proposal.agentId;
  const expires = new Date(proposal.expiresAt).toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  const base = String(dashboardUrl || "https://portfolio-dashboard-ivory-five.vercel.app").replace(/\/$/, "");
  return [
    `🚨 Approval needed — ${proposal.side} ${proposal.ticker} ${amount}`,
    `${agent} created a real proposal. No order has been placed.`,
    `Why: ${compact(proposal.rationale, 260)}`,
    `Risk: ${compact(proposal.riskSummary, 200)}`,
    `Expires ${expires}.`,
    `${base}/approvals`,
  ].join("\n");
}

export async function notifyProposalCreated(proposal, { env = process.env, send = sendMessage } = {}) {
  if (!env.TELEGRAM_BOT_TOKEN?.trim() || !env.TELEGRAM_CHAT_ID?.trim()) return false;
  await send(formatProposalTelegram(proposal, { dashboardUrl: env.SYSLOOP_DASHBOARD_URL }));
  return true;
}
