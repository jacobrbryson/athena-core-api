/**
 * The five general collection actions (owner-authorized 2026-11-28).
 *
 * The owner authorized adding exactly these to the protected action layer, so
 * that any collection — the Christmas list, and every list after it — can be
 * created and changed from chat with no code change. Each normalize() checks
 * the proposal against the collection's OWN definition (services/collections),
 * so an action accepts exactly what that collection allows and nothing more.
 *
 *   define_collection   start (or version) a collection        never standing
 *   add_item            put a thing (or a person) on one        standing allowed
 *   update_item         change things, statuses, tick people    standing allowed
 *   remove_item         hide a thing or person (undo 30 days)   standing allowed
 *   archive_collection  end one early, or bring one back        never standing
 *
 * Every one touches only Athena's own records (athena_collection*): nothing
 * here sends, buys, or writes to another service. A standing approval for the
 * three item actions covers those records only.
 */
const collections = require("./index");
const entities = require("../entities");

const invalid = (message, hint) => Object.assign(new Error(message), { status: 400, code: "invalid_action_params", ...(hint ? { hint } : {}) });

function str(value, max) {
	if (typeof value !== "string") return null;
	const t = value.trim();
	return t ? t.slice(0, max) : null;
}

const list = (v) => (Array.isArray(v) ? v : typeof v === "string" && v.trim() ? [v] : []);

/** A collection by name, as a 400 the model can act on. */
async function collectionFor(profileId, name, opts) {
	try {
		return await collections.find(profileId, name, opts);
	} catch (err) {
		throw invalid(err.message, err.hint);
	}
}

/** One person from the roster, or a 400 saying who could be meant. */
async function personFor(profileId, phrase, recent) {
	const who = await entities.resolve(profileId, phrase, { recent });
	if (who.person) return { key: who.person.key, label: who.person.name };
	if (who.ambiguous) {
		const names = who.ambiguous.map((p) => p.name).join(" or ");
		throw invalid(`"${phrase}" could be ${names}`, `Ask them which one: ${names}.`);
	}
	throw invalid(
		`I don't know who "${phrase}" is yet`,
		"Ask them who that is. Someone new can be added by telling you about them first, so they're in their family memories."
	);
}

const rethrow = (fn) => async (...args) => {
	try {
		return await fn(...args);
	} catch (err) {
		if (err.code === "invalid_action_params") throw err;
		if (err.status === 400) throw invalid(err.message, err.hint);
		throw err;
	}
};

const forWho = (p) => (p.person_label ? ` for ${p.person_label}` : "");

