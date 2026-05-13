/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any */
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Issue, Repo } from "../../entities";

@Injectable()
export class IssueHandler {
  constructor(
    @InjectRepository(Issue)
    private readonly issueRepo: Repository<Issue>,
    @InjectRepository(Repo)
    private readonly repoRepo: Repository<Repo>,
  ) {}

  async handle(payload: Record<string, any>): Promise<void> {
    const issue = payload.issue;
    const repoFullName: string = payload.repository.full_name;

    // Skip pull request events delivered as issue events
    if (issue.pull_request) return;

    const issueState = issue.state.toUpperCase();
    const data: Partial<Issue> = {
      repoFullName,
      issueNumber: issue.number,
      authorGithubId: String(issue.user.id),
      authorLogin: issue.user.login,
      authorAssociation: issue.author_association,
      title: issue.title ?? null,
      state: issueState,
      stateReason: issue.state_reason?.toUpperCase() ?? null,
      createdAt: issue.created_at,
      closedAt: issue.closed_at ?? null,
      updatedAt: issue.updated_at ?? null,
      labels: (issue.labels ?? []).map((l: any) => l.name),
    };

    if (issueState === "OPEN") {
      data.solvedByPr = null;
    }

    if (payload.action === "transferred") {
      data.isTransferred = true;
    }

    // The `edited` action fires specifically for body or title changes.
    // Use the webhook's updated_at as the precise edit timestamp — for
    // other actions (labeled, closed, commented, etc.) don't touch
    // last_edited_at so it only reflects actual body/title edits.
    if (payload.action === "edited") {
      data.lastEditedAt = issue.updated_at ?? null;
    }

    await this.issueRepo.upsert(data, ["repoFullName", "issueNumber"]);

    await this.repoRepo.update(repoFullName, {
      lastEventAt: new Date().toISOString(),
    });
  }
}
