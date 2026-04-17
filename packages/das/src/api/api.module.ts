import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ThrottlerModule } from "@nestjs/throttler";
import { BullModule } from "@nestjs/bullmq";
import {
  Repo,
  PullRequest,
  Issue,
  PrFile,
  PrFileContent,
  LabelEvent,
} from "../entities";
import { FETCH_QUEUE } from "../queue/constants";
import { AdminController } from "./admin.controller";
import { ApiKeyGuard } from "./api-key.guard";
import { RequireApiKeyGuard } from "./require-api-key.guard";
import { ContributorsController } from "./contributors.controller";
import { ContributorsService } from "./contributors.service";
import { HealthController } from "./health.controller";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Repo,
      PullRequest,
      Issue,
      PrFile,
      PrFileContent,
      LabelEvent,
    ]),
    BullModule.registerQueue({ name: FETCH_QUEUE }),
    // Strict per-IP limit for anonymous callers; bypassed by ApiKeyGuard
    // when a valid x-api-key is presented.
    ThrottlerModule.forRoot([
      {
        name: "default",
        ttl: 60_000, // 1 minute
        limit: 30, // 30 requests per IP per minute
      },
    ]),
  ],
  controllers: [ContributorsController, AdminController, HealthController],
  providers: [ContributorsService, ApiKeyGuard, RequireApiKeyGuard],
})
export class ApiModule {}
