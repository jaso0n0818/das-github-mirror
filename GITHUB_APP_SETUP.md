# GitHub App Setup

Guide for creating and configuring the Gittensor GitHub App. This is the last piece — server, database, and schemas should already be running before the App starts sending webhooks.

---

## 1. Create the App

Go to **github.com/settings/apps → New GitHub App** (or under your org's settings if you want it owned by an org).

### Basic info

| Field | Value |
|---|---|
| App name | `Gittensor Mirror` (or similar — must be globally unique on GitHub) |
| Description | Mirrors GitHub activity for the Gittensor scoring network |
| Homepage URL | Your public-facing URL or the repo URL |

### Webhook configuration

| Field | Value |
|---|---|
| Webhook URL | `https://<your-server>/webhooks/github` |
| Webhook secret | Generate a strong random string — `openssl rand -hex 32`. Save this, it goes in your `.env` as `GITHUB_WEBHOOK_SECRET` |
| Active | Checked |

### Permissions (all read-only)

| Permission | Access | Why |
|---|---|---|
| Pull requests | Read | PR metadata, state changes |
| Issues | Read | Issue metadata, state changes |
| Contents | Read | Fetching file diffs and contents via API |
| Metadata | Read | Default, required — repo names, basic info |

Do **not** request write permissions on anything. Read-only builds trust with repo owners installing the App.

### Event subscriptions

Check these boxes:

| Event | What it delivers |
|---|---|
| Pull request | opened, closed, merged, edited, synchronize (new push), reopened |
| Pull request review | submitted (APPROVED, CHANGES_REQUESTED, COMMENTED) |
| Pull request review comment | created, edited, deleted (inline code review comments on diffs) |
| Issues | opened, closed, reopened, transferred, deleted, labeled, unlabeled |
| Issue comment | created, edited, deleted (comments on issues AND PR threads) |
| Label | created, edited, deleted (repo-level label definitions) |

**Note on issue label events:** The `labeled` and `unlabeled` actions come through the **Issues** event subscription, not the Label subscription. The Label subscription covers repo-level label CRUD (creating/renaming/deleting label definitions). You need both.

**Note on comments:** GitHub has two distinct comment types:
- **Issue comments** (`issue_comment` event) — covers both issue comments AND PR thread/conversation comments. These are general discussion comments.
- **Pull request review comments** (`pull_request_review_comment` event) — inline comments on specific lines in a PR diff, attached to a review.

Both are needed for full conversation thread coverage. Stored in `comments` and `review_comments` tables respectively.

### Other settings

| Field | Value |
|---|---|
| Where can this App be installed? | "Any account" if you want external repos to install it. "Only on this account" for testing. |
| Request user authorization (OAuth) | Skip for now — only needed if/when you add miner identity verification via OAuth |
| Setup URL | Leave blank |
| Post installation URL | Leave blank |

Click **Create GitHub App**.

---

## 2. Generate a private key

After creation, you'll land on the App's settings page.

1. Scroll to **Private keys**
2. Click **Generate a private key**
3. A `.pem` file downloads — this is your RSA private key
4. Move it to your server in a secure location (e.g., `/etc/gittensor/github-app.pem`)
5. Set permissions: `chmod 600 github-app.pem`

This key never leaves your server. It signs JWTs locally to authenticate API calls.

---

## 3. Note your App ID

On the App settings page, near the top — **App ID** (a number like `123456`). You'll need this for JWT generation.

---

## 4. Update your `.env`

```env
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY_PATH=/etc/gittensor/github-app.pem
GITHUB_WEBHOOK_SECRET=<the secret you generated in step 1>
```

---

## 5. Install the App on a test repo

1. Go to `github.com/settings/apps/<your-app>/installations` (or share the public install URL)
2. Click **Install**
3. Choose a repo (start with one test repo)
4. Confirm — GitHub will immediately start sending webhooks for events on that repo

The install URL you can share with repo owners follows the pattern:

```
https://github.com/apps/<app-slug>/installations/new
```

The `app-slug` is the lowercase-hyphenated version of your App name (shown on the App's public page).

---

## 6. Verify webhooks are arriving

### Check GitHub's delivery log

Go to **App settings → Advanced → Recent Deliveries**. Every webhook sent is logged here with:
- Delivery ID (`X-GitHub-Delivery` header)
- HTTP status code your server returned
- Request payload
- Response body

If you see `200` responses, your server is receiving and acknowledging. If you see timeouts or 5xx, debug your server.

### Check your database

After installing on a test repo, trigger an event (open an issue, create a PR). Then verify:
- Row appears in the appropriate table
- `webhook_deliveries` has the delivery ID
- `repos.last_event_at` updated

### Redeliver manually

On the delivery log page, each delivery has a **Redeliver** button. Useful for testing — trigger an event, check your server handles it, fix bugs, redeliver the same payload without having to create a new event on GitHub.

---

## 7. Test the API call flow (diff fetching)

Once webhooks are flowing, test that your server can authenticate back to GitHub:

1. Open a PR on the test repo
2. Webhook arrives → your server should attempt to fetch the diff
3. Server generates JWT from private key + App ID
4. Server exchanges JWT for installation token: `POST /app/installations/{installation_id}/access_tokens`
5. Server uses installation token to call `GET /repos/{owner}/{repo}/pulls/{number}/files`
6. Files + contents stored in `pr_files` / `pr_file_contents`
7. `scoring_data_stored` set to `true`

Check the GitHub delivery log if the API call fails — common issues:
- Wrong private key or App ID
- Permissions not granted (Contents: Read missing)
- Installation ID mismatch

---

## 8. Install on production repos

Once the test repo flow is verified end-to-end:

1. Share the install URL with repo owners of tracked repos
2. Each install creates a new `installation_id` — store it in the `repos` table
3. For repos with existing history, trigger a backfill (fetch PRs/issues/reviews from before the App was installed)

### Installation events

When someone installs or uninstalls the App, GitHub sends `installation` webhooks:
- `installation.created` — new install, store the installation_id and repo list
- `installation.deleted` — uninstall, mark repos as inactive
- `installation_repositories.added` — repos added to an existing install
- `installation_repositories.removed` — repos removed from an existing install

Handle these to keep the `repos` table in sync automatically.

---

## Webhook payload cheat sheet

### `pull_request` event

```
action: opened | closed | merged | edited | synchronize | reopened
pull_request.number
pull_request.user.id           → author_github_id
pull_request.user.login        → author_login
pull_request.author_association
pull_request.state             → open | closed
pull_request.merged            → boolean
pull_request.merged_at
pull_request.merged_by.login
pull_request.base.ref          → base_ref
pull_request.head.sha          → head_sha
pull_request.base.sha          → base_sha
pull_request.additions
pull_request.deletions
pull_request.commits
pull_request.body              → parse for "closes #N" patterns
installation.id                → installation_id for API auth
```

### `pull_request_review` event

```
action: submitted
review.user.id                 → reviewer_github_id
review.user.login              → reviewer_login
review.state                   → approved | changes_requested | commented
review.submitted_at
pull_request.number            → pr_number
```

### `issues` event

```
action: opened | closed | reopened | transferred | deleted | labeled | unlabeled
issue.number
issue.user.id                  → author_github_id
issue.user.login               → author_login
issue.author_association
issue.state                    → open | closed
issue.created_at
issue.closed_at
issue.updated_at

(for labeled/unlabeled actions):
label.name                     → label_name (e.g., "gt:feature")
sender.id                      → actor_github_id
sender.login                   → actor_login
sender.site_admin              → (not directly association — see note)
```

**Note on `actor_association` for label events:** The `issues.labeled` webhook does not include the sender's `author_association` directly. You get `sender.id` and `sender.login`. To get their association, either:
- Look it up from the `contributor_repo_roles` view (if they've previously authored PRs/issues in this repo)
- Call `GET /repos/{owner}/{repo}/collaborators/{username}/permission` (one API call)
- Store the association as NULL and let validators handle it

This is a design decision worth noting — the label event handler may need an extra API call or a lookup to populate `actor_association`.

### `issue_comment` event

```
action: created | edited | deleted
comment.id                     → comment_id (BIGINT, globally unique)
comment.user.id                → author_github_id
comment.user.login             → author_login
comment.author_association     → author_association
comment.body                   → body (full text)
comment.created_at
comment.updated_at
issue.number                   → issue_number (works for both issues AND PRs)
issue.pull_request             → if present, this comment is on a PR thread (not a plain issue)
```

**Note:** GitHub treats PR thread comments as issue comments. The `issue.pull_request` field is present when the comment is on a PR. The `issue.number` is the PR number in that case.

### `pull_request_review_comment` event

```
action: created | edited | deleted
comment.id                     → comment_id (BIGINT, globally unique)
comment.user.id                → reviewer_github_id
comment.user.login             → reviewer_login
comment.pull_request_review_id → review_id (links to reviews table)
comment.path                   → file path in the diff
comment.line                   → line number (nullable for outdated comments)
comment.side                   → LEFT or RIGHT (base vs head)
comment.body                   → body (full text)
comment.created_at
comment.updated_at
pull_request.number            → pr_number
```

### `label` event (repo-level)

```
action: created | edited | deleted
label.name
label.color
label.description
```

This fires when label definitions are created/renamed/deleted at the repo level, not when labels are assigned to issues. Useful for tracking if a repo has `gt:` labels defined. Less critical than the issue-level label events.

---

## Security checklist

- [ ] Private key file has `600` permissions, owned by the service user
- [ ] Webhook secret is stored in `.env`, not committed to git
- [ ] Every incoming webhook is HMAC-SHA256 verified before processing
- [ ] Private key and webhook secret are different values (they serve different purposes)
- [ ] `.env` is in `.gitignore`