module.exports = [
	{
		id: "define_collection",
		label: "Start a list or tracker",
		provider: null,
		consentType: null,
		reversible: true,
		// Each new kind of thing is the person's decision (design doc): never standing.
		standing: false,
		describe:
			"Start a new collection for them — a list, log or tracker of their own that you keep and show in the app: a Christmas " +
			'list ("tis the season, I need to get gifts for everyone"), a birthday list, a packing list, a home maintenance log. ' +
			"Check the Collections block first; to change what's in an existing one use add_item / update_item. A list about " +
			"people (gifts, birthdays, thank-you notes) is per-person: put the people you already know should be on it in " +
			'collection_people and, in your reply, name them and ask who else ("I\'ll start a list: Ashlynn, Skylar and Thomas — who else?"). ' +
			"Seasonal lists end when the season does (a Christmas list ends Dec 26).",
		params: {
			collection_name: 'Short name, e.g. "Christmas list 2026". Required.',
			collection_purpose: "One line on what it's for, in their words. Optional.",
			collection_per_person: "true when each entry is about a person (gifts, birthdays). Optional.",
			collection_people: 'For a per-person list: the people to start with, as they\'d say them ("Skylar", "my mom"). Optional.',
			collection_statuses: 'The stages an item moves through, first is the default, e.g. ["idea", "bought", "given"] or ["to do", "done"]. Optional.',
			collection_fields: 'Extra details each item can hold, each {name, type, choices, required}; type is text, number, money, date, yes_no, choice or link, e.g. [{"name": "price", "type": "money"}, {"name": "link", "type": "link"}]. Optional.',
			collection_capture: 'In plain words, what to notice for it in their conversations, e.g. "things a family member wants or is into". Optional.',
			collection_ends_on: "Last day it is active, YYYY-MM-DD; after it the card leaves Home and the list is kept in the archive. Optional.",
			collection_home: '"top" to put its card first on Home, "after" (default) to put it after the usual cards, "off" for no Home card.',
		},
		normalize: rethrow(async (raw = {}, ctx = {}) => {
			if (!ctx.profileId) throw invalid("A collection needs a person");
			const def = collections.normalizeDefinition({
				name: raw.collection_name,
				purpose: raw.collection_purpose,
				perPerson: raw.collection_per_person === true || raw.collection_per_person === "true",
				statuses: list(raw.collection_statuses),
				fields: Array.isArray(raw.collection_fields) ? raw.collection_fields : [],
				capture: raw.collection_capture,
				endsOn: raw.collection_ends_on || null,
				home: raw.collection_home,
			});
			const people = [];
			for (const phrase of list(raw.collection_people).slice(0, 30)) {
				const p = await personFor(ctx.profileId, String(phrase), ctx.recent);
				if (!people.some((q) => q.key === p.key)) people.push(p);
			}
			if (people.length && !def.perPerson) def.perPerson = true;
			const existing = await collections.listActive(ctx.profileId);
			if (existing.some((c) => c.slug === collections.slugify(def.name))) {
				throw invalid(`They already have "${def.name}"`, "Use add_item or update_item to change it instead.");
			}
			return {
				collection_name: def.name,
				definition: def,
				...(people.length ? { people } : {}),
			};
		}),
		summarize(p) {
			const who = p.people?.length ? `: ${p.people.map((x) => x.label).join(", ")}` : "";
			const until = p.definition?.endsOn ? `, until ${p.definition.endsOn}` : "";
			return `Start "${p.collection_name}"${who}${until}`;
		},
		async execute(profileId, params) {
			const { uuid, id } = await collections.create(profileId, params.definition, params.people || []);
			// Fill it from what she already knows, in the background: a list started
			// in the evening is already full of findings when it's opened.
			require("./capture")
				.backfill(profileId, id)
				.catch((err) => console.warn("[collections] backfill failed:", err.message));
			return { ref: uuid, detail: null };
		},
	},

	{
		id: "add_item",
		label: "Add to a list",
		provider: null,
		consentType: null,
		reversible: true,
		standing: true,
		describe:
			'Add something to one of their collections ("add a telescope for Thomas", "put the horse book on Skylar\'s list"), or add a ' +
			"person to a per-person list (collection_person with no collection_item — \"add Grandma to the Christmas list\"). Name the " +
			"collection as listed in the Collections block.",
		params: {
			collection: "The collection's name as listed. Required when they have more than one.",
			collection_person: "Who it's for, on a per-person list, as they said it. Optional.",
			collection_item: 'The thing to add, short ("Telescope"). Leave out to add only the person.',
			collection_item_status: "Its status, one of the collection's statuses. Optional; defaults to the first.",
			collection_item_values: 'Details for its fields, each {field, value}, e.g. [{"field": "price", "value": "120"}]. Optional.',
		},
		normalize: rethrow(async (raw = {}, ctx = {}) => {
			if (!ctx.profileId) throw invalid("Adding needs a person");
			const c = await collectionFor(ctx.profileId, raw.collection);
			const title = str(raw.collection_item, 200);
			const person = str(raw.collection_person, 120) ? await personFor(ctx.profileId, raw.collection_person, ctx.recent) : null;
			if (!title && !person) throw invalid("Say what to add, or who to add");
			if (title && c.def.perPerson && !person) throw invalid(`Who is it for? ${c.name} is kept per person`);
			let status = null;
			if (title) {
				status = (str(raw.collection_item_status, 24) || c.def.statuses[0]).toLowerCase();
				if (!c.def.statuses.includes(status)) throw invalid(`Status must be one of: ${c.def.statuses.join(", ")}`);
			}
			const fields = title ? collections.normalizeValues(c.def, raw.collection_item_values, { partial: false }) : {};
			return {
				collection_uuid: c.uuid,
				collection_name: c.name,
				...(person ? { person_key: person.key, person_label: person.label } : {}),
				...(title ? { item_title: title, item_status: status, item_fields: fields } : {}),
			};
		}),
		summarize(p) {
			return p.item_title ? `Add "${p.item_title}"${forWho(p)} to ${p.collection_name}` : `Add ${p.person_label} to ${p.collection_name}`;
		},
		async execute(profileId, p) {
			const c = await collections.byUuid(profileId, p.collection_uuid);
			let subjectId = null;
			if (p.person_key) {
				const s = (await collections.subjectFor(profileId, c.id, p.person_key)) || (await collections.addSubject(profileId, c.id, { key: p.person_key, label: p.person_label }));
				subjectId = s.id;
			}
			if (!p.item_title) return { ref: c.uuid, detail: null };
			// A thing already there (Athena may have suggested it) is kept, not duplicated.
			const same = (await collections.itemsOf(profileId, [c.id])).find(
				(i) => i.subjectId === subjectId && i.title.toLowerCase() === p.item_title.toLowerCase()
			);
			if (same) {
				await collections.updateItem(profileId, same.uuid, { status: p.item_status, fields: p.item_fields });
				return { ref: same.uuid, detail: null };
			}
			const uuid = await collections.addItem(profileId, c, { subjectId, title: p.item_title, status: p.item_status, fields: p.item_fields, sourceKind: "chat" });
			return { ref: uuid, detail: null };
		},
	},

	{
		id: "update_item",
		label: "Update a list",
		provider: null,
		consentType: null,
		reversible: true,
		standing: true,
		describe:
			'Change things on one of their collections: move items to another status ("we bought Skylar the horse book and a riding ' +
			'helmet" → both to "bought"), keep something you suggested, rename an item, fill in a detail, or tick a person off / back on a ' +
			"per-person list (collection_person + collection_person_done, no collection_item).",
		params: {
			collection: "The collection's name as listed. Required when they have more than one.",
			collection_person: "Whose item it is, or the person to tick off. Optional.",
			collection_item: "The item, as it appears in the list. Optional when only ticking a person.",
			collection_item_also: "More items getting the same status change, as listed. Optional.",
			collection_item_status: "The new status, one of the collection's statuses (keeping a suggestion = its first status). Optional.",
			collection_item_rename: "A new title for the item. Optional.",
			collection_item_values: "Details to set, each {field, value}. Optional.",
			collection_person_done: "true to tick the person off as done, false to untick. Optional.",
		},
		normalize: rethrow(async (raw = {}, ctx = {}) => {
			if (!ctx.profileId) throw invalid("Updating needs a person");
			const c = await collectionFor(ctx.profileId, raw.collection);
			let subject = null;
			let person = null;
			if (str(raw.collection_person, 120)) {
				person = await personFor(ctx.profileId, raw.collection_person, ctx.recent);
				subject = await collections.subjectFor(ctx.profileId, c.id, person.key);
				if (!subject) throw invalid(`${person.label} isn't on ${c.name}`, "Use add_item to add them first.");
			}
			const names = [str(raw.collection_item, 200), ...list(raw.collection_item_also).map((s) => str(String(s), 200))].filter(Boolean).slice(0, 10);
			const items = [];
			for (const name of names) {
				const item = await collections.findItem(ctx.profileId, c, name, { subjectId: subject?.id });
				if (!items.some((i) => i.uuid === item.uuid)) items.push({ uuid: item.uuid, title: item.title });
			}
			const status = str(raw.collection_item_status, 24)?.toLowerCase() || null;
			if (status && !c.def.statuses.includes(status)) throw invalid(`Status must be one of: ${c.def.statuses.join(", ")}`);
			const rename = str(raw.collection_item_rename, 200);
			if (rename && items.length !== 1) throw invalid("Rename one item at a time");
			const fields = raw.collection_item_values ? collections.normalizeValues(c.def, raw.collection_item_values, { partial: true }) : {};
			const done = raw.collection_person_done === true || raw.collection_person_done === "true" ? true : raw.collection_person_done === false || raw.collection_person_done === "false" ? false : null;
			if (done !== null && !subject) throw invalid("Say who to tick off");
			if (!items.length && done === null) throw invalid("Say which item to change, or who to tick off");
			if (items.length && !status && !rename && !Object.keys(fields).length) throw invalid("Say what to change about it");
			return {
				collection_uuid: c.uuid,
				collection_name: c.name,
				...(person ? { person_label: person.label } : {}),
				...(subject ? { subject_uuid: subject.uuid } : {}),
				...(items.length ? { items } : {}),
				...(status ? { item_status: status } : {}),
				...(rename ? { item_rename: rename } : {}),
				...(Object.keys(fields).length ? { item_fields: fields } : {}),
				...(done !== null ? { person_done: done } : {}),
			};
		}),
		summarize(p) {
			const parts = [];
			if (p.items?.length) {
				const what = p.items.map((i) => `"${i.title}"`).join(", ");
				if (p.item_status) parts.push(`mark ${what} ${p.item_status}`);
				if (p.item_rename) parts.push(`rename ${what} to "${p.item_rename}"`);
				if (p.item_fields) parts.push(`update ${what}`);
			}
			if (p.person_done === true) parts.push(`tick ${p.person_label} off`);
			if (p.person_done === false) parts.push(`untick ${p.person_label}`);
			const text = parts.join(" and ");
			return `${text[0].toUpperCase()}${text.slice(1)} on ${p.collection_name}`;
		},
		async execute(profileId, p) {
			for (const item of p.items || []) {
				await collections.updateItem(profileId, item.uuid, { status: p.item_status ?? null, title: p.item_rename ?? null, fields: p.item_fields });
			}
			if (p.person_done != null) await collections.setSubjectDone(profileId, p.subject_uuid, p.person_done);
			return { ref: p.collection_uuid, detail: null };
		},
	},

	{
		id: "remove_item",
		label: "Remove from a list",
		provider: null,
		consentType: null,
		reversible: true,
		standing: true,
		describe:
			'Take something off one of their collections ("drop the bike idea, Thomas already has one"), or take a person off a ' +
			"per-person list (collection_person with no collection_item). It's hidden with a 30-day undo, not deleted.",
		params: {
			collection: "The collection's name as listed. Required when they have more than one.",
			collection_person: "Whose item it is, or the person to take off. Optional.",
			collection_item: "The item, as it appears in the list. Leave out to remove the person.",
		},
		normalize: rethrow(async (raw = {}, ctx = {}) => {
			if (!ctx.profileId) throw invalid("Removing needs a person");
			const c = await collectionFor(ctx.profileId, raw.collection);
			let subject = null;
			let person = null;
			if (str(raw.collection_person, 120)) {
				person = await personFor(ctx.profileId, raw.collection_person, ctx.recent);
				subject = await collections.subjectFor(ctx.profileId, c.id, person.key);
				if (!subject) throw invalid(`${person.label} isn't on ${c.name}`);
			}
			const name = str(raw.collection_item, 200);
			if (!name && !subject) throw invalid("Say what to remove, or who");
			const item = name ? await collections.findItem(ctx.profileId, c, name, { subjectId: subject?.id }) : null;
			return {
				collection_uuid: c.uuid,
				collection_name: c.name,
				...(person ? { person_label: person.label } : {}),
				...(item ? { item_uuid: item.uuid, item_title: item.title } : { subject_uuid: subject.uuid }),
			};
		}),
		summarize(p) {
			return p.item_title ? `Remove "${p.item_title}"${forWho(p)} from ${p.collection_name}` : `Take ${p.person_label} off ${p.collection_name}`;
		},
		async execute(profileId, p) {
			if (p.item_uuid) await collections.removeItem(profileId, p.item_uuid);
			else await collections.removeSubject(profileId, p.subject_uuid);
			return { ref: p.collection_uuid, detail: null };
		},
	},

	{
		id: "archive_collection",
		label: "End or reopen a list",
		provider: null,
		consentType: null,
		reversible: true,
		standing: false,
		describe:
			'End one of their collections early so it leaves Home and goes to the archive ("we\'re done with the Christmas list"), or ' +
			"bring an archived one back (collection_restore). Lists with an end date archive themselves; this is for doing it by hand.",
		params: {
			collection: "The collection's name. Required.",
			collection_restore: "true to bring an archived collection back. Optional.",
		},
		normalize: rethrow(async (raw = {}, ctx = {}) => {
			if (!ctx.profileId) throw invalid("Archiving needs a person");
			const restore = raw.collection_restore === true || raw.collection_restore === "true";
			const c = await collectionFor(ctx.profileId, raw.collection, { includeArchived: restore });
			if (restore && !c.archived) throw invalid(`${c.name} is already active`);
			return { collection_uuid: c.uuid, collection_name: c.name, restore };
		}),
		summarize(p) {
			return p.restore ? `Bring back ${p.collection_name}` : `Archive ${p.collection_name}`;
		},
		async execute(profileId, p) {
			const c = await collections.byUuid(profileId, p.collection_uuid);
			await collections.setArchived(profileId, c.id, !p.restore);
			return { ref: c.uuid, detail: null };
		},
	},
];
