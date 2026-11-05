/**
 * Per-turn performance trace: where the time in one conversation turn went.
 *
 * "Make it work, make it work well, make it work fast" (owner, 2026-11-05):
 * this is the groundwork for the third step, so the data is already there
 * when tuning starts. One turn — a message in, Jev's guess, the filler, the
 * grounding reads, every model call, every database query, the reply out —
 * becomes ONE structured log line:
 *
 *   gcloud logging read 'jsonPayload.message="[perf] turn"' --format=json
 *
 * It joins the phone's own `[handsfree] turn` line on `messageUuid`, so a
 * hands-free turn can be read end to end: hearing her name → the server's
 * stages → her voice.
 *
 * The rule (owner): logging must never slow a turn down; a missed log is
 * better than a slower reply. So:
 *   - recording is an in-memory push or counter bump — no I/O, no
 *     serialisation, no awaiting — and every call is a no-op outside a trace;
 *   - each list is capped and anything past the cap is counted, not kept;
 *   - the line is built and written on a later tick (setImmediate) after the
 *     turn has finished, and a write that fails is dropped silently;
 *   - too many traces waiting to be written → new turns go untraced;
 *   - `PERF_TRACE=off` turns it all off; `PERF_TRACE_SAMPLE=0.1` traces a
 *     tenth of turns.
 *
 * What is never logged: the person's words, her reply, prompts, query
 * parameters. Ids, sizes, sources, model names and milliseconds only — the
 * same rule as `[handsfree] turn`.
 */
const { AsyncLocalStorage } = require("node:async_hooks");
const { performance, monitorEventLoopDelay } = require("node:perf_hooks");

const MAX_SPANS = 200;
const MAX_LLM = 60;
const MAX_MARKS = 80;
const MAX_SLOW_QUERIES = 12;
const MAX_PENDING = 50; // traces waiting for their line to be written
// A turn that never ends (a crash between stages) is written anyway, marked.
const ABANDON_MS = 3 * 60 * 1000;

const als = new AsyncLocalStorage();

function settings() {
	const off = /^(off|false|0|no)$/i.test(String(process.env.PERF_TRACE || ""));
	const raw = Number(process.env.PERF_TRACE_SAMPLE);
	const sample = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 1;
	return { enabled: !off, sample };
}
let config = settings();

let pending = 0;
let droppedTraces = 0;

// The event loop's own delay, as a native histogram (no JS on the hot path).
// A slow loop delays every turn on the instance, so each line carries what
// the loop looked like while it ran.
let loopDelay = null;
function loopHistogram() {
	if (loopDelay) return loopDelay;
	try {
		loopDelay = monitorEventLoopDelay({ resolution: 20 });
		loopDelay.enable();
	} catch {
		loopDelay = false;
	}
	return loopDelay;
}

const round = (ms) => Math.round(ms * 10) / 10;

class Trace {
	constructor(kind, fields) {
		this.kind = kind;
		this.t0 = performance.now();
		this.startedAt = Date.now();
		this.fields = { ...fields };
		this.marks = {};
		this.markCount = 0;
		this.spans = [];
		this.llm = [];
		this.db = { n: 0, ms: 0, max: 0, errors: 0, slow: [] };
		this.dropped = 0;
		this.ended = false;
		this.abandon = setTimeout(() => this.end({ abandoned: true }), ABANDON_MS);
		this.abandon.unref?.();
	}

	now() {
		return performance.now() - this.t0;
	}

	set(fields) {
		if (this.ended || !fields) return;
		Object.assign(this.fields, fields);
	}

	mark(name, attrs) {
		if (this.ended) return;
		if (!(name in this.marks)) {
			if (this.markCount >= MAX_MARKS) return void this.dropped++;
			this.markCount++;
		}
		this.marks[name] = round(this.now());
		if (attrs) this.set(attrs);
	}

	/** Start a span; returns end(attrs) — call it once, extra calls are ignored. */
	begin(name, attrs) {
		if (this.ended) return noop;
		if (this.spans.length >= MAX_SPANS) {
			this.dropped++;
			return noop;
		}
		const span = { n: name, s: round(this.now()) };
		if (attrs) span.a = attrs;
		this.spans.push(span);
		let done = false;
		return (more) => {
			if (done) return;
			done = true;
			span.d = round(this.now() - span.s);
			if (more) span.a = span.a ? { ...span.a, ...more } : more;
		};
	}

	llmCall(entry) {
		if (this.ended) return;
		if (this.llm.length >= MAX_LLM) return void this.dropped++;
		this.llm.push({
			at: round(this.now() - (entry.latencyMs || 0)),
			task: entry.task,
			ep: entry.endpointId,
			tier: entry.tier,
			model: entry.model || null,
			ok: entry.outcome,
			ms: Math.round(entry.latencyMs || 0),
			try: entry.attempt || 0,
			in: entry.inputChars || 0,
			out: entry.outputChars || 0,
		});
	}

