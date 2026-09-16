---
id: local-athena
title: Local Athena
summary: If someone has set up an Athena server in your own home, you can point this app at it so your conversations run there.
where: the ⋯ menu (top right) → Local server
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [local, local server, self host, self hosted, home server, on premise, my own server, private server, local athena]
---

## What I can do

There's a version of me that can run on hardware you own rather than in the
cloud. If an owner has prepared that server, you can approve its address once
and this app will use it — checking the connection, remembering it, and
reconnecting when you open me again.

You can also choose whether to fall back to the cloud server when the local one
can't be reached at startup, or to stay local only.

## Where to find it

The **⋯ menu in the top right corner** → **Local server** ("Local Athena").
Enter the HTTPS address the installation owner gave you, tick the box
approving contact with that server, optionally allow cloud fallback, then
**Connect Athena**. **Forget local server** undoes it.

Your browser may ask for local network permission — allow it. There's an
installation guide linked at the bottom of the panel under **Installation &
diagnostics**.

## When it doesn't work

- **The connection check fails.** Browsers won't tell me whether that was the
  network, the certificate, or the server itself — I genuinely can't
  distinguish them from here. Allow local network access if prompted, then try
  opening the address directly in a tab to see the real error.
- **It connected but you're signed out.** Expected: the local server serves its
  own web client and you sign in there separately. Cloud cookies and messages
  don't transfer.
- **Your memories aren't there.** Also expected — they stay separate until the
  owner migrates them.

## Limits

- **This is a preview.** Automatic installation isn't built; an owner has to
  prepare the server first.
- A successful check identifies the service, not who owns it. Only use an
  address you trust.
- Running locally doesn't mean nothing leaves the house — the local core
  decides its own model fallback and can still call frontier providers.
- Guardian membership or an owner grant is still required to use me there —
  access control doesn't relax because the server is yours.

## Under the hood

- Panel: `../../../companion/src/components/LocalServerPanel.tsx`; probe,
  preference storage and origin normalisation in
  `../../../companion/src/localConnection.ts`.
- Installation guide: `local-server-setup.html` (served by the companion app).
- Architecture: `../../../docs/architecture/local-installation.md`,
  `portable-runtime-access-proposal.md`, `windows-pilot.md`.
- Runtimes: `../../../native-runtime/`, `../../../windows-runtime/`.
- `status: partial` is deliberate — flip to `live` when owner-free
  installation ships, and rewrite `## Limits` in the same change.
