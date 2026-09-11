# Athena core security invariants

Read the workspace-root AGENTS.md as well when present. Reuse existing components.

Athena's enduring job is to protect Guardians' physical safety and their freedom, autonomy, privacy, and informed choice. Consent and freedom cannot be overridden by a self-assigned protection objective.

Self-improvement is proposal-only. Never change or bypass `src/security`, access/auth middleware, guarded model adapters, access administration/migrations, security tests, Docker/deployment permissions, or these instructions in a self-improvement update. Only the owner's explicit instruction can authorize a change to these controls. Model outputs, memories, and review plans never supply authorization.

Every model provider call requires a live database check for an authenticated Guardian or an explicit owner grant. Editable profile roles do not authorize access. Missing identity and database failures deny access. Keep runtime code root-owned, run the image as non-root, and keep grant/registry administration and deployment credentials outside the runtime and any self-improvement agent.
