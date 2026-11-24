#!/usr/bin/env node
/**
 * Paint mission badge art (owner, 11-24) with the image model dreams use, into
 * companion/public/assets/badges/<key>.webp, where the kids' tablets load it.
 *
 *   node scripts/badgeArt.js                  every badge without art yet
 *   node scripts/badgeArt.js first-sight      just these (repaints them)
 *
 * One image call per badge. The prompt is code-built from src/config/badges.js.
 */
require("dotenv").config({ quiet: true });
const fs = require("node:fs");
const path = require("node:path");
const llm = require("../src/services/llm");
const { BADGES, ART_STYLE } = require("../src/config/badges");

const OUT = path.resolve(__dirname, "../../companion/public/assets/badges");

(async () => {
	const asked = process.argv.slice(2).filter((a) => !a.startsWith("--"));
	fs.mkdirSync(OUT, { recursive: true });
	const todo = BADGES.filter((b) => (asked.length ? asked.includes(b.key) : !fs.existsSync(path.join(OUT, `${b.key}.webp`))));
	if (!todo.length) return console.log("Nothing to paint.");
	const results = await Promise.allSettled(
		todo.map(async (b) => {
			const out = await llm.image(ART_STYLE + b.emblem + ".", { size: "1024x1024", quality: "medium", outputFormat: "webp" });
			const img = out.images?.[0];
			if (!img?.b64) throw new Error("no image bytes");
			const file = path.join(OUT, `${b.key}.webp`);
			fs.writeFileSync(file, Buffer.from(img.b64, "base64"));
			return `${b.key}: ${Math.round(fs.statSync(file).size / 1024)} KB (${out.model})`;
		})
	);
	results.forEach((r, i) => console.log(r.status === "fulfilled" ? `✓ ${r.value}` : `✗ ${todo[i].key}: ${r.reason?.message}`));
	process.exit(results.some((r) => r.status === "rejected") ? 1 : 0);
})();
