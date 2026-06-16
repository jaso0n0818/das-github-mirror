import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import {
  Issue,
  LabelEvent,
  PrFile,
  PrFileContent,
  PullRequest,
  Repo,
  Review,
} from "../entities";
import { GitHubFetcherService } from "../webhook/github-fetcher.service";
import { MaintainerRoleReconcileService } from "./maintainer-role-reconcile.service";

@Module({
  // GitHubFetcherService injects these repositories; the reconcile service
  // itself only needs Repo (its UPDATEs run as raw SQL via repoRepo.query).
  // This provides a self-contained GitHubFetcherService instance — its own
  // installation-token cache, independent of the QueueModule copy.
  imports: [
    TypeOrmModule.forFeature([
      Repo,
      PullRequest,
      Issue,
      Review,
      LabelEvent,
      PrFile,
      PrFileContent,
    ]),
  ],
  providers: [GitHubFetcherService, MaintainerRoleReconcileService],
})
export class MaintainerModule {}
