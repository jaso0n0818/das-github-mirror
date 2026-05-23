/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any */
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { readFileSync } from "fs";
import { sign } from "jsonwebtoken";
import {
  Issue,
  LabelEvent,
  PrFile,
  PrFileContent,
  PullRequest,
  Repo,
  Review,
} from "../entities";

interface InstallationToken {
  token: string;
  expiresAt: number;
}

interface ClosingIssueReference {
  number?: number;
  repository?: { nameWithOwner?: string } | null;
}

// Files larger than this are stored with null content (AST parsing is wasteful past this).
const MAX_FILE_SIZE_BYTES = 1_000_000;

// Starting batch size for batched GraphQL file-content requests. Halves on failure.
const GRAPHQL_FILES_BATCH_SIZE = 50;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

@Injectable()
export class GitHubFetcherService implements OnModuleInit {
  private readonly logger = new Logger(GitHubFetcherService.name);
  private readonly appId: string;
  private privateKey: string;
  private readonly tokenCache = new Map<string, InstallationToken>();

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(PrFile)
    private readonly prFileRepo: Repository<PrFile>,
    @InjectRepository(PrFileContent)
    private readonly prFileContentRepo: Repository<PrFileContent>,
    @InjectRepository(PullRequest)
    private readonly prRepo: Repository<PullRequest>,
    @InjectRepository(Issue)
    private readonly issueRepo: Repository<Issue>,
    @InjectRepository(Review)
    private readonly reviewRepo: Repository<Review>,
    @InjectRepository(LabelEvent)
    private readonly labelEventRepo: Repository<LabelEvent>,
    @InjectRepository(Repo)
    private readonly repoRepo: Repository<Repo>,
  ) {
    this.appId = this.config.getOrThrow("GITHUB_APP_ID");
  }

  onModuleInit(): void {
    const keyPath = this.config.getOrThrow("GITHUB_PRIVATE_KEY_PATH");
    this.privateKey = readFileSync(keyPath, "utf8");
  }

  // --- Rate-limit-aware fetch ---

  /**
   * Wraps fetch() with GitHub rate-limit handling:
   * - Parses X-RateLimit-Remaining on every response; warns below 500.
   * - On 403/429 with remaining=0 or Retry-After header, waits until the
   *   rate limit resets and retries.
   * - On 5xx / network errors, retries with exponential backoff (max 3).
   */
  private async githubFetch(
    url: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, init);
      } catch (err) {
        if (attempt < maxAttempts) {
          const delay = Math.min(2000 * 2 ** (attempt - 1), 30_000);
          this.logger.warn(
            `Network error calling ${url}: ${err} (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms`,
          );
          await sleep(delay);
          continue;
        }
        throw err;
      }

      const remainingStr = res.headers.get("x-ratelimit-remaining");
      const remaining = remainingStr ? Number(remainingStr) : NaN;
      if (!isNaN(remaining) && remaining > 0 && remaining < 500) {
        this.logger.warn(`GitHub rate limit low: ${remaining} calls remaining`);
      }

      // Rate-limit exhausted → wait for reset and retry
      if (
        (res.status === 403 || res.status === 429) &&
        (remaining === 0 || res.headers.has("retry-after"))
      ) {
        const waitMs = this.computeRetryAfterMs(res);
        this.logger.warn(
          `Rate limit hit on ${url}: waiting ${Math.round(waitMs / 1000)}s before retry`,
        );
        await sleep(waitMs);
        continue;
      }

      // Server-side transient error — retry with backoff
      if (res.status >= 500 && res.status < 600 && attempt < maxAttempts) {
        const delay = Math.min(2000 * 2 ** (attempt - 1), 30_000);
        this.logger.warn(
          `GitHub ${res.status} on ${url} (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms`,
        );
        await sleep(delay);
        continue;
      }

      return res;
    }

    throw new Error(`githubFetch exhausted retries for ${url}`);
  }

  private computeRetryAfterMs(res: Response): number {
    const retryAfter = res.headers.get("retry-after");
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (!isNaN(seconds)) return (seconds + 1) * 1000;
      const dateMs = Date.parse(retryAfter);
      if (!isNaN(dateMs)) return Math.max(0, dateMs - Date.now()) + 1000;
    }

    const reset = res.headers.get("x-ratelimit-reset");
    if (reset) {
      const resetMs = Number(reset) * 1000;
      if (!isNaN(resetMs)) return Math.max(0, resetMs - Date.now()) + 1000;
    }

    return 60_000;
  }

  private assertNoGraphQLErrors(body: any, context: string): void {
    if (!body?.errors) return;

    throw new Error(
      `${context} GraphQL errors: ${JSON.stringify(body.errors)}`,
    );
  }

  // --- Authentication ---

  private createAppJwt(): string {
    const now = Math.floor(Date.now() / 1000);
    return sign(
      { iss: this.appId, iat: now - 60, exp: now + 600 },
      this.privateKey,
      { algorithm: "RS256" },
    );
  }

  private async getInstallationToken(installationId: string): Promise<string> {
    const cached = this.tokenCache.get(installationId);
    if (cached && cached.expiresAt > Date.now() + 60_000) {
      return cached.token;
    }

    const jwt = this.createAppJwt();
    const res = await this.githubFetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
        },
      },
    );

    if (!res.ok) {
      throw new Error(
        `Failed to get installation token: ${res.status} ${await res.text()}`,
      );
    }

    const body = await res.json();
    this.tokenCache.set(installationId, {
      token: body.token,
      expiresAt: new Date(body.expires_at).getTime(),
    });

    return body.token;
  }

  private async getTokenForRepo(repoFullName: string): Promise<string> {
    const repo = await this.repoRepo
      .createQueryBuilder("repo")
      .where("LOWER(repo.repo_full_name) = LOWER(:repoFullName)", {
        repoFullName,
      })
      .getOne();
    if (!repo?.installationId) {
      throw new Error(`No installation for repo ${repoFullName}`);
    }
    return this.getInstallationToken(repo.installationId);
  }

  // --- REST: compare API for merge-base ---

  /**
   * Fetch the merge-base commit SHA between two refs.
   * The merge-base is the common ancestor — the correct "before" state for
   * computing a PR's own changes via tree-diff scoring (which differs from
   * baseRefOid when the base branch has moved forward since PR open).
   */
  async fetchMergeBaseSha(
    repoFullName: string,
    baseSha: string,
    headSha: string,
  ): Promise<string | null> {
    const token = await this.getTokenForRepo(repoFullName);
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await this.githubFetch(
          `https://api.github.com/repos/${repoFullName}/compare/${baseSha}...${headSha}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
            },
          },
        );

        if (res.ok) {
          const data: any = await res.json();
          return data?.merge_base_commit?.sha ?? null;
        }

        if (attempt < maxAttempts) {
          const delay = Math.min(5000 * 2 ** (attempt - 1), 30_000);
          this.logger.warn(
            `Compare API for ${repoFullName} failed: ${res.status} (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms`,
          );
          await new Promise((r) => setTimeout(r, delay));
        }
      } catch (err) {
        if (attempt < maxAttempts) {
          const delay = Math.min(5000 * 2 ** (attempt - 1), 30_000);
          this.logger.warn(
            `Compare API error for ${repoFullName}: ${err} (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms`,
          );
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    this.logger.warn(
      `Compare API for ${repoFullName} failed after ${maxAttempts} attempts`,
    );
    return null;
  }

  // --- GraphQL: PR metadata (closing issues + body + last edit) ---

  /**
   * Fetch PR fields that require GraphQL — closing issue references,
   * body text, and the lastEditedAt timestamp (which is specific to body
   * edits, unlike REST's updated_at which changes on any interaction).
   * Combined into one query to save a round trip.
   */
  async fetchPrMetadata(
    repoFullName: string,
    prNumber: number,
  ): Promise<{
    closingIssueNumbers: number[];
    body: string | null;
    lastEditedAt: string | null;
  }> {
    const [owner, repo] = repoFullName.split("/");
    const token = await this.getTokenForRepo(repoFullName);

    const query = `
      query($owner: String!, $repo: String!, $pr: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $pr) {
            bodyText
            lastEditedAt
            closingIssuesReferences(first: 10) {
              nodes {
                number
                repository { nameWithOwner }
              }
            }
          }
        }
      }
    `;

    const res = await this.githubFetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: { owner, repo, pr: prNumber },
      }),
    });

    if (!res.ok) {
      throw new Error(
        `GraphQL PR metadata fetch failed: ${res.status} ${await res.text()}`,
      );
    }

    const body: any = await res.json();
    this.assertNoGraphQLErrors(body, "PR metadata fetch");

    const pr = body.data?.repository?.pullRequest;
    if (!pr) {
      throw new Error(`GraphQL PR metadata fetch returned no PR data`);
    }

    const nodes = pr.closingIssuesReferences?.nodes ?? [];

    return {
      closingIssueNumbers: this.sameRepoClosingIssueNumbers(
        repoFullName,
        nodes,
      ),
      body: pr.bodyText ?? null,
      lastEditedAt: pr.lastEditedAt ?? null,
    };
  }

  private sameRepoClosingIssueNumbers(
    repoFullName: string,
    nodes: ClosingIssueReference[],
  ): number[] {
    const expectedRepo = repoFullName.toLowerCase();
    return nodes
      .filter(
        (node) =>
          node.repository?.nameWithOwner?.toLowerCase() === expectedRepo,
      )
      .map((node) => node.number)
      .filter((number): number is number => typeof number === "number");
  }

  // --- GraphQL: issue closure (which PR caused the current close) ---

  /**
   * Resolve the PR responsible for an issue's current closed state.
   *
   * Reads `ClosedEvent.closer` from the issue timeline and anchors to the
   * issue's current `closedAt`, so reopen-then-reclose cycles attribute to
   * the latest closer, not whichever PR first declared `Closes #N` in its
   * body. Returns the PR number when the closer is a merged same-repo PR;
   * `null` for manual closes, non-PR closers (commits, projects), or
   * `NOT_PLANNED` closures.
   *
   * Source of truth for `issues.solved_by_pr`. Issue discovery and the
   * issue-bounty solver lookup both read from this field, so they stay 1:1.
   */
  async fetchIssueClosingPr(
    repoFullName: string,
    issueNumber: number,
  ): Promise<number | null> {
    const [owner, repo] = repoFullName.split("/");
    const token = await this.getTokenForRepo(repoFullName);

    const query = `
      query($owner: String!, $repo: String!, $issue: Int!) {
        repository(owner: $owner, name: $repo) {
          issue(number: $issue) {
            closedAt
            timelineItems(itemTypes: [CLOSED_EVENT], last: 20) {
              nodes {
                ... on ClosedEvent {
                  createdAt
                  stateReason
                  closer {
                    __typename
                    ... on PullRequest {
                      number
                      merged
                      state
                      baseRepository { nameWithOwner }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const res = await this.githubFetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: { owner, repo, issue: issueNumber },
      }),
    });

    if (!res.ok) {
      throw new Error(
        `GraphQL issue closure fetch failed: ${res.status} ${await res.text()}`,
      );
    }

    const body: any = await res.json();
    this.assertNoGraphQLErrors(body, "Issue closure fetch");

    const issue = body.data?.repository?.issue;
    if (!issue) return null;

    return this.selectClosingPrFromTimeline(repoFullName, issue);
  }

  private selectClosingPrFromTimeline(
    repoFullName: string,
    issue: {
      closedAt: string | null;
      timelineItems?: { nodes?: any[] };
    },
  ): number | null {
    const closedAt = issue.closedAt;
    if (!closedAt) return null;

    const expectedRepo = repoFullName.toLowerCase();
    const nodes = issue.timelineItems?.nodes ?? [];

    // Walk newest to oldest, find the close event matching the issue's
    // current closedAt. NOT_PLANNED closures (and anything else non-COMPLETED)
    // don't attribute a solver.
    for (let i = nodes.length - 1; i >= 0; i--) {
      const ev = nodes[i];
      if (!ev) continue;
      const stateReason = ev.stateReason;
      if (
        stateReason != null &&
        String(stateReason).toUpperCase() !== "COMPLETED"
      ) {
        continue;
      }
      if (ev.createdAt !== closedAt) continue;
      const closer = ev.closer;
      if (!closer || closer.__typename !== "PullRequest") return null;
      if (
        (closer.baseRepository?.nameWithOwner ?? "").toLowerCase() !==
        expectedRepo
      ) {
        return null;
      }
      const merged =
        closer.merged === true ||
        String(closer.state ?? "").toUpperCase() === "MERGED";
      if (!merged) return null;
      return typeof closer.number === "number" ? closer.number : null;
    }
    return null;
  }

  // --- PR files + contents (REST for list, batched GraphQL for contents) ---

  /**
   * Fetch the PR's file list (REST) and all file contents (batched GraphQL).
   * GraphQL's object(expression: "SHA:path") returns content directly from git
   * blobs, so it works even when fork branches are deleted post-merge. Files
   * are fetched in batches of 50 to avoid GraphQL complexity limits; on
   * failure the batch size halves down to a floor of 5.
   */
  async fetchAndStorePrFiles(
    repoFullName: string,
    prNumber: number,
  ): Promise<void> {
    const [owner, repo] = repoFullName.split("/");
    const token = await this.getTokenForRepo(repoFullName);

    const pr = await this.prRepo.findOneBy({ repoFullName, prNumber });
    if (!pr) {
      throw new Error(`PR ${repoFullName}#${prNumber} not found in DB`);
    }

    // Fetch and store the merge-base SHA. Needed for correct tree-diff
    // scoring — differs from baseSha when base branch has advanced. Recompute
    // on every fetch: a stored value can go stale when head advances via
    // synchronize, leaving base_content pinned to an old ancestor and
    // inflating the scored diff with churn from unrelated PRs.
    if (pr.baseSha && pr.headSha) {
      const mergeBaseSha = await this.fetchMergeBaseSha(
        repoFullName,
        pr.baseSha,
        pr.headSha,
      );
      if (mergeBaseSha) {
        await this.prRepo.update({ repoFullName, prNumber }, { mergeBaseSha });
        pr.mergeBaseSha = mergeBaseSha;
      }
    }

    // 1. Fetch file list via REST
    const files = await this.fetchAllPrFiles(owner, repo, prNumber, token);

    // Clear any stale data for this PR (e.g. after a synchronize event)
    await this.prFileRepo.delete({ repoFullName, prNumber });
    await this.prFileContentRepo.delete({ repoFullName, prNumber });

    // 2. Upsert file metadata
    for (const file of files) {
      await this.prFileRepo.upsert(
        {
          repoFullName,
          prNumber,
          filename: file.filename,
          previousFilename: file.previous_filename ?? null,
          status: file.status,
          additions: file.additions ?? 0,
          deletions: file.deletions ?? 0,
          changes: file.changes ?? 0,
        },
        ["repoFullName", "prNumber", "filename"],
      );
    }

    // 3. Fetch file contents in batches (base + head in one GraphQL call each)
    if (!pr.headSha) {
      throw new Error(
        `PR ${repoFullName}#${prNumber} has no head SHA; cannot fetch content`,
      );
    }

    // Prefer merge-base SHA (true common ancestor) over base SHA for
    // fetching the "before" version of files. Falls back to base SHA if
    // merge-base couldn't be resolved.
    const baseForContents = pr.mergeBaseSha ?? pr.baseSha;

    await this.fetchAndStoreBatchedContents(
      repoFullName,
      prNumber,
      files,
      owner,
      repo,
      token,
      pr.headSha,
      baseForContents,
    );
  }

  private async fetchAllPrFiles(
    owner: string,
    repo: string,
    prNumber: number,
    token: string,
  ): Promise<any[]> {
    const maxAttempts = 3;
    let perPage = 100;
    let attempt = 0;

    while (attempt < maxAttempts) {
      try {
        const files: any[] = [];
        let page = 1;

        while (true) {
          const res = await this.githubFetch(
            `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=${perPage}&page=${page}`,
            {
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.github+json",
              },
            },
          );

          // Halve page size on server-side errors (large payload)
          if ([502, 503, 504].includes(res.status)) {
            perPage = Math.max(Math.floor(perPage / 2), 10);
            throw new Error(
              `status ${res.status}, retrying with per_page=${perPage}`,
            );
          }

          if (!res.ok) {
            throw new Error(
              `Failed to fetch PR files: ${res.status} ${await res.text()}`,
            );
          }

          const batch = await res.json();
          files.push(...batch);

          if (batch.length < perPage) return files;
          page++;
        }
      } catch (err) {
        attempt++;
        if (attempt >= maxAttempts) throw err;
        const delay = Math.min(5000 * 2 ** (attempt - 1), 30_000);
        this.logger.warn(
          `PR files fetch failed (attempt ${attempt}/${maxAttempts}): ${err}. Retrying in ${delay}ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    return [];
  }

  /**
   * Batched GraphQL fetch of base + head contents for all files in the PR.
   * On complexity/size errors, batch size halves (50 → 25 → 12 → 6 → 5 floor).
   */
  private async fetchAndStoreBatchedContents(
    repoFullName: string,
    prNumber: number,
    files: any[],
    owner: string,
    repo: string,
    token: string,
    headSha: string,
    baseSha: string | null,
  ): Promise<void> {
    // Added files have only a head blob; removed files have only a base blob.
    // Keep removed files when a base SHA is available so deletion scoring has
    // the content that existed before the PR.
    const contentFiles = files.filter(
      (f) => f.status !== "removed" || baseSha !== null,
    );
    if (contentFiles.length === 0) return;

    let batchSize = GRAPHQL_FILES_BATCH_SIZE;
    const minBatchSize = 5;

    for (let i = 0; i < contentFiles.length; ) {
      const batch = contentFiles.slice(i, i + batchSize);
      try {
        await this.fetchContentBatch(
          repoFullName,
          prNumber,
          batch,
          owner,
          repo,
          token,
          headSha,
          baseSha,
        );
        i += batch.length;
      } catch (err) {
        if (batchSize > minBatchSize) {
          const newSize = Math.max(Math.floor(batchSize / 2), minBatchSize);
          this.logger.warn(
            `GraphQL content batch failed (size=${batchSize}): ${err}. Halving to ${newSize}`,
          );
          batchSize = newSize;
          // Retry same i with smaller batch
        } else {
          throw new Error(
            `GraphQL content batch failed at min size ${minBatchSize}: ${err}`,
          );
        }
      }
    }
  }

  private async fetchContentBatch(
    repoFullName: string,
    prNumber: number,
    batch: any[],
    owner: string,
    repo: string,
    token: string,
    headSha: string,
    baseSha: string | null,
  ): Promise<void> {
    const fields: string[] = [];
    for (let i = 0; i < batch.length; i++) {
      const file = batch[i];
      // Base version — skip for added files or if we have no base SHA
      if (file.status !== "added" && baseSha) {
        const basePath = file.previous_filename ?? file.filename;
        const baseExpr = this.escapeGraphql(`${baseSha}:${basePath}`);
        fields.push(
          `base${i}: object(expression: "${baseExpr}") { ... on Blob { text byteSize isBinary } }`,
        );
      }
      // Removed files do not exist at head; store a null headContent while
      // still fetching the base blob above.
      if (file.status !== "removed") {
        const headExpr = this.escapeGraphql(`${headSha}:${file.filename}`);
        fields.push(
          `head${i}: object(expression: "${headExpr}") { ... on Blob { text byteSize isBinary } }`,
        );
      }
    }

    const query = `
      query($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) {
          ${fields.join("\n          ")}
        }
      }
    `;

    const res = await this.githubFetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: { owner, repo },
      }),
    });

    if (!res.ok) {
      throw new Error(
        `GraphQL content fetch failed: ${res.status} ${await res.text()}`,
      );
    }

    const body: any = await res.json();
    this.assertNoGraphQLErrors(body, "Content fetch");

    const repoData = body.data?.repository ?? {};

    for (let i = 0; i < batch.length; i++) {
      const file = batch[i];

      const baseBlob = repoData[`base${i}`];
      const headBlob = repoData[`head${i}`];

      const isBinary = !!headBlob?.isBinary || !!baseBlob?.isBinary;

      const headContent = this.extractBlobText(headBlob);
      const baseContent = this.extractBlobText(baseBlob);
      const byteSize = headBlob?.byteSize ?? baseBlob?.byteSize ?? null;

      await this.prFileContentRepo.upsert(
        {
          repoFullName,
          prNumber,
          filename: file.filename,
          baseContent,
          headContent,
          isBinary,
          byteSize,
        },
        ["repoFullName", "prNumber", "filename"],
      );
    }
  }

  private extractBlobText(blob: any): string | null {
    if (!blob) return null;
    if (blob.isBinary) return null;
    if (
      typeof blob.byteSize === "number" &&
      blob.byteSize > MAX_FILE_SIZE_BYTES
    ) {
      return null;
    }
    return blob.text ?? null;
  }

  private escapeGraphql(s: string): string {
    // GraphQL string literals follow the same escape rules as JSON strings —
    // reuse the JSON encoder, stripping the surrounding quotes. Covers
    // backslash, double-quote, newlines, tabs, and control characters.
    const json = JSON.stringify(s);
    return json.slice(1, -1);
  }

  // --- Backfill ---

  /**
   * Page through GraphQL for PRs in a repo created within the last N days.
   * Upserts each PR. Returns the list of PR numbers so the caller can
   * enqueue follow-up fetch jobs for diffs + closing issues.
   */
  async backfillPullRequests(
    repoFullName: string,
    sinceDate: Date,
  ): Promise<
    { prNumber: number; headSha: string | null; baseSha: string | null }[]
  > {
    const [owner, repo] = repoFullName.split("/");
    const token = await this.getTokenForRepo(repoFullName);

    const query = `
      query($owner: String!, $repo: String!, $cursor: String) {
        repository(owner: $owner, name: $repo) {
          defaultBranchRef { name }
          pullRequests(
            first: 50,
            after: $cursor,
            orderBy: {field: CREATED_AT, direction: DESC}
          ) {
            pageInfo { hasNextPage endCursor }
            nodes {
              number
              title
              bodyText
              state
              createdAt
              closedAt
              mergedAt
              lastEditedAt
              merged
              author {
                login
                ... on User { databaseId }
                ... on Bot { databaseId }
              }
              authorAssociation
              mergedBy { login }
              baseRef { name }
              headRef { name }
              headRepository { nameWithOwner }
              baseRefOid
              headRefOid
              additions
              deletions
              commits { totalCount }
              labels(first: 10) { nodes { name } }
              reviews(first: 10) {
                nodes {
                  submittedAt
                  state
                  authorAssociation
                  author {
                    login
                    ... on User { databaseId }
                    ... on Bot { databaseId }
                  }
                }
              }
              timelineItems(
                itemTypes: [LABELED_EVENT, UNLABELED_EVENT]
                first: 30
              ) {
                nodes {
                  __typename
                  ... on LabeledEvent {
                    createdAt
                    label { name }
                    actor {
                      login
                      ... on User { databaseId }
                    }
                  }
                  ... on UnlabeledEvent {
                    createdAt
                    label { name }
                    actor {
                      login
                      ... on User { databaseId }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const prs: {
      prNumber: number;
      headSha: string | null;
      baseSha: string | null;
    }[] = [];
    let cursor: string | null = null;
    let defaultBranchWritten = false;

    while (true) {
      const res: Response = await this.githubFetch(
        "https://api.github.com/graphql",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query,
            variables: { owner, repo, cursor },
          }),
        },
      );

      if (!res.ok) {
        throw new Error(
          `Backfill PR GraphQL failed: ${res.status} ${await res.text()}`,
        );
      }

      const body: any = await res.json();
      this.assertNoGraphQLErrors(body, "Backfill PR fetch");

      const repoData: any = body.data?.repository;
      const page: any = repoData?.pullRequests;
      if (!page) {
        throw new Error(`Backfill PR GraphQL returned no pullRequests page`);
      }

      // defaultBranchRef is the same across every page — write once.
      if (!defaultBranchWritten) {
        const defaultBranch: string | null =
          repoData?.defaultBranchRef?.name ?? null;
        if (defaultBranch) {
          await this.repoRepo.update(repoFullName, { defaultBranch });
        }
        defaultBranchWritten = true;
      }

      let shouldStop = false;
      for (const pr of page.nodes) {
        // Ordered DESC by created_at — stop once we cross the cutoff
        if (new Date(pr.createdAt) < sinceDate) {
          shouldStop = true;
          break;
        }

        await this.prRepo.upsert(
          {
            repoFullName,
            prNumber: pr.number,
            authorGithubId: String(pr.author?.databaseId ?? ""),
            authorLogin: pr.author?.login ?? null,
            authorAssociation: pr.authorAssociation ?? null,
            title: pr.title,
            body: pr.bodyText ?? null,
            state: pr.state, // OPEN / CLOSED / MERGED
            createdAt: pr.createdAt,
            closedAt: pr.closedAt ?? null,
            mergedAt: pr.mergedAt ?? null,
            lastEditedAt: pr.lastEditedAt ?? null,
            mergedByLogin: pr.mergedBy?.login ?? null,
            baseRef: pr.baseRef?.name ?? null,
            headRef: pr.headRef?.name ?? null,
            headRepoFullName: pr.headRepository?.nameWithOwner ?? null,
            headSha: pr.headRefOid ?? null,
            baseSha: pr.baseRefOid ?? null,
            additions: pr.additions ?? null,
            deletions: pr.deletions ?? null,
            commitsCount: pr.commits?.totalCount ?? null,
            labels: (pr.labels?.nodes ?? []).map(
              (l: { name: string }) => l.name,
            ),
          },
          ["repoFullName", "prNumber"],
        );

        // Upsert reviews captured in the same query
        const reviewNodes = pr.reviews?.nodes ?? [];
        for (const review of reviewNodes) {
          if (!review?.submittedAt || !review?.author?.databaseId) continue;
          await this.reviewRepo.upsert(
            {
              repoFullName,
              prNumber: pr.number,
              reviewerGithubId: String(review.author.databaseId),
              reviewerLogin: review.author.login ?? null,
              reviewerAssociation: review.authorAssociation ?? null,
              reviewState: review.state,
              submittedAt: review.submittedAt,
            },
            ["repoFullName", "prNumber", "reviewerGithubId", "submittedAt"],
          );
        }

        // Upsert label events (LABELED_EVENT / UNLABELED_EVENT)
        await this.saveLabelTimelineEvents(
          repoFullName,
          pr.number,
          "pr",
          pr.timelineItems?.nodes ?? [],
        );

        prs.push({
          prNumber: pr.number,
          headSha: pr.headRefOid ?? null,
          baseSha: pr.baseRefOid ?? null,
        });
      }

      if (shouldStop || !page.pageInfo.hasNextPage) break;
      cursor = page.pageInfo.endCursor;
    }

    return prs;
  }

  /**
   * Page through GraphQL for issues in a repo created within the last N days.
   * Upserts each issue.
   */
  async backfillIssues(repoFullName: string, sinceDate: Date): Promise<void> {
    const [owner, repo] = repoFullName.split("/");
    const token = await this.getTokenForRepo(repoFullName);

    const query = `
      query($owner: String!, $repo: String!, $cursor: String) {
        repository(owner: $owner, name: $repo) {
          issues(
            first: 50,
            after: $cursor,
            orderBy: {field: CREATED_AT, direction: DESC}
          ) {
            pageInfo { hasNextPage endCursor }
            nodes {
              number
              title
              state
              stateReason
              createdAt
              closedAt
              updatedAt
              lastEditedAt
              author {
                login
                ... on User { databaseId }
                ... on Bot { databaseId }
              }
              authorAssociation
              labels(first: 10) { nodes { name } }
              timelineItems(
                itemTypes: [LABELED_EVENT, UNLABELED_EVENT, TRANSFERRED_EVENT]
                first: 30
              ) {
                nodes {
                  __typename
                  ... on TransferredEvent {
                    createdAt
                  }
                  ... on LabeledEvent {
                    createdAt
                    label { name }
                    actor {
                      login
                      ... on User { databaseId }
                    }
                  }
                  ... on UnlabeledEvent {
                    createdAt
                    label { name }
                    actor {
                      login
                      ... on User { databaseId }
                    }
                  }
                }
              }
              closureTimeline: timelineItems(
                itemTypes: [CLOSED_EVENT]
                last: 20
              ) {
                nodes {
                  ... on ClosedEvent {
                    createdAt
                    stateReason
                    closer {
                      __typename
                      ... on PullRequest {
                        number
                        merged
                        state
                        baseRepository { nameWithOwner }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    let cursor: string | null = null;

    while (true) {
      const res: Response = await this.githubFetch(
        "https://api.github.com/graphql",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query,
            variables: { owner, repo, cursor },
          }),
        },
      );

      if (!res.ok) {
        throw new Error(
          `Backfill issue GraphQL failed: ${res.status} ${await res.text()}`,
        );
      }

      const body: any = await res.json();
      this.assertNoGraphQLErrors(body, "Backfill issue fetch");

      const page: any = body.data?.repository?.issues;
      if (!page) {
        throw new Error(`Backfill issue GraphQL returned no issues page`);
      }

      let shouldStop = false;
      for (const issue of page.nodes) {
        if (new Date(issue.createdAt) < sinceDate) {
          shouldStop = true;
          break;
        }

        const issueData: Partial<Issue> = {
          repoFullName,
          issueNumber: issue.number,
          authorGithubId: String(issue.author?.databaseId ?? ""),
          authorLogin: issue.author?.login ?? null,
          authorAssociation: issue.authorAssociation ?? null,
          title: issue.title,
          state: issue.state, // OPEN / CLOSED
          stateReason: issue.stateReason ?? null,
          createdAt: issue.createdAt,
          closedAt: issue.closedAt ?? null,
          updatedAt: issue.updatedAt ?? null,
          lastEditedAt: issue.lastEditedAt ?? null,
          labels: (issue.labels?.nodes ?? []).map(
            (l: { name: string }) => l.name,
          ),
        };

        if (
          (issue.timelineItems?.nodes ?? []).some(
            (node: { __typename?: string }) =>
              node.__typename === "TransferredEvent",
          )
        ) {
          issueData.isTransferred = true;
        }

        issueData.solvedByPr =
          issue.state === "CLOSED"
            ? this.selectClosingPrFromTimeline(repoFullName, {
                closedAt: issue.closedAt ?? null,
                timelineItems: { nodes: issue.closureTimeline?.nodes ?? [] },
              })
            : null;

        await this.issueRepo.upsert(issueData, ["repoFullName", "issueNumber"]);

        // Upsert label events for this issue
        await this.saveLabelTimelineEvents(
          repoFullName,
          issue.number,
          "issue",
          issue.timelineItems?.nodes ?? [],
        );
      }

      if (shouldStop || !page.pageInfo.hasNextPage) break;
      cursor = page.pageInfo.endCursor;
    }
  }

  /**
   * Insert LABELED_EVENT / UNLABELED_EVENT timeline nodes into label_events.
   * Idempotent: relies on the uq_label_events_natural_key UNIQUE index so
   * re-running backfill (or BullMQ retries) collapses to a no-op for events
   * already written. Actor role is resolved at read time via
   * contributor_repo_roles using stored PR/issue, review, and comment
   * association evidence; GraphQL's actor type doesn't expose authorAssociation.
   */
  private async saveLabelTimelineEvents(
    repoFullName: string,
    targetNumber: number,
    targetType: "pr" | "issue",
    nodes: any[],
  ): Promise<void> {
    const rows = nodes
      .filter((node) => node && node.label?.name && node.createdAt)
      .map((node) => ({
        repoFullName,
        targetNumber,
        targetType,
        labelName: node.label.name,
        action: node.__typename === "LabeledEvent" ? "labeled" : "unlabeled",
        actorGithubId: node.actor?.databaseId
          ? String(node.actor.databaseId)
          : null,
        actorLogin: node.actor?.login ?? null,
        timestamp: node.createdAt,
      }));

    if (rows.length === 0) return;

    await this.labelEventRepo
      .createQueryBuilder()
      .insert()
      .values(rows)
      .orIgnore()
      .execute();
  }
}
