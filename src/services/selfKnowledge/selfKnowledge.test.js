const fs = require("fs");
const path = require("path");

const { DOCS_DIR, loadCatalog, validate, isCapabilityFile } = require("./catalog");
const { buildCapabilityBlock, availableTo, score } = require("./index");

/**
 * These tests are the enforcement half of docs/capabilities/README.md.
 *
 * The contract ("a feature isn't finished until it has a capability file") is
 * only worth writing down if something fails when it's broken. Two failures
 * matter most, and neither is visible by reading the diff:
 *
 *   - a malformed or half-written doc, which silently costs Athena the
 *     knowledge of a feature she has;
 *   - a new OAuth provider shipped with no capability file, which is exactly
 *     how she ends up unable to tell someone how to connect the thing that
 *     was just built for them.
 */

describe("capability docs", () => {
	const capabilities = loadCatalog();

	it("has capability files", () => {
		expect(capabilities.length).toBeGreaterThan(0);
	});

	it("every file is valid", () => {
		const problems = capabilities.flatMap((cap) => validate(cap));
		expect(problems).toEqual([]);
	});

	it("ids are unique", () => {
		const seen = new Map();
		for (const cap of capabilities) {
			expect(seen.has(cap.id)).toBe(false);
			seen.set(cap.id, cap.file);
		}
	});

	it("keeps internals out of the sections Athena can speak from", () => {
		// "Under the hood" names files and routes. It must never be renderable.
		for (const cap of capabilities) {
			const block = buildCapabilityBlock(cap.triggers.join(" "), {
				surface: cap.surfaces[0],
				audience: cap.audiences[0],
			});
			if (!block) continue;
			expect(block).not.toContain(cap.sections.get("Under the hood"));
		}
	});

	it("documents every OAuth provider in the connector registry", () => {
		// The registry is the list of things a person can be asked to connect.
		// A provider with no capability file is a feature Athena can't explain.
		const { PROVIDER_IDS } = require("../connectors/registry");
		const documented = new Set(capabilities.map((c) => c.id));
		const missing = PROVIDER_IDS.filter(
			(id) => !documented.has(String(id).replace(/_/g, "-"))
		);
		expect(missing).toEqual([]);
	});

	it("has an Under the hood map that still points at real files", () => {
		// The catalog is only as good as its rot rate. Code moves; a capability
		// file whose map points at a deleted path quietly stops being the thing
		// the next agent can trust, and nothing else would notice.
		const repoRoot = path.resolve(DOCS_DIR, "../..");
		const looksLikePath = /^[.\w][\w./-]*\.(js|cjs|ts|tsx|md|json)$/;
		const broken = [];
		for (const cap of capabilities) {
			const hood = cap.sections.get("Under the hood") || "";
			for (const [, token] of hood.matchAll(/`([^`]+)`/g)) {
				if (!token.includes("/") || token.includes("*") || token.includes("$")) continue;
				if (!looksLikePath.test(token)) continue;
				const base = token.startsWith("..") ? DOCS_DIR : repoRoot;
				if (!fs.existsSync(path.resolve(base, token))) broken.push(`${cap.file}: ${token}`);
			}
		}
		expect(broken).toEqual([]);
	});

	it("ships the README, ledger and template alongside the files", () => {
		for (const name of ["README.md", "LEDGER.md", "_template.md"]) {
			expect(fs.existsSync(path.join(DOCS_DIR, name))).toBe(true);
			expect(isCapabilityFile(name)).toBe(false);
		}
	});
});

describe("capability prompt block", () => {
	it("always lists what's available, even for an unrelated message", () => {
		const block = buildCapabilityBlock("what's for dinner tonight?", {
			surface: "companion",
			audience: "adult",
		});
		expect(block).toContain("Google Calendar");
		expect(block).toContain("Connected apps");
	});

	it("pulls in full detail for the capability a message is about", () => {
		const block = buildCapabilityBlock("can you connect to my google calendar?", {
			surface: "companion",
			audience: "adult",
		});
		// The index line plus the detail sections.
		expect(block).toContain("### Google Calendar");
		expect(block).toContain("Where to find it");
	});

	it("scopes to the surface and the audience", () => {
		const child = availableTo({ surface: "learning", audience: "child" });
		expect(child.every((c) => c.surfaces.includes("learning"))).toBe(true);
		expect(child.some((c) => c.id === "connected-apps")).toBe(false);
	});

	it("never speaks about a planned capability", () => {
		const planned = loadCatalog().filter((c) => c.status === "planned");
		for (const cap of planned) {
			const block =
				buildCapabilityBlock(cap.triggers.join(" "), {
					surface: cap.surfaces[0],
					audience: cap.audiences[0],
				}) || "";
			expect(block).not.toContain(cap.title);
		}
	});

	it("returns null when nothing is reachable", () => {
		expect(buildCapabilityBlock("hello", { surface: "nope", audience: "adult" })).toBeNull();
	});

	it("scores triggers on word boundaries", () => {
		const cap = { title: "Phone & car", triggers: ["car"], sections: new Map() };
		expect(score(cap, "I'm in the car")).toBeGreaterThan(0);
		expect(score(cap, "I drew a card")).toBe(0);
	});

	it("stays bounded as the catalog grows", () => {
		const block = buildCapabilityBlock("calendar chores memory photo car brain", {
			surface: "companion",
			audience: "adult",
		});
		expect(block.length).toBeLessThan(8000);
	});
});
