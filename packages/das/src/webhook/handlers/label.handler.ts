/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any */
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { LabelEvent, Issue, PullRequest } from "../../entities";

@Injectable()
export class LabelHandler {
  constructor(
    @InjectRepository(LabelEvent)
    private readonly labelEventRepo: Repository<LabelEvent>,
    @InjectRepository(Issue)
    private readonly issueRepo: Repository<Issue>,
    @InjectRepository(PullRequest)
    private readonly prRepo: Repository<PullRequest>,
  ) {}

  /**
   * Called for issues.labeled/unlabeled and pull_request.labeled/unlabeled events.
   * Logs the event to label_events and updates the labels array on the parent row.
   */
  async handle(
    payload: Record<string, any>,
    source: "issue" | "pr",
  ): Promise<void> {
    const action = payload.action;
    if (action !== "labeled" && action !== "unlabeled") return;

    const repoFullName: string = payload.repository.full_name;
    const label = payload.label;
    const sender = payload.sender;

    const targetNumber: number =
      source === "pr" ? payload.pull_request.number : payload.issue.number;

    // Append to label_events log. Actor's repo role is resolved at read time
    // via contributor_repo_roles using stored PR/issue, review, and comment
    // association evidence; label actors themselves don't expose it.
    await this.labelEventRepo.save({
      repoFullName,
      targetNumber,
      targetType: source,
      labelName: label.name,
      action,
      actorGithubId: sender ? String(sender.id) : null,
      actorLogin: sender?.login ?? null,
      timestamp: new Date().toISOString(),
    });

    // Update current labels snapshot on the parent row
    const currentLabels: string[] =
      source === "pr"
        ? (payload.pull_request.labels ?? []).map((l: any) => l.name)
        : (payload.issue.labels ?? []).map((l: any) => l.name);

    if (source === "pr") {
      await this.prRepo.update(
        { repoFullName, prNumber: targetNumber },
        { labels: currentLabels },
      );
    } else {
      await this.issueRepo.update(
        { repoFullName, issueNumber: targetNumber },
        { labels: currentLabels },
      );
    }
  }
}