	dbQuery(sql, ms, failed) {
		if (this.ended) return;
		const db = this.db;
		db.n++;
		db.ms += ms;
		if (ms > db.max) db.max = ms;
		if (failed) db.errors++;
		// Keep the slowest few, by statement shape only (never parameters).
		const slow = db.slow;
		if (slow.length < MAX_SLOW_QUERIES || ms > slow[slow.length - 1].ms) {
			slow.push({ sql, ms, at: round(this.now() - ms) });
			slow.sort((a, b) => b.ms - a.ms);
			if (slow.length > MAX_SLOW_QUERIES) slow.length = MAX_SLOW_QUERIES;
		}
	}

	end(fields) {
		if (this.ended) return;
		if (fields) Object.assign(this.fields, fields);
		this.totalMs = round(this.now());
		this.ended = true;
		clearTimeout(this.abandon);
		if (pending >= MAX_PENDING) return void droppedTraces++;
		pending++;
		setImmediate(() => {
			pending--;
			write(this);
		});
	}
}

function noop() {}

function shape(sql) {
	// The statement's shape for grouping: whitespace collapsed, cut short.
	// mysql2 takes values as parameters, so the text holds no personal data.
	return typeof sql === "string"
		? sql.replace(/\s+/g, " ").trim().slice(0, 90)
		: typeof sql?.sql === "string"
			? shape(sql.sql)
			: "?";
}

function line(t) {
	const h = loopHistogram();
	let loop = null;
	if (h) {
		loop = {
			p50: round(h.percentile(50) / 1e6),
			p99: round(h.percentile(99) / 1e6),
			max: round(h.max / 1e6),
		};
		h.reset();
	}
	const mem = process.memoryUsage();
	const out = {
		severity: t.fields.abandoned ? "WARNING" : "INFO",
		message: "[perf] turn",
		perf: {
			kind: t.kind,
			startedAt: new Date(t.startedAt).toISOString(),
			totalMs: t.totalMs,
			...t.fields,
			marks: t.marks,
			spans: t.spans,
			llm: t.llm,
			llmMs: t.llm.reduce((sum, c) => sum + c.ms, 0),
			db: { ...t.db, ms: Math.round(t.db.ms), max: Math.round(t.db.max) },
			loop,
			heapMb: Math.round(mem.heapUsed / 1048576),
			rssMb: Math.round(mem.rss / 1048576),
			dropped: t.dropped,
			...(droppedTraces ? { droppedTraces } : {}),
		},
	};
	droppedTraces = 0;
	return JSON.stringify(out);
}

function write(t) {
	try {
		console.log(line(t));
	} catch {
		// A log we couldn't write is a log we don't have. Never an error.
	}
}

// ---- The API. Every function is safe to call with no trace in scope. ----

/** A new trace for one turn, or null when tracing is off or unsampled. */
function start(kind, fields) {
	if (!config.enabled) return null;
	if (config.sample < 1 && Math.random() >= config.sample) return null;
	loopHistogram();
	return new Trace(kind, fields);
}

/** Make `trace` the current one for the rest of this request's async work. */
function enter(trace) {
	if (trace) als.enterWith(trace);
	return trace;
}

/** Run fn with `trace` current (for work started outside the request). */
function run(trace, fn) {
	return trace ? als.run(trace, fn) : fn();
}

function current() {
	return als.getStore() || null;
}

function mark(name, attrs) {
	current()?.mark(name, attrs);
}

function set(fields) {
	current()?.set(fields);
}

/** Start a span on the current trace; returns its end(attrs) function. */
function begin(name, attrs) {
	const t = current();
	return t ? t.begin(name, attrs) : noop;
}

/**
 * Time a promise that is already running, without changing it: returns the
 * same promise. Null or non-promise values pass straight through.
 */
function timed(name, promise, attrs) {
	if (!promise || typeof promise.then !== "function") return promise;
	const t = current();
	if (!t) return promise;
	const end = t.begin(name, attrs);
	promise.then(
		(v) => end(v == null ? { empty: true } : undefined),
		() => end({ failed: true }),
	);
	return promise;
}

/** Called by services/llm/telemetry for every routed model call. */
function llmCall(entry) {
	current()?.llmCall(entry);
}

/** Called by helpers/db for every pool query. */
function dbQuery(sql, ms, failed) {
	const t = current();
	if (t) t.dbQuery(shape(sql), ms, failed);
}

function end(fields) {
	current()?.end(fields);
}

module.exports = {
	start,
	enter,
	run,
	current,
	mark,
	set,
	begin,
	timed,
	llmCall,
	dbQuery,
	end,
	// For tests.
	_line: line,
	_reload: () => {
		config = settings();
	},
	MAX_SPANS,
	MAX_LLM,
	MAX_SLOW_QUERIES,
	MAX_PENDING,
};
