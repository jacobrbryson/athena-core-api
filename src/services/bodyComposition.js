/**
 * Body composition Athena works out herself, from what a bioimpedance scale
 * sends: weight, whole-body impedance, height, age and sex.
 *
 * VeSync stores only weight, body fat and impedance; its app derives the rest
 * on the phone with Etekcity's unpublished formula. These are published,
 * population-validated equations instead, so the numbers will not match the
 * VeSync app — and every one is marked as Athena's estimate.
 *
 *   Fat-free mass, total body water — Sun SS et al., "Development of
 *     bioelectrical impedance analysis prediction equations for body
 *     composition with the use of a multicomponent model for use in
 *     epidemiologic surveys", Am J Clin Nutr 2003;77:331-340 (NHANES III).
 *   Skeletal muscle mass — Janssen I et al., "Estimation of skeletal muscle
 *     mass by bioelectrical impedance analysis", J Appl Physiol
 *     2000;89:465-471.
 *   Resting energy (BMR) — Katch-McArdle, 370 + 21.6 x fat-free mass.
 *
 * Bone mass, visceral fat, protein and "metabolic age" have no sound
 * published equation from these inputs and are not invented here.
 *
 * Calibration: a reference measurement (DEXA, InBody, a measured height)
 * corrects every reading. A percentage is shifted by the difference the
 * reference showed against the nearest weigh-in; a mass is scaled by the
 * ratio. The newest reference for each measure wins.
 */

/** Plausible whole-body impedance at 50 kHz, in ohms. Outside it, no estimate. */
const IMPEDANCE_RANGE = [150, 1500];
/** A reference within this many days of a weigh-in can calibrate against it. */
const CALIBRATION_WINDOW_DAYS = 7;

const round = (value, places = 1) =>
	value === null || value === undefined || !Number.isFinite(value) ? null : Math.round(value * 10 ** places) / 10 ** places;

/**
 * Estimates for one weigh-in. Returns only what the inputs support; a missing
 * input leaves its estimates null rather than guessed.
 *
 * @param {{ weightKg, heightCm, impedance, age, sex: 'male'|'female'|null, bodyFatPercent }} input
 */
function estimate({ weightKg, heightCm, impedance, age, sex, bodyFatPercent }) {
	const out = { fat_free_mass_kg: null, body_fat_percent: null, body_water_percent: null, skeletal_muscle_kg: null, bmr_kcal: null, estimated: [] };
	if (!(weightKg > 0)) return out;
	const male = sex === "male" ? 1 : sex === "female" ? 0 : null;
	const usable = impedance >= IMPEDANCE_RANGE[0] && impedance <= IMPEDANCE_RANGE[1] && heightCm > 100 && heightCm < 250 && male !== null;
	const index = usable ? heightCm ** 2 / impedance : null; // the "impedance index", cm²/Ω

	// Fat-free mass: the scale's own body fat wins when it sent one, so the
	// two never disagree on the same page. Otherwise Sun 2003.
	if (bodyFatPercent > 0 && bodyFatPercent < 75) {
		out.fat_free_mass_kg = weightKg * (1 - bodyFatPercent / 100);
	} else if (usable) {
		const ffm = male ? -10.68 + 0.65 * index + 0.26 * weightKg + 0.02 * impedance : -9.53 + 0.69 * index + 0.17 * weightKg + 0.02 * impedance;
		if (ffm > 0.3 * weightKg && ffm < weightKg) {
			out.fat_free_mass_kg = ffm;
			out.body_fat_percent = (1 - ffm / weightKg) * 100;
			out.estimated.push("body_fat_percent");
		}
	}

	if (usable) {
		const tbw = male ? 1.2 + 0.45 * index + 0.18 * weightKg : 3.75 + 0.45 * index + 0.11 * weightKg;
		if (tbw > 0.3 * weightKg && tbw < 0.8 * weightKg) {
			out.body_water_percent = (tbw / weightKg) * 100;
			out.estimated.push("body_water_percent");
		}
		if (age > 0) {
			const smm = 0.401 * index + 3.825 * male - 0.071 * age + 5.102;
			if (smm > 0.15 * weightKg && smm < 0.65 * weightKg) {
				out.skeletal_muscle_kg = smm;
				out.estimated.push("skeletal_muscle_kg");
			}
		}
	}
	if (out.fat_free_mass_kg !== null) {
		out.bmr_kcal = 370 + 21.6 * out.fat_free_mass_kg;
		out.estimated.push("fat_free_mass_kg", "bmr_kcal");
	}
	return out;
}

/** Measures a reference can correct, and how. */
const CALIBRATED = {
	body_fat_percent: "shift",
	body_water_percent: "shift",
	skeletal_muscle_kg: "scale",
	fat_free_mass_kg: "scale",
};

