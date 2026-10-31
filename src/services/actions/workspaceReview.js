// Owner-requested company PR review submissions. No standing or direct approval.
module.exports = {
  id: "submit_workspace_review",
  label: "Submit a company pull request review",
  provider: "github",
  consentType: "action_authority",
  reversible: false,
  standing: false,
  describe:
    "Submit only the exact PR review text and decision the person reviewed in the company PR drawer. Requires human confirmation every time; never merges code.",
  params: {
    workplace_uuid: "Company UUID.",
    repository: "GitHub owner/repository.",
    pull_number: "Pull request number.",
    head_sha: "Exact reviewed head commit.",
    base_sha: "Exact reviewed base commit.",
    event: "COMMENT, APPROVE or REQUEST_CHANGES.",
    body: "Exact review text to submit.",
  },
  normalize: (raw, ctx) =>
    require("../workspaceReviews").normalizeSubmission(ctx.profileId, raw),
  summarize: (p) =>
    `${p.event === "APPROVE" ? "Approve" : p.event === "REQUEST_CHANGES" ? "Request changes on" : "Comment on"} ${p.repository}#${p.pull_number} at ${p.head_sha.slice(0, 8)} using this company’s GitHub account: ${p.body.slice(0, 230)}`,
  execute: (profileId, params) =>
    require("../workspaceReviews").submit(profileId, params),
};
