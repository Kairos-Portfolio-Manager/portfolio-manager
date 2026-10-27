import "dotenv/config";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { AGENTS } from "../config/agents.js";
import { classifyEvaluatorHealth, computeWeeklyScorecard, formatScorecardForPrompt, parseWeeklyLessons } from "../lib/weekly-scorecard.js";
import { listAgentMemories, applyWeeklyLessons } from "../lib/agent-memory.js";
import { recordAnthropicUsage } from "../lib/anthropic-usage.js";
import { createAnthropicMonthlyBudget } from "../lib/anthropic-monthly-budget.js";
import { getWeeklyReviewArtifact, listAllProposals, setWeeklyReviewArtifact } from "../lib/redis.js";
import { getServiceAccountClients, resolveSharedSpreadsheetId, readAgentRecommendationOutcomes } from "../lib/sheets.js";
import { sendMessage as sendTelegram } from "../lib/telegram.js";

/**
 * Weekly review (LOOP-DESIGN.md §2 cadence C) — closes the outer feedback loop.
 * Fridays after the daily jobs: for each agent, compute a deterministic
 * scorecard (proposals, decisions, matured track record, confidence
 * calibration), then ONE LLM call turns the scorecard into at most 3 durable
 * calibration lessons written into that agent's persistent memory — which the
 * next research scan already injects into its prompt. Deterministic math in
 * lib/weekly-scorecard.js; only the lesson-writing is a model call, and a
 * malformed model response yields zero lessons (fail closed), never garbage memory.
 */

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY?.trim(), maxRetries: 0 });
const WEEKLY_REVIEW_MODEL = "claude-sonnet-4-6";

const LESSON_PROMPT_RULES = `You write weekly calibration lessons for an investment research agent, based ONLY on the deterministic scorecard provided. Rules:
- At most 3 new lessons. Zero is a fine answer — most weeks with little matured data deserve zero.
- Each lesson must reference specific outcomes in the scorecard (counts, hit rates, rejection reasons), state what the agent should do differently, and be checkable later.
- If an existing lesson is contradicted by this week's data, list its exact text under "retire".
- Never restate the mandate, never invent outcomes not in the scorecard, never store prices or point-in-time market facts as durable lessons.
Respond with ONLY a single JSON object: {"lessons": ["<lesson>"], "retire": ["<exact text of an existing lesson to remove>"]}`;

