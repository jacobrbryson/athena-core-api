const { randomUUID } = require("node:crypto");
const pool = require("../../helpers/db");
const credentials = require("../credentials");
const { withTransaction } = require("../parent-helpers");
const v = require("./validation");
async function workplace(profileId, uuid) {
  const [r] = await pool.query(
    "SELECT uuid,name FROM athena_workplace WHERE profile_id=? AND uuid=?",
    [profileId, uuid],
  );
  if (!r.length) throw v.bad("Workplace not found.", 404);
  return r[0];
}
async function credential(
  profileId,
  workplaceUuid,
  uuid,
  provider,
  secret = false,
) {
  const [rows] = await pool.query(
    `SELECT c.uuid,c.external_account_id FROM user_credential c JOIN athena_workplace_link l ON l.credential_uuid=c.uuid AND l.profile_id=c.profile_id JOIN athena_workplace w ON w.id=l.workplace_id AND w.profile_id=l.profile_id WHERE c.profile_id=? AND w.uuid=? AND c.uuid=? AND c.provider=? AND c.status='active'`,
    [profileId, workplaceUuid, uuid, provider],
  );
  if (!rows.length)
    throw v.bad(
      `Connect a ${provider} credential belonging to this workplace.`,
      409,
    );
  if (!secret) return rows[0];
  const c = await credentials.get(profileId, provider, {
    externalAccountId: rows[0].external_account_id,
    actor: "work-item",
  });
  if (!c || c.uuid !== uuid || c.status !== "active" || !c.accessToken)
    throw v.bad(`The workplace ${provider} key is unavailable.`, 409);
  return c;
}
async function validateCredentials(profileId, w, cfg) {
  authorizeBackup(profileId, w, cfg.backup);
  for (const [field, provider] of [
    ["jiraCredentialUuid", "jira"],
    ["githubCredentialUuid", "github"],
    ["modelCredentialUuid", cfg.provider],
  ])
    await credential(profileId, w, cfg[field], provider);
  if (cfg.auth) {
    authorizeAuthDomain(profileId, w, cfg.auth.domain);
    await credential(profileId, w, cfg.auth.loginCredentialUuid, "work_login");
  }
  const [devices] = await pool.query(
    "SELECT uuid FROM paired_device WHERE uuid=? AND profile_id=? AND revoked_at IS NULL AND token_hash IS NOT NULL",
    [cfg.runnerUuid, profileId],
  );
  if (!devices.length) throw v.bad("Choose a paired, active runner.", 409);
}
function authorizeBackup(profileId, workplaceUuid, object) {
  let grants;
  try {
    grants = JSON.parse(process.env.WORK_BACKUP_PREFIXES || "{}");
  } catch {
    throw v.bad("The owner backup-prefix configuration is invalid.", 503);
  }
  const grant = grants[workplaceUuid];
  if (
    !grant ||
    Number(grant.profileId) !== Number(profileId) ||
    !Array.isArray(grant.prefixes) ||
    !grant.prefixes.some(
      (prefix) =>
        typeof prefix === "string" &&
        prefix.startsWith("gs://") &&
        prefix.endsWith("/") &&
        object.startsWith(prefix),
    )
  )
    throw v.bad(
      "The owner must authorize this workplace backup prefix in WORK_BACKUP_PREFIXES before a run can read it.",
      403,
    );
}
// The sandbox's only path outside its private network: owner-set, per workplace,
// re-checked on every lease so removing the entry stops sign-in at once.
function authorizeAuthDomain(profileId, workplaceUuid, domain) {
  let grants;
  try {
    grants = JSON.parse(process.env.WORK_AUTH_DOMAINS || "{}");
  } catch {
    throw v.bad("The owner sign-in domain configuration is invalid.", 503);
  }
  const grant = grants[workplaceUuid];
  if (
    !grant ||
    Number(grant.profileId) !== Number(profileId) ||
    !Array.isArray(grant.domains) ||
    !grant.domains.includes(domain)
  )
    throw v.bad(
      "The owner must allow this workplace's sign-in domain in WORK_AUTH_DOMAINS before a run can reach it.",
      403,
    );
}
async function environments(profileId) {
  const [rows] = await pool.query(
    "SELECT uuid,workplace_uuid,name,config,created_at FROM athena_work_environment WHERE profile_id=? ORDER BY created_at DESC LIMIT 100",
    [profileId],
  );
  return rows.map((r) => ({ ...r, config: v.json(r.config) }));
}
async function saveEnvironment(profileId, input) {
  await workplace(profileId, input.workplaceUuid);
  const cfg = v.config(input.config);
  await validateCredentials(profileId, input.workplaceUuid, cfg);
  const uuid = randomUUID();
  await pool.query(
    "INSERT INTO athena_work_environment (uuid,profile_id,workplace_uuid,name,config) VALUES (?,?,?,?,?)",
    [
      uuid,
      profileId,
      input.workplaceUuid,
      v.text(input.name, 120, "Environment name"),
      JSON.stringify(cfg),
    ],
  );
  return uuid;
}
async function create(profileId, environmentUuid, url) {
  const [envs] = await pool.query(
    "SELECT * FROM athena_work_environment WHERE uuid=? AND profile_id=?",
    [environmentUuid, profileId],
  );
  if (!envs[0]) throw v.bad("Environment not found.", 404);
  const env = envs[0],
    cfg = v.json(env.config);
  await validateCredentials(profileId, env.workplace_uuid, cfg);
  const issue = await require("./jira").read(
    profileId,
    url,
    cfg.jiraCredentialUuid,
    cfg.acceptanceField,
  );
  if (issue.comments.total > 50)
    issue.comments = await require("./jira").comments(
      profileId,
      issue,
      issue.comments.total - 50,
    );
  const uuid = randomUUID();
  await pool.query(
    "INSERT INTO athena_work_run (uuid,profile_id,environment_uuid,workplace_uuid,issue_json,config_json) VALUES (?,?,?,?,?,?)",
    [
      uuid,
      profileId,
      environmentUuid,
      env.workplace_uuid,
      JSON.stringify(issue),
      JSON.stringify(cfg),
    ],
  );
  return get(profileId, uuid);
}
function row(r) {
  return {
    ...r,
    issue: v.json(r.issue_json),
    config: v.json(r.config_json),
    checkpoint: v.json(r.checkpoint),
    lease_token: undefined,
    issue_json: undefined,
    config_json: undefined,
  };
}
async function get(profileId, uuid, internal = false) {
  const [rs] = await pool.query(
    "SELECT * FROM athena_work_run WHERE profile_id=? AND uuid=?",
    [profileId, uuid],
  );
  if (!rs[0]) throw v.bad("Work run not found.", 404);
  const r = row(rs[0]);
  if (internal) r.lease_token = rs[0].lease_token;
  const [events] = await pool.query(
    "SELECT id,kind,detail,created_at FROM athena_work_event WHERE run_uuid=? ORDER BY id DESC LIMIT 60",
    [uuid],
  );
  const [usage] = await pool.query(
    "SELECT provider,model,payer,operation,state,usage_json,created_at FROM athena_work_usage WHERE run_uuid=? ORDER BY created_at",
    [uuid],
  );
  const [artifacts] = await pool.query(
    "SELECT uuid,name,mime,sha256,bytes FROM athena_work_artifact WHERE run_uuid=?",
    [uuid],
  );
  return {
    ...r,
    events: events.map((e) => ({ ...e, detail: v.json(e.detail) })),
    usage: usage.map((u) => ({ ...u, usage_json: v.json(u.usage_json) })),
    artifacts,
  };
}
async function list(profileId) {
  const [rs] = await pool.query(
    "SELECT uuid,phase,reason,issue_json,created_at,updated_at FROM athena_work_run WHERE profile_id=? ORDER BY created_at DESC LIMIT 30",
    [profileId],
  );
  return rs.map((r) => ({
    ...r,
    issue: v.json(r.issue_json),
    issue_json: undefined,
  }));
}
async function event(uuid, kind, detail) {
  await pool.query(
    "INSERT INTO athena_work_event (run_uuid,kind,detail) VALUES (?,?,?)",
    [uuid, kind, JSON.stringify(detail)],
  );
}
async function normalize(profileId, input, implementing) {
  if (!v.uuid(input?.run_uuid)) throw v.bad("Choose an existing Work run.");
  const r = await get(profileId, input.run_uuid);
  if (r.phase !== (implementing ? "awaiting_review" : "draft"))
    throw v.bad("This run is not ready for that approval.", 409);
  if (implementing && input.plan_hash !== r.plan_hash)
    throw v.bad("Review the current plan before approving.", 409);
  await validateCredentials(profileId, r.workplace_uuid, r.config);
  const [envs] = await pool.query(
    "SELECT name FROM athena_work_environment WHERE uuid=? AND profile_id=?",
    [r.environment_uuid, profileId],
  );
  return {
    run_uuid: r.uuid,
    issue_key: r.issue.key,
    snapshot_hash: v.hash({ config: r.config, issue: r.issue }),
    ...(implementing ? { plan_hash: r.plan_hash } : {}),
    // Server-derived from the run's frozen config (covered by snapshot_hash), so
    // the person approves the exact repositories, backup and commands that run.
    environment: {
      name: envs[0]?.name || "Unnamed environment",
      repositories: r.config.repositories.map((x) => `${x.full}@${x.ref}`),
      backup: r.config.backup,
      signIn: r.config.auth
        ? { domain: r.config.auth.domain, role: r.config.auth.role }
        : null,
      recipes: r.config.recipes.map(({ id, kind, command }) => ({
        id,
        kind,
        command,
      })),
    },
  };
}
async function enqueue(profileId, params, actionUuid, implementing) {
  const r = await get(profileId, params.run_uuid);
  if (
    v.hash({ config: r.config, issue: r.issue }) !== params.snapshot_hash ||
    (implementing && r.plan_hash !== params.plan_hash)
  )
    throw v.bad("The approved snapshot changed.", 409);
  await validateCredentials(profileId, r.workplace_uuid, r.config);
  if (implementing) {
    const fresh = await require("./jira").read(
      profileId,
      r.issue.url,
      r.config.jiraCredentialUuid,
      r.config.acceptanceField,
    );
    if (fresh.updated !== r.issue.updated)
      throw v.bad(
        "The Jira issue changed. Create and review a fresh plan.",
        409,
      );
  }
  const phase = implementing ? "implementation_queued" : "queued";
  const [result] = await pool.query(
    `UPDATE athena_work_run SET phase=?,${implementing ? "implementation_uuid" : "approval_uuid"}=?,lease_token=NULL,lease_until=NULL,reason=NULL WHERE uuid=? AND profile_id=? AND phase=?`,
    [
      phase,
      actionUuid,
      r.uuid,
      profileId,
      implementing ? "awaiting_review" : "draft",
    ],
  );
  if (!result.affectedRows) throw v.bad("Run already started or changed.", 409);
  await event(r.uuid, phase, { actionUuid });
  return { ref: r.uuid, detail: phase };
}
async function claim(profileId, deviceUuid) {
  return withTransaction(async (c) => {
    const [device] = await c.query(
      "SELECT uuid FROM paired_device WHERE profile_id=? AND uuid=? AND revoked_at IS NULL FOR UPDATE",
      [profileId, deviceUuid],
    );
    if (!device.length) throw v.bad("Runner was revoked.", 403);
    const [rows] = await c.query(
      "SELECT * FROM athena_work_run r WHERE profile_id=? AND JSON_UNQUOTE(JSON_EXTRACT(config_json,'$.runnerUuid'))=? AND phase IN ('queued','implementation_queued') AND EXISTS (SELECT 1 FROM athena_action a WHERE a.uuid=COALESCE(r.implementation_uuid,r.approval_uuid) AND a.profile_id=r.profile_id AND a.status='done' AND a.approval='human') ORDER BY id LIMIT 1 FOR UPDATE",
      [profileId, deviceUuid],
    );
    if (!rows[0]) return null;
    const r = row(rows[0]);
    const [active] = await c.query(
      "SELECT uuid FROM athena_work_run WHERE runner_uuid=? AND phase IN ('preparing','planning','implementing','verifying','recording_demo') AND lease_until>UTC_TIMESTAMP() LIMIT 1",
      [deviceUuid],
    );
    if (active.length) return null;
    const lease = require("node:crypto").randomBytes(32).toString("hex");
    const phase = r.phase === "queued" ? "preparing" : "implementing";
    await c.query(
      "UPDATE athena_work_run SET phase=?,runner_uuid=?,lease_token=?,lease_until=DATE_ADD(UTC_TIMESTAMP(),INTERVAL 3 MINUTE) WHERE uuid=?",
      [phase, deviceUuid, lease, r.uuid],
    );
    return { ...r, phase, lease };
  });
}
async function leased(profileId, uuid, deviceUuid, lease) {
  const r = await get(profileId, uuid, true);
  if (
    !lease ||
    r.lease_token !== lease ||
    r.runner_uuid !== deviceUuid ||
    !r.lease_until ||
    new Date(r.lease_until) <= new Date() ||
    ![
      "preparing",
      "planning",
      "implementing",
      "verifying",
      "recording_demo",
    ].includes(r.phase)
  )
    throw v.bad("This run lease is no longer active.", 409);
  const actionUuid = r.implementation_uuid || r.approval_uuid;
  const [a] = await pool.query(
    "SELECT uuid FROM athena_action WHERE uuid=? AND profile_id=? AND status='done' AND approval='human' AND action_id=?",
    [
      actionUuid,
      profileId,
      r.implementation_uuid ? "implement_work_item" : "plan_work_item",
    ],
  );
  if (!a.length) throw v.bad("A recorded human approval is required.", 403);
  await validateCredentials(profileId, r.workplace_uuid, r.config);
  return r;
}
async function heartbeat(profileId, uuid, deviceUuid, lease) {
  await leased(profileId, uuid, deviceUuid, lease);
  const [x] = await pool.query(
    "UPDATE athena_work_run SET lease_until=DATE_ADD(UTC_TIMESTAMP(),INTERVAL 3 MINUTE) WHERE uuid=? AND lease_token=?",
    [uuid, lease],
  );
  return !!x.affectedRows;
}
async function stop(profileId, uuid) {
  await get(profileId, uuid);
  await pool.query(
    "UPDATE athena_work_run SET phase='cancelled',lease_token=NULL,lease_until=NULL,reason='Stopped by owner' WHERE uuid=? AND profile_id=?",
    [uuid, profileId],
  );
  await event(uuid, "cancelled", {});
}
module.exports = {
  workplace,
  credential,
  validateCredentials,
  authorizeBackup,
  authorizeAuthDomain,
  environments,
  saveEnvironment,
  create,
  get,
  list,
  event,
  normalize,
  enqueue,
  claim,
  leased,
  heartbeat,
  stop,
};
