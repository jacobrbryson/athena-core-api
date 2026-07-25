const pool = require("../helpers/db");
const memoryService = require("./memory");

/**
 * Card games Athena plays with a child. Currently Go Fish.
 *
 * The design rule that makes this work: **the server adjudicates, Athena
 * narrates.** A language model asked to "remember your hand" will forget it,
 * contradict itself a few turns later, and — worst of all — quietly cheat when
 * it wants the story to go a certain way. So the deck, both hands and every
 * rule live here. Athena is handed her own cards and a list of what just
 * happened, and her only job is to say it out loud in character.
 *
 * Intent is parsed from the child's message BEFORE the prompt is built (the
 * same pattern as mission code reporting), so the events Athena narrates have
 * already really happened.
 */

const GO_FISH = "go_fish";
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SUITS = ["H", "D", "C", "S"];
const HAND_SIZE = 7;

const RANK_LABELS = {
	A: "ace", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven",
	8: "eight", 9: "nine", 10: "ten", J: "jack", Q: "queen", K: "king",
};

/** Spoken/typed forms a child might use, mapped to a rank. */
const RANK_WORDS = {
	ace: "A", aces: "A", one: "A", ones: "A",
	two: "2", twos: "2", deuce: "2", deuces: "2",
	three: "3", threes: "3", four: "4", fours: "4",
	five: "5", fives: "5", six: "6", sixes: "6",
	seven: "7", sevens: "7", eight: "8", eights: "8",
	nine: "9", nines: "9", ten: "10", tens: "10",
	jack: "J", jacks: "J", queen: "Q", queens: "Q",
	king: "K", kings: "K",
};

const rankOf = (card) => card.slice(0, -1);
const labelOf = (rank) => RANK_LABELS[rank] || rank;

function freshDeck() {
	const deck = [];
	for (const r of RANKS) for (const s of SUITS) deck.push(`${r}${s}`);
	// Fisher-Yates.
	for (let i = deck.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[deck[i], deck[j]] = [deck[j], deck[i]];
	}
	return deck;
}

/** Move any completed four-of-a-kind out of a hand and into that side's books. */
function claimBooks(hand, books) {
	const counts = {};
	for (const c of hand) counts[rankOf(c)] = (counts[rankOf(c)] || 0) + 1;
	const claimed = [];
	for (const rank of Object.keys(counts)) {
		if (counts[rank] === 4) {
			claimed.push(rank);
			books.push(rank);
			for (let i = hand.length - 1; i >= 0; i--) {
				if (rankOf(hand[i]) === rank) hand.splice(i, 1);
			}
		}
	}
	return claimed;
}

/** Draw one card into a hand, if the pond still has any. */
function drawFrom(state, who) {
	if (!state.pond.length) return null;
	const card = state.pond.pop();
	state[who].push(card);
	return card;
}

/**
 * A hand that empties while the pond still has cards gets refilled — otherwise
 * a player is knocked out of a game that isn't over yet.
 */
function refill(state, who, events) {
	if (state[who].length || !state.pond.length) return;
	const drawn = [];
	for (let i = 0; i < HAND_SIZE && state.pond.length; i++) {
		drawn.push(state.pond.pop());
	}
	state[who].push(...drawn);
	events.push({
		type: "refill",
		who,
		count: drawn.length,
		cards: who === "athena" ? drawn : drawn,
	});
}

function isOver(state) {
	return state.athenaBooks.length + state.playerBooks.length === RANKS.length;
}

