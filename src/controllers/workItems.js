const { randomUUID } = require("node:crypto");
const { requireAdultActor } = require("../helpers/actor");
const pool = require("../helpers/db");
const store = require("../services/workItems/store");
const engine = require("../services/workItems/engine");
const jira = require("../services/workItems/jira");
const v = require("../services/workItems/validation");
const { Storage } = require("@google-cloud/storage");
const reviews = require("../services/workspaceReviews");
const storage = new Storage();
function handler(fn, runner = false) {
  return async (req, res) => {
    res.set("Cache-Control", "no-store");
    const actor = await requireAdultActor(req, res);
    if (!actor) return;
    try {
      // A runner token is a file on someone's disk: it may only drive leased jobs,
      // never configure environments, keys, runs, approvals or read issues/artifacts.
      if (runner && req.user?.kind !== "device")
        throw v.bad("Use a paired local runner.", 403);
      if (!runner && req.user?.kind === "device")
        throw v.bad("Use your signed-in Companion browser for this.", 403);
      const result = await fn(actor, req, res);
      if (!res.headersSent) res.json(result ?? { success: true });
    } catch (e) {
      if (res.headersSent) return res.destroy();
      res
        .status(e.status || 503)
        .json({
          message: e.status
            ? e.message
            : "Work service unavailable. Check server configuration and migration 0099.",
        });
    }
  };
}
const lease = (actor, req) =>
  store.leased(
    actor.profileId,
    req.params.uuid,
    req.user.deviceUuid,
    req.headers["x-work-lease"],
  );
