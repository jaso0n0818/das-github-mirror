import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { InjectRepository } from "@nestjs/typeorm";
import { Queue } from "bullmq";
import { Repository } from "typeorm";
import { Repo } from "../entities";
import {
  FETCH_QUEUE,
  FETCH_JOBS,
  DEFAULT_BACKFILL_DAYS,
} from "../queue/constants";

// Coarse safety net beneath the per-PR reconcile sweep: periodically re-backfill
// every registered repo from GitHub via GraphQL (authoritative state for PRs +
// issues + labels), catching any drift the targeted open-PR sweep doesn't —
// e.g. issue state, labels, or a PR that was already non-OPEN when last seen.
// Heavier than the reconcile sweep (re-touches every PR in the window), so it
// runs daily and can be disabled on critical infra via env.
const BACKFILL_ENABLED = process.env.NIGHTLY_BACKFILL_ENABLED !== "false";
const BACKFILL_INTERVAL_MS = Number(
  process.env.NIGHTLY_BACKFILL_INTERVAL_MS ?? 24 * 60 * 60 * 1000, // daily
);
const BACKFILL_DAYS = Number(
  process.env.NIGHTLY_BACKFILL_DAYS ?? DEFAULT_BACKFILL_DAYS,
);

@Injectable()
export class RepoBackfillScheduleService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(RepoBackfillScheduleService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(Repo)
    private readonly repoRepo: Repository<Repo>,
    @InjectQueue(FETCH_QUEUE)
    private readonly fetchQueue: Queue,
  ) {}

  onModuleInit(): void {
    if (!BACKFILL_ENABLED) {
      this.logger.log(
        "Nightly repo backfill disabled (NIGHTLY_BACKFILL_ENABLED=false)",
      );
      return;
    }
    // Unlike the reconcile sweep, don't run at startup — a deploy already
    // implies fresh data, and this is the heavy job. Start on the interval.
    this.timer = setInterval(
      () => void this.backfillAll(),
      BACKFILL_INTERVAL_MS,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async backfillAll(): Promise<void> {
    try {
      const repos = await this.repoRepo.find({
        where: { registered: true },
        select: { repoFullName: true },
      });

      this.logger.log(
        `Enqueuing nightly backfill for ${repos.length} repos ` +
          `(last ${BACKFILL_DAYS}d)`,
      );

      for (const repo of repos) {
        await this.fetchQueue.add(
          FETCH_JOBS.BACKFILL_REPO,
          { repoFullName: repo.repoFullName, days: BACKFILL_DAYS },
          {
            // Static per-repo jobId so a still-running nightly backfill isn't
            // stacked on by the next tick. Distinct from the admin endpoint's
            // timestamped ids, so manual backfills are never blocked.
            jobId: `backfill-${repo.repoFullName}-nightly`,
            removeOnComplete: true,
            removeOnFail: true,
            attempts: 2,
            backoff: { type: "exponential", delay: 30000 },
          },
        );
      }
    } catch (err) {
      this.logger.error(`Nightly backfill enqueue failed: ${String(err)}`);
    }
  }
}
