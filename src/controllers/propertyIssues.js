const { randomUUID } = require('node:crypto');
const pool = require('../helpers/db');
const { requireAdultActor } = require('../helpers/actor');

// Property issues (docs/capabilities/property.md): something wrong at the
// house right now. Adult-only, profile-scoped, and every write answers with
// the whole list, like projects. Photos are listed by uuid and fetched apart.
const SEVERITIES = ['low', 'medium', 'high', 'emergency'];
const MAX_ISSUES = 500;
const MAX_PHOTOS = 4;
const MAX_LOG = 200;
const UUID = /^[a-f0-9-]{36}$/i;

const bad = message => Object.assign(new Error(message), { status: 400 });
const notFound = () => Object.assign(new Error('That issue is no longer on your list.'), { status: 404 });

function text(value, max, label, { required = false } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string' || value.length > max) throw bad(`${label} is too long.`);
  const out = value.trim();
  if (required && !out) throw bad(`Add ${label.toLowerCase()}.`);
  return out;
}
function photo(value) {
  if (typeof value !== 'string' || value.length > 1500000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(value)) throw bad('Upload JPEG photos under 1.5 MB.');
  return value;
}
/** Today in the person's sense allows a day of timezone slack; the future beyond that is refused. */
function day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw bad('Choose when you noticed it.');
  if (Date.parse(`${value}T00:00:00Z`) > Date.now() + 86_400_000) throw bad('That date is in the future.');
  return value;
}

/** A full issue from input, or a patch merged over an existing one. */
function normalize(input, existing = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('Invalid issue.');
  const pick = (key, fn) => (input[key] !== undefined || !existing ? fn(input[key]) : existing[key]);
  const out = {
    location: pick('location', v => text(v, 100, 'Where the issue is', { required: true })),
    description: pick('description', v => text(v, 4000, 'What’s happening', { required: true })),
    severity: pick('severity', v => { if (!SEVERITIES.includes(v)) throw bad('Choose a severity.'); return v; }),
    noticedOn: pick('noticedOn', day),
    notes: pick('notes', v => text(v, 4000, 'Notes') || null),
    status: pick('status', v => { if (v === undefined) return 'open'; if (!['open', 'resolved'].includes(v)) throw bad('Invalid status.'); return v; }),
  };
  // A new issue sends `photos`; a patch sends `addPhotos`, since its `photos` are the uuids it already has.
  const addPhotos = existing ? input.addPhotos : input.photos;
  if (addPhotos !== undefined && (!Array.isArray(addPhotos) || addPhotos.length > MAX_PHOTOS)) throw bad(`Attach up to ${MAX_PHOTOS} photos.`);
  if (input.removePhotos !== undefined && (!Array.isArray(input.removePhotos) || input.removePhotos.some(v => typeof v !== 'string' || !UUID.test(v)))) throw bad('Invalid photo.');
  return { ...out, addPhotos: (addPhotos || []).map(photo), removePhotos: input.removePhotos || [] };
}

const iso = v => (v instanceof Date ? v.toISOString() : v ? new Date(`${String(v).replace(' ', 'T')}Z`).toISOString() : null);
const toIssue = (r, photos, log) => ({
  uuid: r.uuid, location: r.location, description: r.description, severity: r.severity, noticedOn: r.noticed_on,
  notes: r.notes, status: r.status, resolvedAt: iso(r.resolved_at), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  photos: photos.get(r.id) || [],
  log: log.get(r.id) || [],
});

async function all(profileId) {
  const [rows] = await pool.query(
    `SELECT id, uuid, location, description, severity, DATE_FORMAT(noticed_on, '%Y-%m-%d') AS noticed_on, notes, status, resolved_at, created_at, updated_at
     FROM athena_property_issue WHERE profile_id = ? ORDER BY created_at DESC, id DESC`, [profileId]);
  const photos = new Map();
  if (rows.length) {
    const [list] = await pool.query('SELECT issue_id, uuid FROM athena_property_issue_photo WHERE issue_id IN (?) ORDER BY id', [rows.map(r => r.id)]);
    for (const p of list) photos.set(p.issue_id, [...(photos.get(p.issue_id) || []), p.uuid]);
  }
  const log = await notesFor(rows.map(r => r.id));
  return rows.map(r => toIssue(r, photos, log));
}

/**
 * The running notes on each issue, oldest first. Before migration 0077 is
 * installed the table is missing; issues still list, just without notes.
 */
async function notesFor(issueIds) {
  const log = new Map();
  if (!issueIds.length) return log;
  try {
    const [list] = await pool.query('SELECT issue_id, uuid, body, created_at FROM athena_property_issue_note WHERE issue_id IN (?) ORDER BY created_at, id', [issueIds]);
    for (const n of list) log.set(n.issue_id, [...(log.get(n.issue_id) || []), { uuid: n.uuid, body: n.body, createdAt: iso(n.created_at) }]);
  } catch (err) {
    if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
  }
  return log;
}

async function owned(profileId, uuid) {
  const [rows] = await pool.query(
    `SELECT id, uuid, location, description, severity, DATE_FORMAT(noticed_on, '%Y-%m-%d') AS noticed_on, notes, status, resolved_at
     FROM athena_property_issue WHERE profile_id = ? AND uuid = ? LIMIT 1`, [profileId, String(uuid || '')]);
  if (!rows.length) throw notFound();
  return rows[0];
}

