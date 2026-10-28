const credentials = require("../credentials");
const oauth = require("../connectors/oauth");
const { bad } = require("./validation");
const HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.atlassian\.net$/i;
function target(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw bad("Choose a Jira Cloud issue.");
  }
  const m = /^\/browse\/([A-Z][A-Z0-9_]*-\d+)\/?$/.exec(u.pathname);
  if (
    u.protocol !== "https:" ||
    !HOST.test(u.hostname) ||
    u.port ||
    u.username ||
    u.password ||
    !m
  )
    throw bad("Choose a Jira Cloud issue URL.");
  return { site: u.hostname, key: m[1], url: `${u.origin}/browse/${m[1]}` };
}
async function access(profileId, issue) {
  const meta = (await credentials.list(profileId)).find(
    (c) =>
      c.uuid === issue.credentialUuid &&
      c.provider === "jira" &&
      c.status === "active",
  );
  if (!meta) throw bad("Reconnect this Jira account.", 409);
  const c = await credentials.get(profileId, "jira", {
    externalAccountId: meta.external_account_id || "",
    actor: "work-item",
  });
  if (!c || c.uuid !== meta.uuid)
    throw bad("Jira credential unavailable.", 409);
  if (c.kind === "api_key") {
    if (
      c.externalAccountId !== issue.site ||
      !HOST.test(c.externalAccountId) ||
      !c.accessToken ||
      !c.displayName
    )
      throw bad("This issue belongs to another Jira site.");
    return {
      base: `https://${issue.site}`,
      authorization: `Basic ${Buffer.from(`${c.displayName}:${c.accessToken}`).toString("base64")}`,
    };
  }
  // Existing OAuth refresh selects a profile/provider. Refuse ambiguous accounts.
  if (
    (await credentials.list(profileId)).filter(
      (k) => k.provider === "jira" && k.status === "active",
    ).length !== 1
  )
    throw bad("Choose an unambiguous Jira connection.", 409);
  const token = await oauth.accessToken(profileId, "jira", {
    actor: "work-item",
  });
  if (!token) throw bad("Reconnect Jira.", 409);
  const r = await fetch(
    "https://api.atlassian.com/oauth/token/accessible-resources",
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    },
  );
  if (!r.ok) throw bad("Jira sites could not be read.", 502);
  const site = (await r.json()).find((s) => s.url === `https://${issue.site}`);
  if (!site) throw bad("This Jira site is not connected.", 403);
  return {
    base: `https://api.atlassian.com/ex/jira/${encodeURIComponent(site.id)}`,
    authorization: `Bearer ${token}`,
  };
}
async function request(
  profileId,
  issue,
  suffix,
  { method = "GET", body } = {},
) {
  const a = await access(profileId, issue);
  const r = await fetch(
    `${a.base}/rest/api/3/issue/${encodeURIComponent(issue.key)}${suffix}`,
    {
      method,
      headers: {
        Authorization: a.authorization,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
      redirect: "error",
    },
  );
  if (!r.ok)
    throw bad(
      r.status === 403
        ? "Jira denied access. Commenting needs Add comments permission and an authorized write scope."
        : `Jira returned HTTP ${r.status}.`,
      r.status === 404 ? 404 : 502,
    );
  return r.json();
}
function plain(node) {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(plain).join("");
  return (
    (node.text || "") +
    (node.content || []).map(plain).join("") +
    (["paragraph", "heading", "listItem", "hardBreak"].includes(node.type)
      ? "\n"
      : "")
  );
}
async function read(profileId, url, credentialUuid, field) {
  const issue = { ...target(url), credentialUuid };
  if (!credentialUuid) {
    const rows = (await credentials.list(profileId)).filter(
      (c) => c.provider === "jira" && c.status === "active",
    );
    const c =
      rows.find((c) => c.external_account_id === issue.site) ||
      (rows.length === 1 ? rows[0] : null);
    if (!c) throw bad("No connected Jira account for this issue.", 409);
    issue.credentialUuid = c.uuid;
  }
  if (field && !/^customfield_\d+$/.test(field))
    throw bad("Use a Jira customfield ID for acceptance criteria.");
  const d = await request(
    profileId,
    issue,
    `?fields=${encodeURIComponent(`summary,description,status,assignee,priority,parent,subtasks,issuelinks,attachment,updated${field ? `,${field}` : ""}`)}`,
  );
  const f = d.fields || {};
  return {
    ...issue,
    title: f.summary || issue.key,
    description: f.description,
    descriptionText: plain(f.description).slice(0, 24000),
    acceptanceCriteria: field ? plain(f[field]).slice(0, 12000) : null,
    updated: f.updated,
    status: f.status?.name,
    assignee: f.assignee?.displayName || null,
    priority: f.priority?.name,
    parent: f.parent?.key,
    subtasks: (f.subtasks || []).map((s) => ({
      key: s.key,
      title: s.fields?.summary,
    })),
    attachments: (f.attachment || []).map((a) => ({
      name: a.filename,
      size: a.size,
    })),
    comments: await comments(profileId, issue, 0),
  };
}
async function comments(profileId, issue, start) {
  const offset = Math.max(0, Math.min(100000, Number(start) || 0));
  const d = await request(
    profileId,
    issue,
    `/comment?startAt=${offset}&maxResults=50&orderBy=created`,
  );
  return {
    start: d.startAt,
    total: d.total,
    items: (d.comments || []).map((c) => ({
      id: c.id,
      author: c.author?.displayName,
      at: c.created,
      body: c.body,
      text: plain(c.body),
    })),
  };
}
async function postPlan(
  profileId,
  issue,
  plan,
  runUuid,
  planHash,
  reconcile = false,
) {
  const marker = `[Athena plan ${runUuid} ${planHash}]`;
  // Always search on a retry. Ambiguous writes are never blindly retried.
  if (reconcile) {
    for (let start = 0; start < 10000; start += 50) {
      const page = await comments(profileId, issue, start);
      const found = page.items.find((c) => c.text.includes(marker));
      if (found) return found.id;
      if (start + page.items.length >= page.total)
        throw bad(
          "Jira comment outcome is unresolved. Review Jira before starting a new approved run.",
          409,
        );
    }
    throw bad(
      "Jira comment reconciliation exceeded the supported history.",
      409,
    );
  }
  const body = {
    type: "doc",
    version: 1,
    content: `${marker}\n${plan}`
      .split("\n")
      .map((line) => ({
        type: "paragraph",
        content: line ? [{ type: "text", text: line }] : [],
      })),
  };
  const result = await request(profileId, issue, "/comment", {
    method: "POST",
    body: { body },
  });
  return result.id;
}
module.exports = { target, read, comments, postPlan, plain };
