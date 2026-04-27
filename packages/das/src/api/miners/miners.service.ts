/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment */
import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";

const DEFAULT_SINCE_DAYS = 35;

@Injectable()
export class MinersService {
  constructor(private readonly dataSource: DataSource) {}

  async getPullRequests(
    githubId: string,
    since: string,
  ): Promise<{
    github_id: string;
    since: string;
    generated_at: string;
    pull_requests: unknown[];
  }> {
    const rows = await this.dataSource.query(
      `
      SELECT
        p.repo_full_name,
        p.pr_number,
        p.title,
        p.body,
        p.state,
        p.author_github_id,
        p.author_login,
        p.author_association,
        p.created_at,
        p.closed_at,
        p.merged_at,
        p.last_edited_at,
        p.merged_by_login,
        p.base_ref,
        p.head_ref,
        p.head_repo_full_name,
        r.default_branch,
        p.head_sha,
        p.base_sha,
        p.merge_base_sha,
        p.additions,
        p.deletions,
        p.commits_count,
        p.scoring_data_stored,
        (p.last_edited_at IS NOT NULL AND p.merged_at IS NOT NULL AND p.last_edited_at > p.merged_at)
          AS edited_after_merge,
        CASE
          WHEN p.merged_at IS NOT NULL
            THEN ROUND(
              (EXTRACT(EPOCH FROM (NOW() - p.merged_at)) / 3600.0)::numeric, 2
            )::float8
          ELSE NULL
        END AS hours_since_merge,
        json_build_object(
          'maintainer_changes_requested_count', COALESCE(rs.maintainer_changes_requested_count, 0),
          'changes_requested_count',             COALESCE(rs.changes_requested_count, 0),
          'approved_count',                      COALESCE(rs.approved_count, 0),
          'commented_count',                     COALESCE(rs.commented_count, 0)
        ) AS review_summary,
        COALESCE((
          SELECT json_agg(json_build_object(
            'name',              plt.label_name,
            'actor_github_id',   plt.actor_github_id,
            'actor_association', plt.actor_association
          ))
          FROM pr_labels_by_actor plt
          WHERE plt.repo_full_name = p.repo_full_name
            AND plt.pr_number      = p.pr_number
        ), '[]'::json) AS labels,
        COALESCE((
          SELECT json_agg(json_build_object(
            'number',             li.issue_number,
            'title',              li.issue_title,
            'state',              li.issue_state,
            'state_reason',       li.issue_state_reason,
            'author_github_id',   li.issue_author_github_id,
            'author_association', li.issue_author_association,
            'created_at',         li.issue_created_at,
            'closed_at',          li.issue_closed_at,
            'updated_at',         li.issue_updated_at,
            'is_transferred',     li.is_transferred,
            'solved_by_pr',       li.issue_solved_by_pr,
            'labels',             COALESCE((
              SELECT json_agg(json_build_object(
                'name',              ilt.label_name,
                'actor_github_id',   ilt.actor_github_id,
                'actor_association', ilt.actor_association
              ))
              FROM issue_labels_by_actor ilt
              WHERE ilt.repo_full_name = li.repo_full_name
                AND ilt.issue_number   = li.issue_number
            ), '[]'::json)
          ))
          FROM pr_linked_issues li
          WHERE li.repo_full_name = p.repo_full_name
            AND li.pr_number      = p.pr_number
        ), '[]'::json) AS linked_issues
      FROM pull_requests p
      LEFT JOIN pr_review_summary rs
        ON rs.repo_full_name = p.repo_full_name
       AND rs.pr_number      = p.pr_number
      LEFT JOIN repos r
        ON r.repo_full_name = p.repo_full_name
      WHERE p.author_github_id = $1
        AND (
          (p.state = 'OPEN'   AND p.created_at >= $2)
          OR (p.state = 'MERGED' AND p.merged_at >= $2)
          OR (p.state = 'CLOSED' AND p.created_at >= $2)
        )
      ORDER BY p.created_at DESC
      `,
      [githubId, since],
    );

    return {
      github_id: githubId,
      since,
      generated_at: new Date().toISOString(),
      pull_requests: rows,
    };
  }

  async getIssues(
    githubId: string,
    since: string,
  ): Promise<{
    github_id: string;
    since: string;
    generated_at: string;
    issues: unknown[];
  }> {
    const rows = await this.dataSource.query(
      `
      SELECT
        i.repo_full_name,
        i.issue_number,
        i.title,
        i.state,
        i.state_reason,
        i.author_github_id,
        i.author_login,
        i.author_association,
        i.created_at,
        i.closed_at,
        i.updated_at,
        i.last_edited_at,
        i.is_transferred,
        i.solved_by_pr,
        COALESCE((
          SELECT json_agg(json_build_object(
            'name',              ilt.label_name,
            'actor_github_id',   ilt.actor_github_id,
            'actor_association', ilt.actor_association
          ))
          FROM issue_labels_by_actor ilt
          WHERE ilt.repo_full_name = i.repo_full_name
            AND ilt.issue_number   = i.issue_number
        ), '[]'::json) AS labels,
        (
          SELECT json_build_object(
            'pr_number',         sp.pr_number,
            'author_github_id',  sp.author_github_id,
            'state',             sp.state,
            'merged_at',         sp.merged_at,
            'hours_since_merge',
              CASE WHEN sp.merged_at IS NOT NULL
                THEN ROUND(
                  (EXTRACT(EPOCH FROM (NOW() - sp.merged_at)) / 3600.0)::numeric, 2
                )::float8
                ELSE NULL END,
            'edited_after_merge',
              (sp.last_edited_at IS NOT NULL
                AND sp.merged_at IS NOT NULL
                AND sp.last_edited_at > sp.merged_at),
            'head_sha',          sp.head_sha,
            'base_sha',          sp.base_sha,
            'merge_base_sha',    sp.merge_base_sha,
            'labels', COALESCE((
              SELECT json_agg(json_build_object(
                'name',              plt.label_name,
                'actor_github_id',   plt.actor_github_id,
                'actor_association', plt.actor_association
              ))
              FROM pr_labels_by_actor plt
              WHERE plt.repo_full_name = sp.repo_full_name
                AND plt.pr_number      = sp.pr_number
            ), '[]'::json),
            'review_summary', json_build_object(
              'maintainer_changes_requested_count',
                COALESCE(rs.maintainer_changes_requested_count, 0)
            )
          )
          FROM pull_requests sp
          LEFT JOIN pr_review_summary rs
            ON rs.repo_full_name = sp.repo_full_name
           AND rs.pr_number      = sp.pr_number
          WHERE sp.repo_full_name = i.repo_full_name
            AND sp.pr_number      = i.solved_by_pr
        ) AS solving_pr
      FROM issues i
      WHERE i.author_github_id = $1
        AND (
          (i.state = 'OPEN'   AND i.created_at >= $2)
          OR (i.state = 'CLOSED' AND i.closed_at >= $2)
        )
      ORDER BY i.created_at DESC
      `,
      [githubId, since],
    );

    return {
      github_id: githubId,
      since,
      generated_at: new Date().toISOString(),
      issues: rows,
    };
  }

  /**
   * Parse a `since` query param into an ISO timestamp. If not provided, defaults
   * to DEFAULT_SINCE_DAYS days ago (midnight UTC of that day).
   */
  static resolveSince(since?: string): string {
    if (since) return since;
    const d = new Date();
    d.setDate(d.getDate() - DEFAULT_SINCE_DAYS);
    d.setUTCHours(0, 0, 0, 0);
    return d.toISOString();
  }
}