const issueRead = handler((a, r) =>
  jira.read(a.profileId, r.query.url, r.query.credential, r.query.field),
);
const commentRead = handler(async (a, r) => {
  const i = await jira.read(a.profileId, r.query.url, r.query.credential);
  return jira.comments(a.profileId, i, r.query.start);
});
const setup = handler(async (a) => ({
  environments: await store.environments(a.profileId),
  workplaces: (await require("../services/workplaces").overview(a.profileId))
    .workplaces,
  credentials: await require("../services/credentials").list(a.profileId),
  devices: await require("../services/devices").listDevices(a.profileId),
}));
const saveEnvironment = handler(async (a, r) => ({
  uuid: await store.saveEnvironment(a.profileId, r.body),
}));
const saveKey = handler(async (a, r) => {
  const w = await store.workplace(a.profileId, r.body.workplaceUuid);
  if (!["github", "openai", "anthropic", "work_login"].includes(r.body.provider))
    throw v.bad("Unsupported work provider.");
  // A demo test login keeps its username as the visible name; only the
  // password is the encrypted secret.
  const login = r.body.provider === "work_login";
  const c = await require("../services/credentials").put({
    profileId: a.profileId,
    provider: r.body.provider,
    kind: "api_key",
    externalAccountId: `workplace:${w.uuid}`,
    displayName: login
      ? v.text(r.body.username, 160, "Test login username")
      : `${w.name} · ${r.body.provider}`,
    accessToken: v.text(r.body.key, 2000, login ? "Test login password" : "API key"),
    actor: "work-setup",
  });
  await require("../services/workplaces").link(a.profileId, w.uuid, {
    credential: c.uuid,
  });
  return { credential: c };
});
const revokeKey = handler(async (a, r) => {
  const meta = await store.credential(
    a.profileId,
    r.body.workplaceUuid,
    r.params.credentialUuid,
    r.body.provider,
  );
  return require("../services/credentials").revoke(
    a.profileId,
    r.body.provider,
    { externalAccountId: meta.external_account_id, actor: "work-setup" },
  );
});
const createRun = handler((a, r) =>
  store.create(a.profileId, r.body.environmentUuid, r.body.url),
);
const getRun = handler((a, r) => store.get(a.profileId, r.params.uuid));
const listRuns = handler((a) => store.list(a.profileId));
const propose = handler(async (a, r) => {
  const run = await store.get(a.profileId, r.params.uuid);
  const implementing = r.body.kind === "implement";
  const result = await require("../services/actions").attempt(
    a.profileId,
    null,
    {
      id: implementing ? "implement_work_item" : "plan_work_item",
      params: {
        run_uuid: run.uuid,
        ...(implementing ? { plan_hash: r.body.planHash } : {}),
      },
    },
    { familyId: a.familyId },
  );
  if (result.rejected) throw v.bad(result.rejected.reason, 409);
  return { action: result.proposal || result.repeat };
});
const stop = handler((a, r) => store.stop(a.profileId, r.params.uuid));
const claim = handler(async (a, r) => {
  // Lease loss never silently replays a side effect; require a new reviewed run.
  await pool.query(
    "UPDATE athena_work_run SET phase='blocked',reason='Runner disconnected or lease expired. Inspect retained checkout and start a fresh approved run.',lease_token=NULL,notified_at=NULL WHERE profile_id=? AND phase IN ('preparing','planning','implementing','verifying','recording_demo') AND lease_until<UTC_TIMESTAMP()",
    [a.profileId],
  );
  await engine.notify(a.profileId).catch(() => undefined);
  return { run: await store.claim(a.profileId, r.user.deviceUuid) };
}, true);
const claimReviewCheck = handler(
  async (a, r) => ({
    check: await reviews.claimCheck(a.profileId, r.user.deviceUuid),
  }),
  true,
);
const finishReviewCheck = handler(
  (a, r) =>
    reviews.finishCheck(
      a.profileId,
      r.user.deviceUuid,
      r.params.uuid,
      r.body || {},
    ),
  true,
);
const heartbeat = handler(
  async (a, r) => ({
    active: await store.heartbeat(
      a.profileId,
      r.params.uuid,
      r.user.deviceUuid,
      r.headers["x-work-lease"],
    ),
  }),
  true,
);
const transition = handler(async (a, req) => {
  const r = await lease(a, req),
    body = req.body;
  if (body.kind === "blocked") {
    await pool.query(
      "UPDATE athena_work_run SET phase='blocked',reason=?,lease_token=NULL,lease_until=NULL,notified_at=NULL WHERE uuid=? AND lease_token=?",
      [v.text(body.reason, 500, "Blocked reason"), r.uuid, r.lease_token],
    );
  } else if (body.kind === "baseline" && r.phase === "preparing") {
    if (body.ok !== true)
      throw v.bad("Baseline checks must pass before planning.");
    await pool.query(
      "UPDATE athena_work_run SET phase='planning',checkpoint=? WHERE uuid=? AND lease_token=?",
      [JSON.stringify(body.evidence || {}), r.uuid, r.lease_token],
    );
  } else if (
    body.kind === "verification" &&
    r.phase === "verifying" &&
    body.ok === true
  ) {
    await pool.query(
      "UPDATE athena_work_run SET phase='recording_demo' WHERE uuid=? AND lease_token=?",
      [r.uuid, r.lease_token],
    );
  } else if (body.kind === "complete" && r.phase === "recording_demo") {
    const [art] = await pool.query(
      "SELECT mime FROM athena_work_artifact WHERE run_uuid=?",
      [r.uuid],
    );
    if (
      !art.some((x) => x.mime === "video/mp4") ||
      !art.some((x) => x.mime === "text/x-diff")
    )
      throw v.bad("Upload the narrated demo and patch before completion.");
    await pool.query(
      "UPDATE athena_work_run SET phase='ready_for_review',lease_token=NULL,lease_until=NULL,notified_at=NULL WHERE uuid=? AND lease_token=?",
      [r.uuid, r.lease_token],
    );
  } else throw v.bad("Invalid run transition.", 409);
  await store.event(r.uuid, body.kind, {
    ok: body.ok === true,
    text: String(body.evidence || body.reason || "").slice(0, 18000),
  });
  await engine.notify(a.profileId).catch(() => undefined);
  return store.get(a.profileId, r.uuid);
}, true);
const step = handler(async (a, req) => {
  const r = await lease(a, req);
  if (!["planning", "implementing"].includes(r.phase))
    throw v.bad("This run is not accepting model operations.", 409);
  if (r.implementation_uuid && !r.comment_id)
    throw v.bad("Post the approved plan to Jira first.", 409);
  return engine.step(r, req.body.observation);
}, true);
const comment = handler(
  async (a, r) => ({ id: await engine.postPlan(await lease(a, r)) }),
  true,
);
const backup = handler(async (a, req, res) => {
  const r = await lease(a, req);
  if (r.phase !== "preparing")
    throw v.bad("Backup reads are only allowed during preparation.", 409);
  const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(r.config.backup);
  const file = storage.bucket(m[1]).file(m[2]);
  const [meta] = await file.getMetadata();
  if (Number(meta.size) > 20 * 1024 ** 3)
    throw v.bad(
      "Backup exceeds the 20 GiB first-version limit. Prepare a smaller sterilized export.",
      409,
    );
  await store.event(r.uuid, "backup", {
    object: r.config.backup,
    generation: meta.generation,
    bytes: meta.size,
    crc32c: meta.crc32c,
  });
  res.type("application/octet-stream");
  await require("node:stream/promises").pipeline(
    storage
      .bucket(m[1])
      .file(m[2], { generation: meta.generation })
      .createReadStream({ validation: "crc32c" }),
    res,
  );
}, true);
const source = handler(async (a, req, res) => {
  const r = await lease(a, req);
  if (r.phase !== "preparing")
    throw v.bad("Source downloads are only allowed during preparation.", 409);
  const repo = r.config.repositories.find(
    (x) => x.name === req.params.repository,
  );
  if (!repo) throw v.bad("Repository is outside this environment.", 403);
  const c = await store.credential(
    a.profileId,
    r.workplace_uuid,
    r.config.githubCredentialUuid,
    "github",
    true,
  );
  const headers = {
    Authorization: `Bearer ${c.accessToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const commit = await fetch(
    `https://api.github.com/repos/${repo.full}/commits/${encodeURIComponent(repo.ref)}`,
    { headers, redirect: "error", signal: AbortSignal.timeout(30000) },
  );
  if (!commit.ok)
    throw v.bad(
      `GitHub access failed (HTTP ${commit.status}). Check the company token and organization authorization.`,
      502,
    );
  const sha = (await commit.json()).sha;
  if (!/^[a-f0-9]{40}$/.test(sha))
    throw v.bad("GitHub returned an invalid commit.", 502);
  const archive = await fetch(
    `https://api.github.com/repos/${repo.full}/tarball/${sha}`,
    { headers, redirect: "manual", signal: AbortSignal.timeout(30000) },
  );
  const url = new URL(archive.headers.get("location") || "https://invalid");
  if (
    url.protocol !== "https:" ||
    url.hostname !== "codeload.github.com" ||
    url.username ||
    url.password
  )
    throw v.bad("Unexpected GitHub archive destination.", 502);
  const data = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(120000),
  });
  if (!data.ok) throw v.bad("GitHub archive unavailable.", 502);
  await store.event(r.uuid, "source", { repository: repo.name, sha });
  res.set("X-Work-Commit", sha).type("application/octet-stream");
  await require("node:stream/promises").pipeline(
    require("node:stream").Readable.fromWeb(data.body),
    res,
  );
}, true);
function artifactFile(name) {
  const bucket = process.env.WORK_ARTIFACT_BUCKET;
  if (!bucket)
    throw v.bad(
      "Configure WORK_ARTIFACT_BUCKET for private work artifacts.",
      503,
    );
  return storage.bucket(bucket).file(name);
}
const upload = handler(async (a, req) => {
  const r = await lease(a, req);
  if (!r.implementation_uuid || r.phase !== "recording_demo")
    throw v.bad(
      "Artifacts require an approved implementation in its evidence phase.",
      409,
    );
  const types = {
    "video/mp4": "demo.mp4",
    "text/x-diff": "changes.patch",
    "application/json": "evidence.json",
  };
  const mime = req.headers["content-type"];
  if (mime === "application/json" && req.body && !Buffer.isBuffer(req.body))
    req.body = Buffer.from(JSON.stringify(req.body));
  if (!types[mime] || !Buffer.isBuffer(req.body) || !req.body.length)
    throw v.bad("Unsupported or empty work artifact.");
  const uuid = randomUUID(),
    name = `work/${a.profileId}/${r.uuid}/${uuid}`;
  await artifactFile(name).save(req.body, {
    resumable: false,
    contentType: mime,
    metadata: { cacheControl: "private, no-store" },
  });
  await pool.query(
    "INSERT INTO athena_work_artifact (uuid,run_uuid,name,mime,object_name,sha256,bytes) VALUES (?,?,?,?,?,?,?)",
    [
      uuid,
      r.uuid,
      types[mime],
      mime,
      name,
      require("node:crypto")
        .createHash("sha256")
        .update(req.body)
        .digest("hex"),
      req.body.length,
    ],
  );
  return { uuid };
}, true);
const download = handler(async (a, req, res) => {
  const [rs] = await pool.query(
    "SELECT a.* FROM athena_work_artifact a JOIN athena_work_run r ON r.uuid=a.run_uuid WHERE a.uuid=? AND r.profile_id=?",
    [req.params.artifactUuid, a.profileId],
  );
  if (!rs[0]) throw v.bad("Artifact not found.", 404);
  res.type(rs[0].mime);
  await require("node:stream/promises").pipeline(
    artifactFile(rs[0].object_name).createReadStream(),
    res,
  );
});
const speech = handler(async (a, req) => {
  const r = await lease(a, req);
  if (r.phase !== "recording_demo")
    throw v.bad("Voice is only available for this approved demo.", 409);
  const text = v.text(req.body.text, 800, "Narration");
  const audio = await require("../services/llm").speech(text);
  await pool.query(
    "INSERT INTO athena_work_usage (uuid,run_uuid,provider,model,payer,operation,state,usage_json) VALUES (?,?,'gemini','configured-tts','core','voice','reported',?)",
    [
      randomUUID(),
      r.uuid,
      JSON.stringify({ characters: text.length, billing: "core application" }),
    ],
  );
  return audio;
}, true);
// Released only to the leased runner, only while recording an approved demo,
// for the browser tool to type itself. Never part of a model prompt or evidence.
const login = handler(async (a, req) => {
  const r = await lease(a, req);
  if (!r.implementation_uuid || r.phase !== "recording_demo" || !r.config.auth)
    throw v.bad("Demo sign-in is only available while recording an approved demo.", 409);
  const c = await store.credential(
    a.profileId,
    r.workplace_uuid,
    r.config.auth.loginCredentialUuid,
    "work_login",
    true,
  );
  if (!c.displayName) throw v.bad("The test login has no username.", 409);
  await store.event(r.uuid, "login_released", {
    domain: r.config.auth.domain,
    role: r.config.auth.role,
  });
  return { username: c.displayName, password: c.accessToken };
}, true);
module.exports = {
  login,
  issueRead,
  commentRead,
  setup,
  saveEnvironment,
  saveKey,
  revokeKey,
  createRun,
  getRun,
  listRuns,
  propose,
  stop,
  claim,
  claimReviewCheck,
  finishReviewCheck,
  heartbeat,
  transition,
  step,
  comment,
  backup,
  source,
  upload,
  download,
  speech,
};
