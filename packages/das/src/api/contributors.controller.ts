import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiSecurity,
} from "@nestjs/swagger";
import { ApiKeyGuard } from "./api-key.guard";
import { ContributorsService } from "./contributors.service";

@ApiTags("Contributors")
@ApiSecurity("api-key")
@UseGuards(ApiKeyGuard)
@Controller("api/v1/contributors")
export class ContributorsController {
  constructor(private readonly contributorsService: ContributorsService) {}

  @Get(":githubId/scoring-inputs")
  @ApiOperation({
    summary: "Get PR scoring inputs for a contributor",
    description:
      "Returns all PR scoring data from the pr_scoring_inputs view for a given contributor, optionally filtered by date.",
  })
  @ApiParam({ name: "githubId", description: "GitHub user ID" })
  @ApiQuery({
    name: "since",
    required: false,
    description: "ISO date string — only return PRs created after this date",
  })
  async getScoringInputs(
    @Param("githubId") githubId: string,
    @Query("since") since?: string,
  ): Promise<unknown[]> {
    return this.contributorsService.getScoringInputs(githubId, since);
  }

  @Get(":githubId/counts")
  @ApiOperation({
    summary: "Get aggregated PR and issue counts for a contributor",
    description:
      "Returns merged/closed/open PR counts and issue counts per repo, with a configurable lookback window.",
  })
  @ApiParam({ name: "githubId", description: "GitHub user ID" })
  @ApiQuery({
    name: "days",
    required: false,
    description: "Lookback window in days (default: 35)",
  })
  async getCounts(
    @Param("githubId") githubId: string,
    @Query("days") days?: string,
  ): Promise<{ prCounts: unknown[]; issueCounts: unknown[] }> {
    return this.contributorsService.getCounts(githubId, Number(days) || 35);
  }
}
