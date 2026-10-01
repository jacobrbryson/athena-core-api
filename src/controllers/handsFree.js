/**
 * Hands-free turn timings, reported by the phone after each turn.
 *
 * The server only sees its own slice of a hands-free turn (message in, reply,
 * voice). Everything before the message is sent — hearing her name, the
 * chime, the recogniser starting, deciding the person has stopped talking —
 * happens on the phone, and that is where most of the dead air was suspected
 * to be (owner, 2026-09-30). The phone times every stage and posts it here;
 * this writes one structured log line per turn so it can be read with
 * `gcloud logging read 'jsonPayload.message="[handsfree] turn"'`.
 *
 * Nothing is stored and the person's words are never logged: the turn carries
 * the message uuid instead, which is enough to find the transcript in the
 * conversation itself when a misheard turn needs looking at.
 */

// Milliseconds from the turn's start: the first sound of her name, or the
// start of a no-name follow-up.
const STAGES = [
  "named", // the wake recogniser confirmed "Athena"
  "transcribed", // the request was in hand as text
  "chime", // the chime finished
  "ready", // the request recogniser was listening
  "speechStart", // it heard speech begin
  "speechEnd", // it decided speech had ended
  "sent", // the server accepted the message
  "filler", // a "let me check…" clip started playing
  "reply", // her reply was found by polling
  "voice", // her voice for it arrived
  "speaking", // playback started
  "done", // playback finished
];
const PATHS = new Set(["wake", "oneBreath", "followUp"]);
const OUTCOMES = new Set(["answered", "nothing", "echo", "error"]);
const TRANSCRIBERS = new Set(["on-device", "vosk"]);
const MAX_MS = 10 * 60 * 1000;

const count = (v, max) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n), max) : null;
};

function parseTurn(body = {}) {
  const stages = {};
  const raw = body.stages && typeof body.stages === "object" ? body.stages : {};
  for (const stage of STAGES) {
    const ms = count(raw[stage], MAX_MS);
    if (ms != null) stages[stage] = ms;
  }
  const confidence = Number(body.confidence);
  return {
    path: PATHS.has(body.path) ? body.path : "unknown",
    outcome: OUTCOMES.has(body.outcome) ? body.outcome : "unknown",
    transcriber: TRANSCRIBERS.has(body.transcriber) ? body.transcriber : null,
    confidence:
      Number.isFinite(confidence) && confidence >= 0 && confidence <= 1
        ? Math.round(confidence * 100) / 100
        : null,
    words: count(body.words, 500),
    polls: count(body.polls, 1000),
    replyChars: count(body.replyChars, 100_000),
    audioMs: count(body.audioMs, MAX_MS),
    filler: body.filler === true,
    messageUuid:
      typeof body.messageUuid === "string" && /^[0-9a-f-]{36}$/i.test(body.messageUuid)
        ? body.messageUuid
        : null,
    // The phone's own short error ("Athena answered 429"), never free text.
    error: typeof body.error === "string" ? body.error.slice(0, 160) : null,
    stages,
  };
}

function recordTurn(req, res) {
  const turn = parseTurn(req.body);
  console.log(
    JSON.stringify({
      severity: turn.outcome === "error" ? "WARNING" : "INFO",
      message: "[handsfree] turn",
      handsFree: turn,
    }),
  );
  res.status(204).end();
}

module.exports = { recordTurn, parseTurn, STAGES };
