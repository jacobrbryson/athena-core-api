/**
 * What Athena is genuinely doing right now, for the avatar to act out.
 *
 * The rule: an activity is announced only while the work is happening. It is
 * emitted around a real read — the calendar or inbox fetch a reply is waiting
 * on — and ends when that read does. Nothing here is a timer, an animation
 * schedule, or a guess, so when the avatar shows her at the calendar she is at
 * the calendar. When nothing is running she is idle, and idle is not an
 * activity.
 *
 * Only a category goes out ("calendar", "email"), never a title, sender or
 * subject: the avatar sits on a screen other people can glance at.
 *
 * Read-only observation. It never gates a read, never fails one, and cannot
 * start anything; a throw in here is swallowed.
 */
const sessionParticipants = require("./sessionParticipant");

/** Connector provider → the activity the avatar shows. Others stay unshown. */
const ACTIVITY_FOR_PROVIDER = {
	google_calendar: "calendar",
	gmail: "email",
};

function activityFor(provider) {
	return ACTIVITY_FOR_PROVIDER[provider] || null;
}

/**
 * A reporter for one reply. `onRead(provider)` marks the start of a real read
 * and returns the function that marks its end. Two reads of the same activity
 * (keyword gate plus the fast guess) share one start and one end.
 *
 * Silent unless the conversation is this person's alone: a shared session's
 * sockets include other people, and "checking your email" is not theirs to see.
 */
function reporter({ session, clients, guardian = false }) {
	const noop = () => () => {};
	if (!session || guardian || session.profile_id == null) return { onRead: noop };

	const open = new Map(); // activity -> reads in flight
	let alone = null; // resolved lazily, once

	const send = (payload) => {
		const sockets = clients?.get(session.uuid);
		if (!sockets) return;
		const serialized = JSON.stringify(payload);
		for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(serialized);
	};

	const isAlone = async () => {
		if (alone === null) {
			alone = await sessionParticipants
				.presentParticipants(session.id)
				.then((rows) => rows.length <= 1)
				.catch(() => false);
		}
		return alone;
	};

	const onRead = (provider) => {
		const activity = activityFor(provider);
		if (!activity) return () => {};
		let ended = false;
		let started = false;
		const begun = isAlone()
			.then((ok) => {
				if (!ok || ended) return;
				const n = (open.get(activity) || 0) + 1;
				open.set(activity, n);
				started = true;
				if (n === 1) send({ rpc: "activity", activity, state: "start" });
			})
			.catch(() => {});
		return () => {
			ended = true;
			void begun.then(() => {
				if (!started) return;
				started = false;
				const n = (open.get(activity) || 1) - 1;
				if (n <= 0) {
					open.delete(activity);
					send({ rpc: "activity", activity, state: "end" });
				} else {
					open.set(activity, n);
				}
			});
		};
	};

	return { onRead };
}

module.exports = { reporter, activityFor, ACTIVITY_FOR_PROVIDER };
