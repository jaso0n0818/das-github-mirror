import { Processor, WorkerHost, InjectQueue } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Job, Queue } from "bullmq";
import { Issue, PullRequest } from "../entities";
import { GitHubFetcherService } from "../webhook/github-fetcher.service";
import { FETCH_QUEUE, FETCH_JOBS, DEFAULT_BACKFILL_DAYS } from "./constants";

export interface PrMetadataJobData {
  repoFullName: string;
  prNumber: number;
}

export interface PrFilesJobData {
  repoFullName: string;
  prNumber: number;
}

export interface BackfillRepoJobData {
  repoFullName: string;
  days?: number;
}

type JobData = PrMetadataJobData | PrFilesJobData | BackfillRepoJobData;

@Processor(FETCH_QUEUE, { concurrency: 5 })
export class FetchProcessor extends WorkerHost {
  private readonly logger = new Logger(FetchProcessor.name);

  constructor(
    private readonly fetcher: GitHubFetcherService,
    @InjectRepository(PullRequest)
    private readonly prRepo: Repository<PullRequest>,
    @InjectRepository(Issue)
    private readonly issueRepo: Repository<Issue>,
    @InjectQueue(FETCH_QUEUE)
    private readonly fetchQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<JobData>): Promise<void> {
    switch (job.name) {
      case FETCH_JOBS.PR_METADATA: {
        const { repoFullName, prNumber } = job.data as PrMetadataJobData;
        await this.handlePrMetadata(repoFullName, prNumber);
        break;
      }
      case FETCH_JOBS.PR_FILES: {
        const { repoFullName, prNumber } = job.data as PrFilesJobData;
        await this.handlePrFiles(repoFullName, prNumber);
        break;
      }
      case FETCH_JOBS.BACKFILL_REPO: {
        const { repoFullName, days } = job.data as BackfillRepoJobData;
        await this.handleBackfill(repoFullName, days ?? DEFAULT_BACKFILL_DAYS);
        break;
      }
      default:
        this.logger.warn(`Unknown job name: ${job.name}`);
    }
  }

  private async handlePrMetadata(
    repoFullName: string,
    prNumber: number,
  ): Promise<void> {
    this.logger.log(`Fetching PR metadata for ${repoFullName}#${prNumber}`);

    const { closingIssueNumbers, body, lastEditedAt } =
      await this.fetcher.fetchPrMetadata(repoFullName, prNumber);

    await this.prRepo.update(
      { repoFullName, prNumber },
      {
        closingIssueNumbers,
        body,
        lastEditedAt,
      },
    );

    // If this PR is merged, mark each linked issue as solved_by_pr
    const pr = await this.prRepo.findOneBy({ repoFullName, prNumber });
    if (pr?.state === "MERGED" && closingIssueNumbers.length > 0) {
      for (const issueNumber of closingIssueNumbers) {
        await this.issueRepo.update(
          { repoFullName, issueNumber },
          { solvedByPr: prNumber },
        );
      }
    }
  }

  private async handlePrFiles(
    repoFullName: string,
    prNumber: number,
  ): Promise<void> {
    this.logger.log(`Fetching PR files for ${repoFullName}#${prNumber}`);

    await this.fetcher.fetchAndStorePrFiles(repoFullName, prNumber);

    await this.prRepo.update(
      { repoFullName, prNumber },
      { scoringDataStored: true },
    );
  }

  private async handleBackfill(
    repoFullName: string,
    days: number,
  ): Promise<void> {
    this.logger.log(`Backfilling ${repoFullName} — last ${days} days`);

    const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Fetch and upsert PRs
    const prs = await this.fetcher.backfillPullRequests(
      repoFullName,
      sinceDate,
    );
    this.logger.log(`Backfilled ${prs.length} PRs from ${repoFullName}`);

    // Enqueue follow-up jobs (metadata + files for every PR).
    for (const { prNumber } of prs) {
      await this.fetchQueue.add(
        FETCH_JOBS.PR_METADATA,
        { repoFullName, prNumber },
        {
          jobId: `meta-${repoFullName}-${prNumber}`,
          removeOnComplete: true,
          removeOnFail: 50,
          attempts: 3,
          backoff: { type: "exponential", delay: 5000 },
        },
      );

      await this.fetchQueue.add(
        FETCH_JOBS.PR_FILES,
        { repoFullName, prNumber },
        {
          jobId: `files-${repoFullName}-${prNumber}`,
          removeOnComplete: true,
          removeOnFail: 50,
          attempts: 3,
          backoff: { type: "exponential", delay: 5000 },
        },
      );
    }

    // Fetch and upsert issues
    await this.fetcher.backfillIssues(repoFullName, sinceDate);
    this.logger.log(`Backfilled issues from ${repoFullName}`);
  }
}
