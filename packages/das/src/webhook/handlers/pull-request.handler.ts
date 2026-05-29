/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any */
import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { InjectQueue } from "@nestjs/bullmq";
import { Repository } from "typeorm";
import { Queue } from "bullmq";
import { PullRequest, Repo } from "../../entities";
import { FETCH_QUEUE, FETCH_JOBS, prFilesJobId } from "../../queue/constants";

@Injectable()
export class PullRequestHandler {
  private readonly logger = new Logger(PullRequestHandler.name);

  constructor(
    @InjectRepository(PullRequest)
    private readonly prRepo: Repository<PullRequest>,
    @InjectRepository(Repo)
    private readonly repoRepo: Repository<Repo>,
    @InjectQueue(FETCH_QUEUE)
    private readonly fetchQueue: Queue,
  ) {}

  async handle(payload: Record<string, any>): Promise<void> {
    const pr = payload.pull_request;
    const repoFullName: string = payload.repository.full_name;
    const prNumber: number = pr.number;
    const action: string = payload.action;

    const data: Partial<PullRequest> = {
      repoFullName,
      prNumber,
      authorGithubId: String(pr.user.id),
      authorLogin: pr.user.login,
      authorAssociation: pr.author_association,
      title: pr.title,
      state: pr.merged && pr.merged_at ? "MERGED" : pr.state.toUpperCase(),
      createdAt: pr.created_at,
      closedAt: pr.closed_at ?? null,
      mergedAt: pr.merged_at ?? null,
      // last_edited_at is populated by the fetch-pr-metadata job via GraphQL —
      // REST's updated_at changes on any interaction, not just body edits.
      mergedByLogin: pr.merged_by?.login ?? null,
      baseRef: pr.base?.ref ?? null,
      headRef: pr.head?.ref ?? null,
      headRepoFullName: pr.head?.repo?.full_name ?? null,
      headSha: pr.head?.sha ?? null,
      baseSha: pr.base?.sha ?? null,
      additions: pr.additions ?? null,
      deletions: pr.deletions ?? null,
      commitsCount: pr.commits ?? null,
      labels: (pr.labels ?? []).map((l: any) => l.name),
    };

    await this.prRepo.upsert(data, ["repoFullName", "prNumber"]);

    const repoUpdate: Partial<Repo> = {
      lastEventAt: new Date().toISOString(),
    };
    const defaultBranch: string | null =
      payload.repository?.default_branch ?? null;
    if (defaultBranch) {
      repoUpdate.defaultBranch = defaultBranch;
    }
    await this.repoRepo.update(repoFullName, repoUpdate);

    // Enqueue metadata fetch (closing issues + body + lastEditedAt) on relevant actions.
    // Also run on `edited` so post-merge body edits are captured.
    const metadataActions = [
      "opened",
      "synchronize",
      "closed",
      "reopened",
      "edited",
    ];
    if (metadataActions.includes(action)) {
      const jobId = `meta-${repoFullName}-${prNumber}`;
      await this.fetchQueue.add(
        FETCH_JOBS.PR_METADATA,
        { repoFullName, prNumber },
        {
          jobId,
          // Pending/active jobs for the same PR still dedupe by jobId.
          // Don't retain failed jobs — they'd block future enqueues for this
          // PR until the failed-set cap evicts them (#75).
          removeOnComplete: true,
          removeOnFail: true,
          attempts: 3,
          backoff: { type: "exponential", delay: 5000 },
        },
      );
    }

    // Enqueue diff fetch on open, push, or merge
    const diffActions = ["opened", "synchronize", "closed"];
    const shouldFetchDiff =
      diffActions.includes(action) && (action !== "closed" || pr.merged);

    if (shouldFetchDiff) {
      // Reset scoring flag on new pushes
      if (action === "synchronize") {
        await this.prRepo.update(
          { repoFullName, prNumber },
          { scoringDataStored: false },
        );
      }

      const expectedHeadSha = data.headSha ?? null;
      const expectedBaseSha = data.baseSha ?? null;
      const jobId = prFilesJobId(
        repoFullName,
        prNumber,
        expectedHeadSha,
        expectedBaseSha,
      );
      await this.fetchQueue.add(
        FETCH_JOBS.PR_FILES,
        { repoFullName, prNumber, expectedHeadSha, expectedBaseSha },
        {
          jobId,
          removeOnComplete: true,
          removeOnFail: true,
          attempts: 3,
          backoff: { type: "exponential", delay: 5000 },
        },
      );
    }
  }
}
