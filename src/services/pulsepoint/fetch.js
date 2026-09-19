/**
 * Getting the active incident list for an agency out of PulsePoint.
 *
 * ## Why this is not a news source
 *
 * `web.pulsepoint.org` serves a 1.3 KB shell and builds everything in the
 * browser, so the news watcher — which reads finished HTML and honours
 * robots.txt — can never see a single incident on it. That is not a bug to
 * fix there. It is the reason this file exists.
 *
 * ## What the response looks like
 *
 * Their own web client calls `api.pulsepoint.org/v1/webapp?resource=incidents`
 * and gets back `{ct, iv, s}`: AES-256-CBC ciphertext, an IV, and a salt. The
 * key comes from a passphrase their client assembles at runtime out of
 * characters of a string literal, then stretches with OpenSSL's EvpKDF (MD5,
 * one iteration) over the salt. All of that ships in the clear in their public
 * bundle — there is no secret here and nothing is being defeated. We rebuild
 * the same passphrase the same way so we can read a response addressed to any
 * browser that asks.
 *
 * The double JSON.parse at the end is theirs too: the plaintext is a JSON
 * string *containing* JSON.
 *
 * ## Being a good neighbour
 *
 * This is an undocumented endpoint belonging to someone else, serving public
 * safety data at their expense. So: one request per poll, well below the rate
 * their own web app uses, an honest User-Agent, a hard timeout, a capped read,
 * and a cache the caller is expected to lean on. If they ever ask us to stop,
 * the polite answer is to stop.
 */
const https = require("node:https");
const crypto = require("node:crypto");

const HOST = "api.pulsepoint.org";
const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

const USER_AGENT =
	process.env.PULSEPOINT_USER_AGENT ||
	"AthenaNearbyIncidents/1.0 (personal household alerting; one agency; low rate)";

/**
 * Rebuild the passphrase exactly as their client does.
 *
 * Written out character by character rather than inlined as a literal so that
 * the next person to read this can check it against their bundle without
 * having to trust a magic string. If they change it, this is the one function
 * that changes.
 */
function passphrase() {
	const source = "CommonIncidents";
	return (
		source.charAt(13) +
		source.charAt(1) +
		source.charAt(2) +
		"brady" +
		String(5) +
		"r" +
		source.toLowerCase().charAt(6) +
		source.charAt(5) +
		"gs"
	);
}

/**
 * OpenSSL's EVP_BytesToKey with MD5 and a single iteration — what CryptoJS
 * does when you hand it a passphrase and a salt. 32 bytes of key, then 16 of
 * IV.
 */
function deriveKeyAndIv(pass, salt) {
	let material = Buffer.alloc(0);
	let block = Buffer.alloc(0);
	while (material.length < 48) {
		block = crypto
			.createHash("md5")
			.update(Buffer.concat([block, Buffer.from(pass, "utf8"), salt]))
			.digest();
		material = Buffer.concat([material, block]);
	}
	return { key: material.subarray(0, 32), iv: material.subarray(32, 48) };
}

/**
 * `{ct, iv, s}` -> the object inside.
 *
 * The IV on the wire is preferred over the derived one — they are the same in
 * every response seen so far, but the wire value is what their client's cipher
 * params carry, so following it is the behaviour that keeps working if the two
 * ever diverge. The derived IV is the fallback.
 */
function decryptPayload(body) {
	let envelope;
	try {
		envelope = JSON.parse(body);
	} catch {
		throw new Error("PulsePoint sent something that is not JSON.");
	}
	if (!envelope || !envelope.ct || !envelope.s) {
		throw new Error("PulsePoint response is missing its ciphertext or salt.");
	}

	const salt = Buffer.from(envelope.s, "hex");
	const ciphertext = Buffer.from(envelope.ct, "base64");
	const derived = deriveKeyAndIv(passphrase(), salt);
	const ivs = [];
	if (envelope.iv) ivs.push(Buffer.from(envelope.iv, "hex"));
	ivs.push(derived.iv);

	let lastError = null;
	for (const iv of ivs) {
		try {
			const decipher = crypto.createDecipheriv("aes-256-cbc", derived.key, iv);
			const plaintext = Buffer.concat([
				decipher.update(ciphertext),
				decipher.final(),
			]).toString("utf8");
			// Theirs is a JSON string containing JSON; tolerate either shape.
			const once = JSON.parse(plaintext);
			return typeof once === "string" ? JSON.parse(once) : once;
		} catch (error) {
			lastError = error;
		}
	}
	throw new Error(
		`Could not read PulsePoint's response: ${lastError ? lastError.message : "unknown"}`,
	);
}

/** The raw body of one GET, with a timeout and a cap on how much we will read. */
function get(path) {
	return new Promise((resolve, reject) => {
		const request = https.request(
			{
				host: HOST,
				path,
				method: "GET",
				headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
				timeout: TIMEOUT_MS,
			},
			(response) => {
				if (response.statusCode !== 200) {
					response.resume();
					reject(new Error(`PulsePoint answered ${response.statusCode}.`));
					return;
				}
				let size = 0;
				const chunks = [];
				response.on("data", (chunk) => {
					size += chunk.length;
					if (size > MAX_BYTES) {
						request.destroy();
						reject(new Error("PulsePoint sent more than we agreed to read."));
						return;
					}
					chunks.push(chunk);
				});
				response.on("end", () =>
					resolve(Buffer.concat(chunks).toString("utf8")),
				);
			},
		);
		request.on("timeout", () => {
			request.destroy();
			reject(new Error("PulsePoint did not answer in time."));
		});
		request.on("error", reject);
		request.end();
	});
}

/** An agency id is short and alphanumeric; anything else is not going in a URL. */
function agencyId(value) {
	const id = String(value || "")
		.trim()
		.toUpperCase();
	if (!/^[A-Z0-9]{1,12}$/.test(id)) {
		throw Object.assign(
			new Error("That does not look like a PulsePoint agency id."),
			{ status: 400 },
		);
	}
	return id;
}

/**
 * Active and recent incidents for one agency, decrypted.
 *
 * Returns the payload as they shape it — `{incidents: {active: [], recent: []}}`
 * — and deliberately does not reshape it here. Normalising into our own
 * incident type is `normalise.js`, so that the day their schema shifts there is
 * exactly one file to look at.
 */
async function fetchIncidents(agency) {
	const id = agencyId(agency);
	const body = await get(`/v1/webapp?resource=incidents&agencyid=${id}`);
	return decryptPayload(body);
}

module.exports = {
	fetchIncidents,
	decryptPayload,
	passphrase,
	deriveKeyAndIv,
	agencyId,
};
