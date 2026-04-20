/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { Injectable, NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";

@Injectable()
export class PullsService {
  constructor(private readonly dataSource: DataSource) {}

  async getFiles(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<unknown> {
    const repoFullName = `${owner}/${repo}`;

    const rows = await this.dataSource.query(
      `
      SELECT
        p.repo_full_name,
        p.pr_number,
        p.head_sha,
        p.base_sha,
        p.merge_base_sha,
        p.scoring_data_stored,
        COALESCE((
          SELECT json_agg(json_build_object(
            'filename',          f.filename,
            'previous_filename', f.previous_filename,
            'status',            f.status,
            'additions',         f.additions,
            'deletions',         f.deletions,
            'changes',           f.changes,
            'is_binary',         COALESCE(fc.is_binary, false),
            'byte_size',         fc.byte_size,
            'head_content',      fc.head_content,
            'base_content',      fc.base_content
          ))
          FROM pr_files f
          LEFT JOIN pr_file_contents fc
            ON fc.repo_full_name = f.repo_full_name
           AND fc.pr_number      = f.pr_number
           AND fc.filename       = f.filename
          WHERE f.repo_full_name = p.repo_full_name
            AND f.pr_number      = p.pr_number
        ), '[]'::json) AS files
      FROM pull_requests p
      WHERE p.repo_full_name = $1
        AND p.pr_number      = $2
      `,
      [repoFullName, prNumber],
    );

    if (rows.length === 0) {
      throw new NotFoundException(
        `PR ${repoFullName}#${prNumber} not found in mirror`,
      );
    }

    return rows[0];
  }
}
