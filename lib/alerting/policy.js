// Alert policy — decides what is worth a Telegram message and what state to keep.
// Pure: no I/O. Callers send the text, then persist whichever state matches the
// outcome (stateIfSent / stateIfNotSent).
//
// Why this exists: the sentinel used to page a P0/P1 once, the first time its
// fingerprint appeared, and then never again. A known-broken thing (Claude CLI
// logged out on the Jetson, holdings sync dead for 9 weeks) stayed silent. It also
// recorded a finding as "already announced" even when the Telegram send FAILED, so
// one transient outage could silence a real problem forever.
//
// Rules:
//   - New P0/P1 (never successfully announced) -> message now.
//   - Failed send -> the finding stays "not announced" and is retried next run.
//   - Once a day (first eligible run) -> a digest of every open P0/P1 with its age.
//     That digest is also the re-page: no open P0/P1 stays quiet for more than a day.
//   - A previously announced P0/P1 that clears -> a one-line "resolved" note.
//   - Nothing to say -> no message at all.

const ALERT_SEVERITIES = new Set(["P0", "P1"]);
const NEW_MAX_LINES = 8;
const DIGEST_MAX_LINES = 10;
const MESSAGE_MAX_CHARS = 3500;
const MORE_RESERVE = 48; // room for the "…and N more" line
const DETAIL_MAX_CHARS = 300;
const TITLE_MAX_CHARS = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

export function emptyAlertState() {
  return { version: 1, open: {}, lastDigestDate: null };
}

/** Accepts null, a JSON string, or an object; anything malformed becomes empty. */
export function normalizeAlertState(raw) {
  let value = raw;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return emptyAlertState(); }
  }
  if (!value || typeof value !== "object" || typeof value.open !== "object" || value.open === null) return emptyAlertState();
  const open = {};
  for (const [fingerprint, entry] of Object.entries(value.open)) {
    if (!entry || typeof entry !== "object") continue;
    open[fingerprint] = {
      firstSeenMs: Number.isFinite(entry.firstSeenMs) ? entry.firstSeenMs : null,
      lastAlertedMs: Number.isFinite(entry.lastAlertedMs) ? entry.lastAlertedMs : null,
      alertCount: Number.isInteger(entry.alertCount) && entry.alertCount >= 0 ? entry.alertCount : 0,
      severity: typeof entry.severity === "string" ? entry.severity : "P1",
      title: typeof entry.title === "string" ? entry.title : "",
    };
  }
  return { version: 1, open, lastDigestDate: typeof value.lastDigestDate === "string" ? value.lastDigestDate : null };
}

const severityRank = (severity) => (severity === "P0" ? 0 : 1);

function etDate(ms) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(ms));
}

export function describeAge(entry, nowMs, dateET) {
  if (!Number.isFinite(entry?.firstSeenMs)) return `open, age unknown (tracking started ${dateET})`;
  const elapsed = Math.max(0, nowMs - entry.firstSeenMs);
  if (elapsed < DAY_MS) return `open ${Math.max(1, Math.round(elapsed / 3600000))}h`;
  return `open ${Math.floor(elapsed / DAY_MS)}d (since ${etDate(entry.firstSeenMs)})`;
}

