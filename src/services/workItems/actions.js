// New client-work actions. Existing self-repair descriptors and allowlists stay intact.
module.exports = [false, true].map((implementing) => ({
  id: implementing ? "implement_work_item" : "plan_work_item",
  label: implementing
    ? "Post the reviewed Jira plan and implement locally"
    : "Plan a Jira work item in its local environment",
  provider: null,
  consentType: "action_authority",
  reversible: false,
  standing: false,
  describe: implementing
    ? "Only after the person reviews the Work drawer plan: post that immutable plan to Jira and implement and demonstrate it in the approved local sandbox. Never publish or merge code."
    : "Prepare an isolated client development environment, run its reviewed build/test recipes, investigate and produce a plan. Requires an existing draft run from the Work drawer.",
  params: {
    run_uuid: "UUID of the existing Work run.",
    ...(implementing
      ? { plan_hash: "Exact hash of the plan shown to the person." }
      : {}),
  },
  normalize: (raw, ctx) =>
    require("./store").normalize(ctx.profileId, raw, implementing),
  // Stored summaries stop at 500 characters; the full recipe commands are in the
  // approved params and listed on the approval card.
  summarize: (p) =>
    `${implementing ? "Post the exact reviewed plan to Jira, change only the isolated checkout, test and record a demo" : "Check out repositories, restore the test database, run the configured recipes and prepare a plan"} for ${p.issue_key} in "${p.environment.name}": ${p.environment.repositories.join(", ")}; backup ${p.environment.backup};${p.environment.signIn ? ` demo signs in at ${p.environment.signIn.domain} as ${p.environment.signIn.role};` : ""} ${p.environment.recipes.length} recipes. Company keys fund ticket analysis; core funds voice. No publishing or deployment.`,
  execute: (profileId, params, ctx) =>
    require("./store").enqueue(profileId, params, ctx.actionUuid, implementing),
}));
