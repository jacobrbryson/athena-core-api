# Companion dashboard data setup

The read-only dashboard endpoint uses the same authenticated adult actor,
access boundary and connector readers as chat. No model is needed to fetch
card contents. Health reads check the existing health-data consent. All
provider credentials stay in the existing encrypted credential store.

## Server setup

Apply `db/migrations/0032_news_watch.up.sql` through the repository migration
runner before using News, and schedule `src/jobs/news.js` every 5 minutes —
without that job nothing is ever read. (`0031_dashboard_preferences.up.sql` is
still applied; its news source list is now read once, to carry an old RSS list
across.) Deploy the updated Core API and Companion together; an older backend
cannot serve these new routes.

The existing secret resolver accepts environment variables or Secret Manager:

| Service | Required app credentials | Provider setup |
| --- | --- | --- |
| Gmail | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | Enable Gmail API and allow `https://www.googleapis.com/auth/gmail.readonly` in the OAuth consent configuration. |
| Jira Cloud | `JIRA_CLIENT_ID`, `JIRA_CLIENT_SECRET` | Create an Atlassian 3LO app with `read:jira-work` and `offline_access`. |
| Slack | `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` | Create a Slack app with the **user** scope `search:read`; no bot or write scopes are used. |

Register each callback as `${PUBLIC_API_BASE_URL}/integrations/PROVIDER/callback`,
with PROVIDER `gmail`, `jira`, or `slack`. Preserve the existing return-origin
allowlist. No app secrets or tokens belong in frontend environment variables.

Then open Connected apps and authorize each account. For the owner's Work
dashboard, select `rbryson@vivacitytech.com` in Google's account chooser; the
Work page displays the actual connected mailbox so it can be verified. This
address is not a global account override and cannot grant mailbox access.
Workspace admins may need to approve Gmail/Slack/Jira app access.

## Data and limits

- Calendar: up to 25 upcoming/ongoing events in seven days, using the calendar's
  timezone and date-only semantics for all-day events.
- WHOOP: up to seven recent recovery, sleep and cycle records; failures isolated.
- Strava: up to 30 recent activities in seven days.
- Family Chores: up to 25 of the credential owner's linked player's chores today.
- Gmail: five unread inbox messages, headers only; no send or modify endpoint.
- Slack: five recent mention search results visible to the authenticated user.
- Jira: assigned open issues, ten per site, up to five sites and 25 returned.
- News: up to twelve user-chosen news PAGES (not feeds), read in the background
  by `src/jobs/news.js` on a per-source interval Athena sets herself; the
  dashboard renders what is already stored and fetches nothing. See
  [news-watch.md](news-watch.md) for the fetch guards, the interval bounds and
  the scheduling. Headline text is displayed as text, not HTML.

## Provider references

- [Gmail message listing](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)
- [Atlassian 3LO](https://developer.atlassian.com/cloud/jira/software/oauth-2-3lo-apps/)
- [Jira issue search](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/)
- [Slack user OAuth](https://docs.slack.dev/authentication/installing-with-oauth/)
- [Slack token rotation](https://docs.slack.dev/authentication/using-token-rotation)
