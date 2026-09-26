/**
 * Dreaming — Athena organizing her memories into tables of her own design.
 *
 *   mind.js       athena_mind: her connection, the fact mirror, guard + purge
 *   dream.js      the nightly pass (model rounds + audit trail)
 *   questions.js  what she wants to ask people afterwards
 *   recall.js     what the chat prompt reads back during the day
 *
 * Architecture: docs/architecture/dreaming.md.
 */
const mind = require("./mind");
const { dream, pruneAudit } = require("./dream");
const questions = require("./questions");
const recall = require("./recall");

module.exports = {
	configured: mind.configured,
	dream,
	pruneAudit,
	questions,
	promptBlock: recall.promptBlock,
};