/**
 * Turn references into corrections against the weigh-ins they sit beside.
 *
 * @param {object[]} weighIns  uncorrected, any order, each with `at` and the measures
 * @param {object[]} references newest first: { uuid, measured_on, source, height_cm, body_fat_percent, ... }
 * @returns {{ heightCm: number|null, corrections: Record<string, {kind, amount, uuid, source, measured_on}>, unmatched: string[] }}
 */
function corrections(weighIns, references) {
	const result = { heightCm: null, corrections: {}, unmatched: [] };
	for (const ref of references || []) {
		if (result.heightCm === null && ref.height_cm > 0) result.heightCm = Number(ref.height_cm);
		for (const [field, kind] of Object.entries(CALIBRATED)) {
			const truth = ref[field] === null || ref[field] === undefined ? null : Number(ref[field]);
			if (truth === null || !Number.isFinite(truth) || result.corrections[field]) continue;
			const day = Date.parse(`${String(ref.measured_on).slice(0, 10)}T12:00:00Z`);
			const nearest = (weighIns || [])
				.filter((w) => w[field] !== null && w[field] !== undefined)
				.map((w) => ({ w, gap: Math.abs(Date.parse(w.at) - day) }))
				.filter(({ gap }) => gap <= CALIBRATION_WINDOW_DAYS * 86400_000)
				.sort((a, b) => a.gap - b.gap)[0];
			if (!nearest) {
				result.unmatched.push(field);
				continue;
			}
			const seen = nearest.w[field];
			const amount = kind === "shift" ? truth - seen : seen > 0 ? truth / seen : null;
			if (amount === null || !Number.isFinite(amount)) continue;
			result.corrections[field] = { kind, amount, uuid: ref.uuid, source: ref.source || null, measured_on: String(ref.measured_on).slice(0, 10) };
		}
	}
	return result;
}

function apply(weighIn, correctionSet) {
	const out = { ...weighIn, calibrated: [] };
	for (const [field, c] of Object.entries(correctionSet.corrections)) {
		if (out[field] === null || out[field] === undefined) continue;
		out[field] = c.kind === "shift" ? out[field] + c.amount : out[field] * c.amount;
		out.calibrated.push(field);
	}
	return out;
}

/**
 * The full pipeline over a set of raw weigh-ins (connectors/vesync.js
 * normalize() output): estimate, then correct, then derive what depends on
 * corrected values (BMI from the reference height, BMR from corrected
 * fat-free mass).
 */
function enrich(weighIns, references = []) {
	const estimated = (weighIns || []).map((w) => {
		const e = estimate({ weightKg: w.weight_kg, heightCm: w.height_cm, impedance: w.impedance_ohm, age: w.age, sex: w.sex, bodyFatPercent: w.body_fat_percent });
		return {
			...w,
			body_fat_percent: w.body_fat_percent ?? e.body_fat_percent,
			fat_free_mass_kg: w.fat_free_mass_kg ?? e.fat_free_mass_kg,
			body_water_percent: w.body_water_percent ?? e.body_water_percent,
			skeletal_muscle_kg: w.skeletal_muscle_kg ?? e.skeletal_muscle_kg,
			bmr_kcal: w.bmr_kcal ?? e.bmr_kcal,
			estimated: e.estimated.filter((f) => w[f] === null || w[f] === undefined),
		};
	});
	const set = corrections(estimated, references);
	const enriched = estimated.map((w) => {
		const c = apply(w, set);
		// Corrected fat-free mass moves BMR with it; Katch-McArdle is linear in it.
		if (c.calibrated.includes("fat_free_mass_kg") || c.calibrated.includes("body_fat_percent")) {
			if (c.calibrated.includes("body_fat_percent") && !c.calibrated.includes("fat_free_mass_kg") && c.body_fat_percent !== null) {
				c.fat_free_mass_kg = c.weight_kg * (1 - c.body_fat_percent / 100);
			}
			if (c.fat_free_mass_kg !== null) c.bmr_kcal = 370 + 21.6 * c.fat_free_mass_kg;
		}
		const heightCm = set.heightCm || c.height_cm;
		if (heightCm > 0) c.bmi = c.weight_kg / (heightCm / 100) ** 2;
		for (const field of ["body_fat_percent", "body_water_percent", "skeletal_muscle_kg", "fat_free_mass_kg", "bmi"]) c[field] = round(c[field]);
		c.bmr_kcal = round(c.bmr_kcal, 0);
		c.skeletal_muscle_percent = c.skeletal_muscle_kg ? round((c.skeletal_muscle_kg / c.weight_kg) * 100) : null;
		return c;
	});
	return { weighIns: enriched, calibration: { heightCm: set.heightCm, corrections: set.corrections, unmatched: set.unmatched } };
}

module.exports = { estimate, corrections, enrich, CALIBRATION_WINDOW_DAYS, IMPEDANCE_RANGE };