async function writePhotos(issueId, add, remove) {
  if (remove.length) await pool.query('DELETE FROM athena_property_issue_photo WHERE issue_id = ? AND uuid IN (?)', [issueId, remove]);
  if (!add.length) return;
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM athena_property_issue_photo WHERE issue_id = ?', [issueId]);
  if (n + add.length > MAX_PHOTOS) throw bad(`Attach up to ${MAX_PHOTOS} photos.`);
  for (const image of add) await pool.query('INSERT INTO athena_property_issue_photo (uuid, issue_id, image) VALUES (?, ?, ?)', [randomUUID(), issueId, image]);
}

function handler(fn) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const actor = await requireAdultActor(req, res);
    if (!actor) return;
    try {
      res.json(await fn(actor.profileId, req));
    } catch (err) {
      if (err.status === 400 || err.status === 404) return res.status(err.status).json({ message: err.message });
      return res.status(503).json({ message: 'Property issues are unavailable. Please try again; the property issues migration must be installed.' });
    }
  };
}

const list = handler(async profileId => ({ issues: await all(profileId) }));

const create = handler(async (profileId, req) => {
  const f = normalize(req.body);
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM athena_property_issue WHERE profile_id = ?', [profileId]);
  if (n >= MAX_ISSUES) throw bad(`That is already ${MAX_ISSUES} issues; delete some resolved ones first.`);
  const [result] = await pool.query(
    `INSERT INTO athena_property_issue (uuid, profile_id, location, description, severity, noticed_on, notes, status, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${f.status === 'resolved' ? 'UTC_TIMESTAMP()' : 'NULL'})`,
    [randomUUID(), profileId, f.location, f.description, f.severity, f.noticedOn, f.notes, f.status]);
  await writePhotos(result.insertId, f.addPhotos, []);
  return { issues: await all(profileId) };
});

const update = handler(async (profileId, req) => {
  const row = await owned(profileId, req.params.uuid);
  const existing = { location: row.location, description: row.description, severity: row.severity, noticedOn: row.noticed_on, notes: row.notes, status: row.status };
  const f = normalize(req.body, existing);
  // resolved_at moves only when the status does, so editing a resolved issue keeps its date.
  const resolved = f.status === row.status ? 'resolved_at' : f.status === 'resolved' ? 'UTC_TIMESTAMP()' : 'NULL';
  await pool.query(
    `UPDATE athena_property_issue SET location=?, description=?, severity=?, noticed_on=?, notes=?, status=?, resolved_at=${resolved}
     WHERE id = ? AND profile_id = ?`,
    [f.location, f.description, f.severity, f.noticedOn, f.notes, f.status, row.id, profileId]);
  await writePhotos(row.id, f.addPhotos, f.removePhotos);
  return { issues: await all(profileId) };
});

const remove = handler(async (profileId, req) => {
  const [result] = await pool.query('DELETE FROM athena_property_issue WHERE profile_id = ? AND uuid = ?', [profileId, String(req.params.uuid || '')]);
  if (!result.affectedRows) throw notFound();
  return { issues: await all(profileId) };
});

const photos = handler(async (profileId, req) => {
  const row = await owned(profileId, req.params.uuid);
  const [list] = await pool.query('SELECT uuid, image FROM athena_property_issue_photo WHERE issue_id = ? ORDER BY id', [row.id]);
  return { photos: list.map(p => ({ uuid: p.uuid, image: p.image })) };
});

const addNote = handler(async (profileId, req) => {
  const row = await owned(profileId, req.params.uuid);
  const body = text(req.body?.body, 2000, 'The note', { required: true });
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM athena_property_issue_note WHERE issue_id = ?', [row.id]);
  if (n >= MAX_LOG) throw bad(`That issue already has ${MAX_LOG} notes.`);
  await pool.query('INSERT INTO athena_property_issue_note (uuid, issue_id, body) VALUES (?, ?, ?)', [randomUUID(), row.id, body]);
  return { issues: await all(profileId) };
});

const removeNote = handler(async (profileId, req) => {
  const row = await owned(profileId, req.params.uuid);
  const [result] = await pool.query('DELETE FROM athena_property_issue_note WHERE issue_id = ? AND uuid = ?', [row.id, String(req.params.noteUuid || '')]);
  if (!result.affectedRows) throw Object.assign(new Error('That note is no longer on this issue.'), { status: 404 });
  return { issues: await all(profileId) };
});

/** Open issues for Athena's prompt, most severe first. Read-only; never throws. */
async function openIssues(profileId, limit = 8) {
  try {
    const [rows] = await pool.query(
      `SELECT id, location, description, severity, DATE_FORMAT(noticed_on, '%Y-%m-%d') AS noticed_on, notes FROM athena_property_issue
       WHERE profile_id = ? AND status = 'open' ORDER BY FIELD(severity, 'emergency', 'high', 'medium', 'low'), created_at DESC LIMIT ?`,
      [profileId, limit]);
    const log = await notesFor(rows.map(r => r.id));
    return rows.map(r => ({ location: r.location, description: r.description, severity: r.severity, noticedOn: r.noticed_on, notes: r.notes, log: (log.get(r.id) || []).slice(-3) }));
  } catch {
    return [];
  }
}

module.exports = { list, create, update, remove, photos, addNote, removeNote, normalize, openIssues };
