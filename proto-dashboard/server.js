// Research Testing Prototype dashboard -- standalone, separate process, separate
// port from production's server.js (:3200). Reads/writes proto:* only, via
// ../lib/proto-store.js. No dependency on the production dashboard repo, no
// Clerk auth, no shared route namespace with the existing "Lab" feature.
// docs/roadmaps/RESEARCH-PROTOTYPE-PLAN-2026-09-23.md step 6.
//
// Deliberately vanilla node:http, matching production server.js's own style
// (no Express dependency) -- one more npm dependency is unnecessary complexity
// for a page this small.

import "dotenv/config";
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { protoGet, protoSet, protoListPush, protoListRange, protoKey } from "../lib/proto-store.js";
import { isValidGrade, summarizeGrades } from "../lib/proto-feedback.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PROTO_DASHBOARD_PORT ?? 3201);

async function readJsonBody(req, { maxBytes = 1_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

const STATIC_CONTENT_TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

async function serveStatic(req, res) {
  const urlPath = req.url === "/" ? "/index.html" : req.url;
  const filePath = path.join(__dirname, "public", path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ""));
  if (!filePath.startsWith(path.join(__dirname, "public"))) {
    res.writeHead(403);
    res.end("forbidden");
    return true;
  }
  try {
    const body = await readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": STATIC_CONTENT_TYPES[ext] ?? "application/octet-stream" });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

async function loadRunsWithProposals(limit) {
  const runRows = await protoListRange(protoKey.runList(), { start: 0, end: limit - 1 });
  const runs = [];
  for (const row of runRows) {
    const receipt = await protoGet(protoKey.runReceipt(row.runId));
    if (!receipt) continue;
    const proposalIds = await protoListRange(protoKey.proposalsByRun(row.runId));
    const proposals = [];
    for (const id of proposalIds) {
      const p = await protoGet(protoKey.proposal(id));
      if (p) proposals.push({ ...p, proposalId: id });
    }
    runs.push({ ...receipt, proposals });
  }
  return runs;
}

async function loadGradesForProposal(proposalId) {
  const graders = await protoListRange(protoKey.gradesByProposal(proposalId));
  const grades = [];
  for (const grader of graders) {
    const g = await protoGet(protoKey.grade(proposalId, grader));
    if (g) grades.push(g);
  }
  return grades;
}

async function loadAllGrades() {
  const proposalIds = await protoListRange(protoKey.proposalsAll());
  const grades = [];
  for (const proposalId of proposalIds) grades.push(...(await loadGradesForProposal(proposalId)));
  return grades;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (req.method === "GET" && url.pathname === "/api/runs") {
      const limit = Math.max(1, Number(url.searchParams.get("limit") ?? 10) || 10);
      return sendJson(res, 200, { runs: await loadRunsWithProposals(limit) });
    }

    if (req.method === "GET" && url.pathname === "/api/summary") {
      const grades = await loadAllGrades();
      const feedbackState = await protoGet(protoKey.feedbackState());
      return sendJson(res, 200, { gradeSummary: summarizeGrades(grades), feedbackState });
    }

    if (req.method === "GET" && url.pathname === "/api/grades") {
      const proposalId = url.searchParams.get("proposalId");
      if (!proposalId) return sendJson(res, 400, { error: "proposalId is required" });
      return sendJson(res, 200, { grades: await loadGradesForProposal(proposalId) });
    }

    if (req.method === "POST" && url.pathname === "/api/grades") {
      const body = await readJsonBody(req);
      const grade = { ...body, gradedAt: new Date().toISOString() };
      if (!isValidGrade(grade)) return sendJson(res, 400, { error: "invalid grade payload" });
      const existingProposal = await protoGet(protoKey.proposal(grade.proposalId));
      if (!existingProposal) return sendJson(res, 404, { error: "unknown proposalId" });
      await protoSet(protoKey.grade(grade.proposalId, grade.grader), grade);
      const graders = await protoListRange(protoKey.gradesByProposal(grade.proposalId));
      if (!graders.includes(grade.grader)) {
        await protoListPush(protoKey.gradesByProposal(grade.proposalId), grade.grader);
      }
      return sendJson(res, 200, { ok: true, grade });
    }

    if (req.method === "GET" && (await serveStatic(req, res))) return;

    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    console.error("[ProtoDashboard] request failed:", err);
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`[ProtoDashboard] listening on http://localhost:${PORT} (reads/writes proto:* only)`);
});
