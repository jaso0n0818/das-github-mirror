import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Repo } from "../entities";
import {
  GitHubFetcherService,
  MaintainerRole,
} from "../webhook/github-fetcher.service";

// The four tables that carry a per-row GitHub author/reviewer association —
// the same set the contributor_repo_roles view reads. Normalizing all four
// keeps /maintainers, the maintainer_cut carve-out, and the issue-bonus tier
// agreeing on one source of truth: GitHub's *current* roles.
const ASSOCIATION_TABLES = [
  {
    table: "pull_requests",
    idCol: "author_github_id",
    assocCol: "author_association",
  },
  {
    table: "issues",
    idCol: "author_github_id",
    assocCol: "author_association",
  },
  {
    table: "comments",
    idCol: "author_github_id",
    assocCol: "author_association",
  },
  {
    table: "reviews",
    idCol: "reviewer_github_id",
    assocCol: "reviewer_association",
  },
] as const;

@Injectable()
export class MaintainerRoleReconcileService {
  private readonly logger = new Logger(MaintainerRoleReconcileService.name);

  constructor(
    private readonly fetcher: GitHubFetcherService,
    @InjectRepository(Repo)
    private readonly repoRepo: Repository<Repo>,
  ) {}

  // author_association is snapshotted at ingest and never refreshed by the
  // webhook path, so a contributor who becomes (or stops being) a maintainer
  // after filing keeps a stale role on every historical row — e.g. a private
  // collaborator's issues stay CONTRIBUTOR forever, costing solvers the
  // maintainer issue-bonus tier. This sweep pulls the live collaborator/member
  // set from GitHub and rewrites the stored association columns to match, for
  // registered + installed repos only.
  @Cron(CronExpression.EVERY_HOUR)
  async reconcile(): Promise<void> {
    const repos: { repo_full_name: string }[] = await this.repoRepo.query(
      `SELECT repo_full_name FROM repos
       WHERE registered = true AND installation_id IS NOT NULL`,
    );
    this.logger.log(`Reconciling maintainer roles for ${repos.length} repos`);

    for (const { repo_full_name } of repos) {
      try {
        await this.reconcileRepo(repo_full_name);
      } catch (err) {
        // Fail closed per repo: a fetch/DB error skips this repo (never demote
        // on partial data) and the next sweep retries it.
        this.logger.error(
          `Maintainer reconcile failed for ${repo_full_name}: ${String(err)}`,
        );
      }
    }
  }

  private async reconcileRepo(repoFullName: string): Promise<void> {
    // Fetch BOTH sets before any write — a partial fetch must never read as a
    // demotion. Hard failures throw and propagate to the per-repo catch above.
    const collaborators =
      await this.fetcher.fetchRepoCollaborators(repoFullName);
    const members = await this.fetcher.fetchOrgMembers(repoFullName);
    const current = this.buildRoleMap(repoFullName, collaborators, members);

    if (current.size === 0) {
      // A real repo always has at least its owner; an empty set means an
      // unexpected (but non-throwing) API response. Skip rather than demote
      // every contributor on the repo.
      this.logger.warn(
        `${repoFullName}: empty maintainer set from GitHub, skipping`,
      );
      return;
    }

    const ids = [...current.keys()];
    let promoted = 0;
    let demoted = 0;

    // Table/column names come from the fixed ASSOCIATION_TABLES list, never
    // user input — safe to interpolate.
    for (const { table, idCol, assocCol } of ASSOCIATION_TABLES) {
      // Promote: align each current maintainer's rows to their live role.
      for (const [githubId, association] of current) {
        const res: unknown[] = await this.repoRepo.query(
          `UPDATE ${table} SET ${assocCol} = $1
           WHERE repo_full_name = $2 AND ${idCol} = $3
             AND ${assocCol} IS DISTINCT FROM $1
           RETURNING 1`,
          [association, repoFullName, githubId],
        );
        promoted += this.affectedRows(res);
      }
      // Demote: anyone still flagged a maintainer who is no longer in the set.
      const res: unknown[] = await this.repoRepo.query(
        `UPDATE ${table} SET ${assocCol} = 'CONTRIBUTOR'
         WHERE repo_full_name = $1
           AND ${assocCol} IN ('OWNER', 'MEMBER', 'COLLABORATOR')
           AND ${idCol} <> ALL($2)
           RETURNING 1`,
        [repoFullName, ids],
      );
      demoted += this.affectedRows(res);
    }

    if (promoted || demoted) {
      this.logger.log(
        `${repoFullName}: ${current.size} maintainers — ` +
          `promoted ${promoted} rows, demoted ${demoted} rows`,
      );
    }
  }

  // Precedence COLLABORATOR < MEMBER < OWNER: org members override direct
  // collaborators, and the repo owner (user-owned repos) outranks both.
  private buildRoleMap(
    repoFullName: string,
    collaborators: MaintainerRole[],
    members: MaintainerRole[],
  ): Map<string, string> {
    const ownerLogin = repoFullName.split("/")[0].toLowerCase();
    const roles = new Map<string, string>();
    for (const c of collaborators) {
      if (c.githubId) roles.set(c.githubId, "COLLABORATOR");
    }
    for (const m of members) {
      if (m.githubId) roles.set(m.githubId, "MEMBER");
    }
    for (const u of [...collaborators, ...members]) {
      if (u.githubId && u.login?.toLowerCase() === ownerLogin) {
        roles.set(u.githubId, "OWNER");
      }
    }
    return roles;
  }

  // `RETURNING 1` makes the affected count the returned row count, which is
  // stable across TypeORM/pg versions (unlike the raw driver result shape).
  private affectedRows(res: unknown): number {
    return Array.isArray(res) ? res.length : 0;
  }
}