const oneLine = (text, limit) => {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`;
};

const byUrgencyThenAge = (a, b) =>
  severityRank(a.severity) - severityRank(b.severity)
  || (a.firstSeenMs ?? Infinity) - (b.firstSeenMs ?? Infinity)
  || a.title.localeCompare(b.title);

/**
 * @param {object}   args
 * @param {Array}    args.findings     [{ fingerprint, severity, title, detail? }]; only P0/P1 are considered
 * @param {*}        args.state        previously persisted alert state (any shape; normalized)
 * @param {Date}     args.now
 * @param {string}   args.dateET       "YYYY-MM-DD" in ET; the digest goes out once per value
 * @param {string[]} args.legacyKnown  fingerprints a previous version already announced (migration seed)
 * @param {string}   args.label        e.g. "System sentinel"
 * @param {boolean}  args.digest       set false to disable the daily digest
 */
export function planAlerts({ findings = [], state = null, now = new Date(), dateET, legacyKnown = [], label = "Alerts", digest = true } = {}) {
  const nowMs = now.getTime();
  const prev = normalizeAlertState(state);
  const legacy = new Set(legacyKnown);

  const current = new Map();
  for (const finding of findings) {
    if (!finding || typeof finding.fingerprint !== "string" || !ALERT_SEVERITIES.has(finding.severity)) continue;
    if (!current.has(finding.fingerprint)) current.set(finding.fingerprint, finding);
  }

  const nextOpen = {};
  const fresh = [];
  for (const [fingerprint, finding] of current) {
    const known = prev.open[fingerprint];
    let entry;
    if (known) {
      entry = { ...known, severity: finding.severity, title: finding.title };
    } else if (legacy.has(fingerprint)) {
      // Announced by the pre-upgrade sentinel; its age is not recoverable.
      entry = { firstSeenMs: null, lastAlertedMs: null, alertCount: 1, severity: finding.severity, title: finding.title };
    } else {
      entry = { firstSeenMs: nowMs, lastAlertedMs: null, alertCount: 0, severity: finding.severity, title: finding.title };
    }
    nextOpen[fingerprint] = entry;
    if (entry.alertCount === 0) fresh.push({ ...finding, ...entry });
  }

  const cleared = Object.entries(prev.open)
    .filter(([fingerprint, entry]) => !current.has(fingerprint) && entry.alertCount > 0 && entry.title)
    .map(([, entry]) => entry);

  const freshSet = new Set(fresh.map((f) => f.fingerprint));
  const digestDue = digest && prev.lastDigestDate !== dateET;
  // Anything already announced today (as new, or in an earlier digest) is not repeated:
  // the digest is for what has been open since BEFORE today.
  const announcedToday = (entry) => Number.isFinite(entry.lastAlertedMs) && etDate(entry.lastAlertedMs) === dateET;
  const digestItems = digestDue
    ? Object.entries(nextOpen)
      .filter(([fingerprint, entry]) => !freshSet.has(fingerprint) && !announcedToday(entry))
      .map(([fingerprint, entry]) => ({ fingerprint, ...entry }))
    : [];

  // Render item-by-item against a character budget. Only items that are ACTUALLY shown
  // are marked announced: an item hidden behind "...and N more" stays pending, so it is
  // named in the next message instead of being silenced forever.
  let budget = MESSAGE_MAX_CHARS;
  const sections = [];
  const shownFresh = new Set();
  const shownDigest = new Set();
  const addSection = (header, items, toLine, maxLines, onShown) => {
    if (!items.length) return 0;
    const lines = [];
    let used = header.length + 1 + MORE_RESERVE;
    for (const item of items) {
      let line = toLine(item);
      if (lines.length >= maxLines) break;
      if (used + line.length + 1 > budget) {
        // The first item of a section is always shown (truncated if it must be); otherwise one
        // oversize finding could starve every later one and never be named at all.
        if (lines.length) break;
        const room = Math.max(40, budget - used - 1);
        line = `${line.slice(0, room - 1).trimEnd()}…`;
      }
      lines.push(line);
      onShown?.(item);
      used += line.length + 1;
    }
    if (!lines.length) return items.length; // nothing fit in this message; all stay pending
    const hidden = items.length - lines.length;
    if (hidden) lines.push(`…and ${hidden} more (named in the next message)`);
    const text = `${header}\n${lines.join("\n")}`;
    sections.push(text);
    budget -= text.length + 2;
    return hidden;
  };

  const sortedFresh = [...fresh].sort(byUrgencyThenAge);
  addSection(
    `🚨 ${label}: ${fresh.length} new urgent finding${fresh.length === 1 ? "" : "s"}`,
    sortedFresh,
    (f) => {
      const detail = oneLine(f.detail, DETAIL_MAX_CHARS);
      return `${f.severity} ${oneLine(f.title, TITLE_MAX_CHARS)}${detail ? `\n   ${detail}` : ""}`;
    },
    NEW_MAX_LINES,
    (f) => shownFresh.add(f.fingerprint),
  );
  const digestHidden = addSection(
    `📋 ${label}: ${digestItems.length} still open`,
    [...digestItems].sort(byUrgencyThenAge),
    (item) => `${item.severity} ${oneLine(item.title, TITLE_MAX_CHARS)} — ${describeAge(item, nowMs, dateET)}`,
    DIGEST_MAX_LINES,
    (item) => shownDigest.add(item.fingerprint),
  );
  addSection(
    `✅ ${label}: resolved`,
    cleared.slice(0, DIGEST_MAX_LINES),
    (entry) => `${entry.severity} ${oneLine(entry.title, TITLE_MAX_CHARS)} — was ${describeAge(entry, nowMs, dateET)}`,
    DIGEST_MAX_LINES,
  );

  const text = sections.length ? sections.join("\n\n") : null;

  const withAnnounced = (announced) => {
    const open = {};
    for (const [fingerprint, entry] of Object.entries(nextOpen)) {
      const included = announced && (shownFresh.has(fingerprint) || shownDigest.has(fingerprint));
      open[fingerprint] = included
        ? { ...entry, lastAlertedMs: nowMs, alertCount: entry.alertCount + 1 }
        : entry;
    }
    return {
      version: 1,
      open,
      // The digest stays due until every open item has been named.
      lastDigestDate: announced && digestItems.length && digestHidden === 0 ? dateET : prev.lastDigestDate,
    };
  };

  return {
    text,
    freshFingerprints: [...freshSet],
    shownFingerprints: [...shownFresh, ...shownDigest],
    digestFingerprints: digestItems.map((item) => item.fingerprint),
    clearedTitles: cleared.map((entry) => entry.title),
    stateIfSent: withAnnounced(true),
    stateIfNotSent: withAnnounced(false),
  };
}
