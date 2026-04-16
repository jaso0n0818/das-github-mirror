import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import {
  Repo,
  PullRequest,
  Issue,
  PrFile,
  PrFileContent,
  LabelEvent,
} from "../entities";
import { ApiKeyGuard } from "./api-key.guard";
import { ContributorsController } from "./contributors.controller";
import { ContributorsService } from "./contributors.service";

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
  ],
  controllers: [ContributorsController],
  providers: [ContributorsService, ApiKeyGuard],
})
export class ApiModule {}
