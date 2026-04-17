import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { PullRequest, Issue } from "../entities";

@Injectable()
export class ContributorsService {
  constructor(
    @InjectRepository(PullRequest)
    private readonly prRepo: Repository<PullRequest>,
    @InjectRepository(Issue)
    private readonly issueRepo: Repository<Issue>,
  ) {}

  async getScoringInputs(githubId: string, since?: string): Promise<unknown[]> {
    const qb = this.prRepo
      .createQueryBuilder("p")
      .select([
        "p.repo_full_name AS repo_full_name",
        "p.pr_number AS pr_number",
        "p.title AS title",
        "p.body AS body",
        "p.author_github_id AS author_github_id",
        "p.author_login AS author_login",
        "p.author_association AS author_association",
        "p.state AS state",
        "p.labels AS labels",
        "p.created_at AS created_at",
        "p.closed_at AS closed_at",
        "p.merged_at AS merged_at",
        "p.last_edited_at AS last_edited_at",
        "p.merged_by_login AS merged_by_login",
        "p.base_ref AS base_ref",
        "p.head_sha AS head_sha",
        "p.base_sha AS base_sha",
        "p.merge_base_sha AS merge_base_sha",
        "p.additions AS additions",
        "p.deletions AS deletions",
        "p.commits_count AS commits_count",
        "p.closing_issue_numbers AS closing_issue_numbers",
        "p.scoring_data_stored AS scoring_data_stored",
        "CASE WHEN p.last_edited_at > p.merged_at THEN TRUE ELSE FALSE END AS edited_after_merge",
        "EXTRACT(EPOCH FROM (NOW() - p.merged_at)) / 3600.0 AS hours_since_merge",
        "COALESCE(r.maintainer_changes_requested_count, 0) AS maintainer_changes_requested_count",
        "COALESCE(r.changes_requested_count, 0) AS changes_requested_count",
        "COALESCE(r.approved_count, 0) AS approved_count",
        "COALESCE(r.commented_count, 0) AS commented_count",
      ])
      .leftJoin(
        "pr_review_summary",
        "r",
        "r.repo_full_name = p.repo_full_name AND r.pr_number = p.pr_number",
      )
      .where("p.author_github_id = :githubId", { githubId })
      .orderBy("p.created_at", "DESC");

    if (since) {
      qb.andWhere("p.created_at >= :since", { since });
    }

    return qb.getRawMany();
  }

  async getCounts(
    githubId: string,
    days: number,
  ): Promise<{ prCounts: unknown[]; issueCounts: unknown[] }> {
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - days);

    const prCounts = await this.prRepo
      .createQueryBuilder("p")
      .select("p.repo_full_name", "repo_full_name")
      .addSelect("COUNT(*) FILTER (WHERE p.state = 'MERGED')", "merged_count")
      .addSelect("COUNT(*) FILTER (WHERE p.state = 'CLOSED')", "closed_count")
      .addSelect("COUNT(*) FILTER (WHERE p.state = 'OPEN')", "open_count")
      .addSelect(
        "MIN(p.merged_at) FILTER (WHERE p.state = 'MERGED')",
        "earliest_merge_at",
      )
      .where("p.author_github_id = :githubId", { githubId })
      .andWhere("p.created_at >= :since", { since: sinceDate })
      .groupBy("p.repo_full_name")
      .getRawMany();

    const issueCounts = await this.issueRepo
      .createQueryBuilder("i")
      .select("i.repo_full_name", "repo_full_name")
      .addSelect("COUNT(*) FILTER (WHERE i.state = 'CLOSED')", "closed_count")
      .addSelect("COUNT(*) FILTER (WHERE i.state = 'OPEN')", "open_count")
      .where("i.author_github_id = :githubId", { githubId })
      .andWhere("i.created_at >= :since", { since: sinceDate })
      .groupBy("i.repo_full_name")
      .getRawMany();

    return { prCounts, issueCounts };
  }
}
