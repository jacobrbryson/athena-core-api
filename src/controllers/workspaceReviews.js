const { requireAdultActor } = require("../helpers/actor");
const reviews = require("../services/workspaceReviews");
const dispatch = require("../services/guardianEngine/dispatch");
function handler(run) {
  return async (req, res) => {
    res.set("Cache-Control", "no-store");
    const actor = await requireAdultActor(req, res);
    if (!actor) return;
    if (req.user?.kind === "device" || req.user?.kind === "child")
      return res
        .status(403)
        .json({
          message: "Use your signed-in Companion browser for company reviews.",
        });
    try {
      return res.json(await run(actor, req));
    } catch (e) {
      if (!e.status)
        console.warn(
          "[workspaceReviews] request failed:",
          e.code || "unavailable",
        );
      return res
        .status(e.status || 503)
        .json({
          message: e.status
            ? e.message
            : "Company reviews are unavailable. Check migrations 0104, 0105 and 0106 and try again.",
        });
    }
  };
}
/**
 * POST /internal/workspace-review/pass — not a person's route. Cloud Tasks
 * call it with a Google-signed ID token for an allowed service account. The
 * body names one draft and pass; the owner and key come from that draft. Past
 * the caller check it always answers 200, because a retried pass could be
 * billed twice: a failure is recorded on the draft instead.
 */
async function pass(req, res, { verify = dispatch.verifyCaller, run = reviews.runPass } = {}) {
  res.set("Cache-Control", "no-store");
  if (!(await verify(req)))
    return res.status(401).json({ message: "Unauthorized" });
  const match = /^([0-9a-f-]{36}):(\d{1,3})$/.exec(String(req.body?.reason || ""));
  if (!match) return res.status(400).json({ message: "Invalid pass." });
  try {
    return res.json({ ran: await run(match[1], Number(match[2])) });
  } catch (e) {
    console.error("[workspaceReviews] pass failed:", e?.code || "unavailable");
    return res.json({ ran: false });
  }
}
module.exports = {
  pass: (req, res) => pass(req, res),
  passWith: pass,
  status: handler((a, r) =>
    reviews.status(
      a.profileId,
      r.params.uuid,
      r.query.repository,
      r.query.number,
    ),
  ),
  settings: handler((a, r) => reviews.settings(a.profileId, r.params.uuid)),
  saveSettings: handler((a, r) =>
    reviews.saveSettings(a.profileId, r.params.uuid, r.body || {}),
  ),
  criteria: handler((a, r) =>
    reviews.criteria(a.profileId, r.params.uuid, r.query.repository),
  ),
  saveCriteria: handler((a, r) =>
    reviews.saveCriteria(
      a.profileId,
      r.params.uuid,
      r.body?.repository,
      r.body?.criteria,
    ),
  ),
  detail: handler((a, r) =>
    reviews.detail(
      a.profileId,
      r.params.uuid,
      r.query.repository,
      r.query.number,
    ),
  ),
  generate: handler((a, r) =>
    reviews.generate(a.profileId, r.params.uuid, r.body || {}),
  ),
  propose: handler(async (a, r) => {
    const result = await require("../services/actions").attempt(
      a.profileId,
      null,
      {
        id: "submit_workspace_review",
        params: { ...(r.body || {}), workplace_uuid: r.params.uuid },
      },
      { familyId: a.familyId },
    );
    if (result.rejected)
      throw Object.assign(new Error(result.rejected.reason), { status: 409 });
    return { action: result.proposal || result.repeat };
  }),
};
