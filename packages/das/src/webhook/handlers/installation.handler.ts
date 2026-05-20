/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any */
import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Repo } from "../../entities";

@Injectable()
export class InstallationHandler {
  private readonly logger = new Logger(InstallationHandler.name);

  constructor(
    @InjectRepository(Repo)
    private readonly repoRepo: Repository<Repo>,
  ) {}

  async handle(event: string, payload: Record<string, any>): Promise<void> {
    const installationId = payload.installation?.id;

    if (event === "installation" && payload.action === "deleted") {
      // App uninstalled — soft-clear all repos for this installation.
      // Data stays (historical scoring evidence); ingestion stops via registered=false.
      this.logger.warn(
        `Installation ${installationId} deleted, clearing repos`,
      );
      await this.repoRepo
        .createQueryBuilder()
        .update()
        .set({ installationId: null, registered: false })
        .where("installationId = :id", { id: String(installationId) })
        .execute();
      return;
    }

    // installation_repositories.added or installation.created
    // Row is created with registered=false (DB default). Backfill + ingestion stay
    // off until registered is flipped true — manually today, via on-chain reconciler later.
    const repos: any[] =
      payload.repositories ?? payload.repositories_added ?? [];

    for (const repo of repos) {
      // Atomic upsert: insert with addedAt on first encounter; on conflict only
      // update installationId so addedAt is never overwritten on re-fires.
      await this.repoRepo
        .createQueryBuilder()
        .insert()
        .into(Repo)
        .values({
          repoFullName: repo.full_name,
          installationId: String(installationId),
          addedAt: new Date().toISOString(),
        })
        .orUpdate(["installationId"], ["repoFullName"])
        .execute();
      this.logger.log(`Tracking repo: ${repo.full_name}`);
    }

    // installation_repositories.removed — soft clear, preserve historical data.
    const removed: any[] = payload.repositories_removed ?? [];
    for (const repo of removed) {
      await this.repoRepo.update(repo.full_name, {
        installationId: null,
        registered: false,
      });
      this.logger.log(`Stopped tracking repo: ${repo.full_name}`);
    }
  }
}