function isoWeekOf(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export async function generateLessons(scorecard, existingLessons, { monthlyBudget, anthropicClient = anthropic } = {}) {
  const existingBlock = existingLessons.length
    ? `Existing lessons from prior weekly reviews (candidates for "retire" if contradicted):\n${existingLessons.map((m) => `- ${m.text}`).join("\n")}`
    : "No existing weekly lessons.";
  const request = {
    model: WEEKLY_REVIEW_MODEL,
    max_tokens: 500,
    system: [{ type: "text", text: LESSON_PROMPT_RULES }],
    messages: [{ role: "user", content: `${formatScorecardForPrompt(scorecard)}\n\n${existingBlock}` }],
  };
  const monthlyAuthorization = await monthlyBudget?.authorizeCall({
    role: "weekly_review",
    model: WEEKLY_REVIEW_MODEL,
    request,
  });
  let response;
  try {
    response = await anthropicClient.messages.create(request);
  } catch (error) {
    await monthlyBudget?.settleProviderFailure?.(monthlyAuthorization, error);
    throw error;
  }
  const telemetryResult = await recordAnthropicUsage({
    role: "weekly_review",
    agentId: scorecard.agentId,
    model: WEEKLY_REVIEW_MODEL,
    stopReason: response.stop_reason,
    usage: response.usage,
    pricingVersion: monthlyAuthorization?.pricingVersion ?? null,
    now: monthlyAuthorization?.authorizedAt ? new Date(monthlyAuthorization.authorizedAt) : new Date(),
  });
  await monthlyBudget?.settleCall(monthlyAuthorization, telemetryResult);
  if (response.stop_reason === "max_tokens") {
    console.warn(`[WeeklyReview] ${scorecard.agentId}: lesson response hit max_tokens — discarding (fail closed).`);
    return { lessons: [], retire: [], parseError: true };
  }
  const text = response.content.find((b) => b.type === "text")?.text ?? "";
  return parseWeeklyLessons(text);
}

export async function runWeeklyReview({
  now = Date.now(),
  monthlyBudget = null,
  anthropicClient = anthropic,
  env = process.env,
  agents = AGENTS,
  getClients = getServiceAccountClients,
  resolveSpreadsheet = resolveSharedSpreadsheetId,
  readOutcomes = readAgentRecommendationOutcomes,
  listProposals = listAllProposals,
  getArtifact = getWeeklyReviewArtifact,
  setArtifact = setWeeklyReviewArtifact,
  listMemories = listAgentMemories,
  applyLessons = applyWeeklyLessons,
  generate = generateLessons,
  send = sendTelegram,
} = {}) {
  const spendBudget = monthlyBudget ?? createAnthropicMonthlyBudget({ now: () => new Date(now) });
  const { sheets, drive } = getClients();
  const spreadsheetId = await resolveSpreadsheet(sheets, drive);
  const proposals = await listProposals();
  const isoWeek = isoWeekOf(new Date(now));
  const previousIsoWeek = isoWeekOf(new Date(now - 7 * 24 * 60 * 60 * 1000));
  const previousArtifact = await getArtifact(previousIsoWeek);

  const summaryLines = [`📊 Weekly review — ${isoWeek}`];
  const artifact = { isoWeek, agents: {}, generatedAt: new Date(now).toISOString() };
  const failures = [];

  for (const agent of agents.filter((candidate) => candidate.researchStatus === "active")) {
    try {
      const outcomes = await readOutcomes(sheets, spreadsheetId, agent.id);
      const scorecard = computeWeeklyScorecard({ agentId: agent.id, proposals, outcomes, now });
      scorecard.evaluatorHealth = classifyEvaluatorHealth(
        scorecard.weekActivity,
        previousArtifact?.agents?.[agent.id]?.scorecard?.evaluatorHealth
      );

      let lessonResult = { lessons: [], retire: [], parseError: false, skipped: false };
      const hasSignal =
        scorecard.proposalStats.created > 0 ||
        scorecard.weekActivity.scanned > 0 ||
        Object.values(scorecard.trackRecord).some((t) => t.matured > 0);
      if (hasSignal) {
        const existingWeekly = (await listMemories(agent.id, 100)).filter((m) => m.source === "weekly_review");
        lessonResult = await generate(scorecard, existingWeekly, { monthlyBudget: spendBudget, anthropicClient });
        if (lessonResult.lessons.length || lessonResult.retire.length) {
          await applyLessons(agent.id, lessonResult, new Date(now).toISOString());
        }
      } else {
        lessonResult.skipped = true;
      }

      artifact.agents[agent.id] = { scorecard, lessons: lessonResult.lessons, retired: lessonResult.retire };
      const p = scorecard.proposalStats;
      summaryLines.push(
        `${agent.id}: ${p.created} proposals (${p.accepted} accepted, ${p.rejected} rejected), ` +
          `${scorecard.weekActivity.evaluatorRejected} evaluator-rejected, ` +
          `evaluator ${scorecard.evaluatorHealth.status}, ` +
          `${lessonResult.skipped ? "no activity — lessons skipped" : `${lessonResult.lessons.length} new lesson(s)${lessonResult.parseError ? " (parse error — none saved)" : ""}`}`
      );
      if (scorecard.evaluatorHealth.consecutiveOutOfBand) {
        summaryLines.push(`  Evaluator health priority: ${scorecard.evaluatorHealth.reason} two weeks in a row.`);
      }
      for (const lesson of lessonResult.lessons) summaryLines.push(`  • ${lesson}`);
    } catch (err) {
      // One agent's review failing must not block the others, but it must be visible.
      console.error(`[WeeklyReview] ${agent.id} failed:`, err.message);
      summaryLines.push(`${agent.id}: REVIEW FAILED — ${err.message}`);
      artifact.agents[agent.id] = { error: err.message };
      failures.push({ agentId: agent.id, message: err.message });
    }
  }

  await setArtifact(isoWeek, artifact);
  const summary = summaryLines.join("\n");
  console.log(`[WeeklyReview] ${summary}`);
  if (failures.length) {
    try {
      const names = failures.map((failure) => failure.agentId).join(", ");
      await send(`🚨 Weekly learning review failed for ${names}: ${failures.map((failure) => failure.message).join("; ")}`);
    } catch (err) {
      console.error("[WeeklyReview] Telegram send failed:", err.message);
    }
  } else if (env.PITCH_LAB_ENABLED?.trim() !== "1") {
    // Keep the existing Agent 1 learning summary on phones until Pitch Lab's
    // weekly report is actually live; once enabled, that digest owns the slot.
    try {
      await send(summary);
    } catch (err) {
      console.error("[WeeklyReview] Telegram send failed:", err.message);
    }
  }
  return artifact;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  runWeeklyReview().catch((e) => {
    console.error("[WeeklyReview] error:", e.message);
    process.exit(1);
  });
}
