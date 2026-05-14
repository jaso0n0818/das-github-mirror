/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment */
import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";

interface DashboardIssueRow {
  repo_full_name: string;
  issue_number: number;
  author_github_id: string | null;
  created_at: string;
  closed_at: string | null;
  state: string;
  state_reason: string | null;
  solving_pr: { merged_at: string } | null;
}

@Injectable()
export class DashboardService {
  constructor(private readonly dataSource: DataSource) {}

  async getIssues(since: string): Promise<{
    since: string;
    generated_at: string;
    issues: DashboardIssueRow[];
  }> {
    const rows = await this.dataSource.query(
      `
      SELECT
        LOWER(i.repo_full_name)  AS repo_full_name,
        i.issue_number,
        i.author_github_id,
        i.created_at,
        i.closed_at,
        i.state,
        i.state_reason,
        (
          SELECT json_build_object('merged_at', sp.merged_at)
          FROM pull_requests sp
          WHERE sp.repo_full_name = i.repo_full_name
            AND sp.pr_number      = i.solved_by_pr
            AND sp.merged_at IS NOT NULL
          LIMIT 1
        ) AS solving_pr
      FROM issues i
      WHERE
        i.created_at >= $1
        OR (i.state = 'CLOSED' AND i.closed_at >= $1)
      ORDER BY i.created_at DESC
      `,
      [since],
    );

    return {
      since,
      generated_at: new Date().toISOString(),
      issues: rows as DashboardIssueRow[],
    };
  }
}