function finish(state, events) {
	if (!isOver(state)) return;
	const a = state.athenaBooks.length;
	const p = state.playerBooks.length;
	events.push({
		type: "game_over",
		athenaBooks: a,
		playerBooks: p,
		result: p > a ? "player_wins" : a > p ? "athena_wins" : "tie",
	});
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

async function loadGame(sessionId) {
	const [rows] = await pool.query(
		`SELECT state, status FROM guardian_game WHERE session_id = ? AND game = ?;`,
		[sessionId, GO_FISH]
	);
	if (!rows.length || rows[0].status !== "active") return null;
	const raw = rows[0].state;
	return typeof raw === "string" ? JSON.parse(raw) : raw;
}

async function saveGame(sessionId, state, status = "active") {
	await pool.query(
		`INSERT INTO guardian_game (session_id, game, state, status)
     VALUES (?, ?, CAST(? AS JSON), ?)
     ON DUPLICATE KEY UPDATE state = VALUES(state), status = VALUES(status);`,
		[sessionId, GO_FISH, JSON.stringify(state), status]
	);
}

async function endGame(sessionId) {
	await pool.query(
		`DELETE FROM guardian_game WHERE session_id = ? AND game = ?;`,
		[sessionId, GO_FISH]
	);
}

/* -------------------------------------------------------------------------- */
/* Turns                                                                      */
/* -------------------------------------------------------------------------- */

/** Deal a new game. The child always goes first. */
function deal() {
	const pond = freshDeck();
	const state = {
		pond,
		athena: pond.splice(0, HAND_SIZE),
		player: pond.splice(0, HAND_SIZE),
		athenaBooks: [],
		playerBooks: [],
		turn: "player",
	};
	const events = [{ type: "dealt" }];
	claimBooks(state.athena, state.athenaBooks).forEach((rank) =>
		events.push({ type: "book", who: "athena", rank })
	);
	claimBooks(state.player, state.playerBooks).forEach((rank) =>
		events.push({ type: "book", who: "player", rank })
	);
	return { state, events };
}

/**
 * The child asks Athena for a rank. Go Fish rules: you may only ask for a rank
 * you already hold. A hit lets them go again; a miss sends them fishing, and
 * fishing up the very card they asked for also lets them go again.
 */
function playerAsks(state, rank, events) {
	if (!state.player.some((c) => rankOf(c) === rank)) {
		events.push({ type: "illegal_ask", rank });
		return;
	}
	const taken = state.athena.filter((c) => rankOf(c) === rank);
	events.push({ type: "player_asks", rank, hit: taken.length > 0, count: taken.length });

	if (taken.length) {
		state.athena = state.athena.filter((c) => rankOf(c) !== rank);
		state.player.push(...taken);
		claimBooks(state.player, state.playerBooks).forEach((r) =>
			events.push({ type: "book", who: "player", rank: r })
		);
		refill(state, "athena", events);
		state.turn = "player"; // hit — go again
		return;
	}

	const drawn = drawFrom(state, "player");
	events.push({ type: "go_fish", who: "player", drew: !!drawn, lucky: drawn ? rankOf(drawn) === rank : false });
	claimBooks(state.player, state.playerBooks).forEach((r) =>
		events.push({ type: "book", who: "player", rank: r })
	);
	// Fishing up exactly what you asked for earns another turn.
	state.turn = drawn && rankOf(drawn) === rank ? "player" : "athena";
}

/** Pick a rank for Athena to ask for: the one she holds most of. */
function athenaChoice(state) {
	const counts = {};
	for (const c of state.athena) counts[rankOf(c)] = (counts[rankOf(c)] || 0) + 1;
	const ranks = Object.keys(counts);
	if (!ranks.length) return null;
	ranks.sort((a, b) => counts[b] - counts[a]);
	const best = counts[ranks[0]];
	const tied = ranks.filter((r) => counts[r] === best);
	return tied[Math.floor(Math.random() * tied.length)];
}

/** Run Athena's whole turn — she keeps asking until she misses. */
function athenaTurn(state, events) {
	let guard = 0;
	while (state.turn === "athena" && !isOver(state) && guard++ < 20) {
		const rank = athenaChoice(state);
		if (!rank) {
			refill(state, "athena", events);
			if (!state.athena.length) {
				state.turn = "player";
				break;
			}
			continue;
		}
		const taken = state.player.filter((c) => rankOf(c) === rank);
		events.push({ type: "athena_asks", rank, hit: taken.length > 0, count: taken.length });

		if (taken.length) {
			state.player = state.player.filter((c) => rankOf(c) !== rank);
			state.athena.push(...taken);
			claimBooks(state.athena, state.athenaBooks).forEach((r) =>
				events.push({ type: "book", who: "athena", rank: r })
			);
			refill(state, "player", events);
			continue; // hit — ask again
		}

		const drawn = drawFrom(state, "athena");
		events.push({ type: "go_fish", who: "athena", drew: !!drawn, lucky: drawn ? rankOf(drawn) === rank : false });
		claimBooks(state.athena, state.athenaBooks).forEach((r) =>
			events.push({ type: "book", who: "athena", rank: r })
		);
		if (!(drawn && rankOf(drawn) === rank)) state.turn = "player";
	}
	refill(state, "player", events);
}

/* -------------------------------------------------------------------------- */
/* The running record — this part DOES belong in Athena's memory              */
/*                                                                            */
/* The hidden hand has to be server-side (a hand must survive a refresh, a    */
/* second device and a 20-message history window, and it has to be provably   */
/* un-cheatable). But the *relationship* around the game is exactly what      */
/* Athena's long-term memory is for, so results are written there: she        */
/* remembers that you play, how often, and who is ahead.                      */
/* -------------------------------------------------------------------------- */

const MEMORY_KEY = "go_fish";
// Machine-readable tail on an otherwise human-readable memory value, so the
// running tally survives round-tripping through the prompt-facing store.
const TALLY_RE = /\[tally (\d+)\/(\d+)\/(\d+)\]/;

async function readTally(profileId) {
	try {
		const rows = await memoryService.getMemorySummaryForProfileId(profileId, 50);
		const prior = rows.find((r) => r.key === MEMORY_KEY);
		const m = prior?.value ? prior.value.match(TALLY_RE) : null;
		if (!m) return { played: 0, theirs: 0, hers: 0 };
		return { played: +m[1], theirs: +m[2], hers: +m[3] };
	} catch {
		return { played: 0, theirs: 0, hers: 0 };
	}
}

/** Record a finished game in Athena's long-term memory. Never blocks play. */
async function recordResult(profileId, result) {
	if (!profileId) return;
	try {
		const t = await readTally(profileId);
		t.played += 1;
		if (result === "player_wins") t.theirs += 1;
		else if (result === "athena_wins") t.hers += 1;

		const today = new Date().toISOString().slice(0, 10);
		const value =
			`Plays Go Fish with Athena. ${t.played} game${t.played === 1 ? "" : "s"} so far — ` +
			`they have won ${t.theirs}, Athena ${t.hers}. Last played ${today}. ` +
			`[tally ${t.played}/${t.theirs}/${t.hers}]`;

		await memoryService.upsertMemoryForProfile(profileId, null, {
			category: "interest",
			key: MEMORY_KEY,
			value,
			source: "ai",
			visibility: "private",
			confidence: 100,
		});
	} catch (err) {
		console.warn("[game] could not record Go Fish result:", err.message);
	}
}

/* -------------------------------------------------------------------------- */
/* Message intent                                                             */
/* -------------------------------------------------------------------------- */

const START_RE =
  /\b(go\s*fish|goldfish)\b/i;
const PLAY_RE =
  /\b(play|start|deal|game of|another round|again)\b/i;
const QUIT_RE =
  /\b(stop playing|quit the game|i quit|end the game|done playing|no more go\s*fish)\b/i;

/** The rank a child is asking for, e.g. "do you have any sevens?" -> "7". */
function parseRank(message) {
	if (typeof message !== "string") return null;
	const text = message.toLowerCase();
	// Word forms first ("any sevens"), so "10" inside "10s" still wins below.
	for (const [word, rank] of Object.entries(RANK_WORDS)) {
		if (new RegExp(`\\b${word}\\b`).test(text)) return rank;
	}
	const digits = text.match(/\b(10|[2-9])\s*(?:s|'s)?\b/);
	if (digits) return digits[1];
	return null;
}

/**
 * Work out what the child's message means for the card game, and apply it.
 * Returns a context object for the prompt, or null when the message has
 * nothing to do with a game.
 */
async function applyGameMessage(sessionId, message, profileId = null) {
	if (!sessionId || typeof message !== "string") return null;

	const existing = await loadGame(sessionId);

	if (existing && QUIT_RE.test(message)) {
		await endGame(sessionId);
		return { game: GO_FISH, status: "ended", events: [{ type: "quit" }] };
	}

	// Starting a new game.
	if (!existing) {
		if (!(START_RE.test(message) && PLAY_RE.test(message))) return null;
		const { state, events } = deal();
		await saveGame(sessionId, state);
		return buildContext(state, events, "started");
	}

	// A game is running — is this a move?
	const rank = parseRank(message);
	if (!rank) {
		// Still in a game, just chatting. Athena keeps her cards straight.
		return buildContext(existing, [], "in_progress");
	}

	const events = [];
	playerAsks(existing, rank, events);
	if (existing.turn === "athena") athenaTurn(existing, events);
	finish(existing, events);

	if (isOver(existing)) {
		await endGame(sessionId);
		const over = events.find((e) => e.type === "game_over");
		await recordResult(profileId, over?.result);
		return buildContext(existing, events, "finished");
	}
	await saveGame(sessionId, existing);
	return buildContext(existing, events, "in_progress");
}

/**
 * What Athena is allowed to know. She sees her OWN hand in full and only the
 * SIZE of the child's hand — never its contents. That asymmetry is the game.
 */
function buildContext(state, events, status) {
	return {
		game: GO_FISH,
		status,
		yourHand: state.athena.map((c) => `${labelOf(rankOf(c))} (${c})`),
		yourHandRanks: [...new Set(state.athena.map((c) => labelOf(rankOf(c))))],
		theirHandCount: state.player.length,
		pondCount: state.pond.length,
		yourBooks: state.athenaBooks.map(labelOf),
		theirBooks: state.playerBooks.map(labelOf),
		turn: state.turn,
		events: events.map((e) => describeEvent(e)),
	};
}

/** Plain-English event lines — Athena narrates these, she doesn't compute them. */
function describeEvent(e) {
	const r = e.rank ? labelOf(e.rank) : null;
	switch (e.type) {
		case "dealt":
			return "A new game of Go Fish was dealt. Seven cards each. They go first.";
		case "illegal_ask":
			return `They asked for ${r}s, but they are not holding any ${r}s — in Go Fish you may only ask for a rank you already have. Tell them warmly, remind them of the rule, and let them ask again. This does NOT cost them their turn.`;
		case "player_asks":
			return e.hit
				? `They asked you for ${r}s and you had ${e.count}. You handed ${e.count === 1 ? "it" : "them"} over. They go again.`
				: `They asked you for ${r}s and you had none, so you told them to go fish.`;
		case "athena_asks":
			return e.hit
				? `You asked them for ${r}s and they had ${e.count} — you took ${e.count === 1 ? "it" : "them"}. You get to ask again.`
				: `You asked them for ${r}s and they had none, so you went fishing.`;
		case "go_fish":
			if (!e.drew) return `${e.who === "athena" ? "You" : "They"} went to fish but the pond is empty.`;
			return e.who === "athena"
				? `You drew from the pond${e.lucky ? " — and it was exactly the rank you asked for, so you go again!" : "."}`
				: `They drew from the pond${e.lucky ? " — and they fished up exactly what they asked you for, so they go again!" : "."}`;
		case "book":
			return `${e.who === "athena" ? "You" : "They"} completed a book of ${r}s and laid it down.`;
		case "refill":
			return `${e.who === "athena" ? "Your" : "Their"} hand was empty, so ${e.count} card(s) were drawn from the pond.`;
		case "quit":
			return "They asked to stop playing. The game has been cleared. Be gracious about it.";
		case "game_over":
			return `THE GAME IS OVER. Final books — you ${e.athenaBooks}, them ${e.playerBooks}. ${
				e.result === "player_wins"
					? "They won. Be genuinely, loudly delighted for them."
					: e.result === "athena_wins"
						? "You won. Be gracious and warm about it, never smug, and tell them it was close if it was."
						: "It was a tie."
			}`;
		default:
			return "";
	}
}

module.exports = {
	GO_FISH,
	RANKS,
	MEMORY_KEY,
	recordResult,
	applyGameMessage,
	parseRank,
	loadGame,
	saveGame,
	endGame,
	deal,
	playerAsks,
	athenaTurn,
	buildContext,
	claimBooks,
};
