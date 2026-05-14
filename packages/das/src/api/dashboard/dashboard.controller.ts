import { BadRequestException, Controller, Get, Query } from "@nestjs/common";
import { ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { DashboardService } from "./dashboard.service";

@ApiTags("Dashboard")
@Controller("api/v1/dashboard")
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get("issues")
  @ApiOperation({
    summary: "Slim issue rows for dashboard trend aggregation",
    description:
      "Returns every issue with `created_at` on or after `since`, plus " +
      "every CLOSED issue whose `closed_at` is on or after `since`. " +
      "The mirror is intentionally roster-blind: every issue is returned " +
      "regardless of author. The dashboard blends with the gittensor API " +
      "miner roster client-side to filter to subnet authors. " +
      "Designed as a single bulk replacement for the dashboard's per-miner " +
      "fan-out against `/miners/<id>/issues` (one call instead of N).",
  })
  @ApiQuery({
    name: "since",
    required: true,
    description: "ISO timestamp — earliest creation/close date to include.",
  })
  async getIssues(@Query("since") since?: string): Promise<unknown> {
    if (!since) {
      throw new BadRequestException("`since` query parameter is required");
    }
    const parsed = new Date(since);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException("`since` must be a valid ISO timestamp");
    }
    return this.dashboard.getIssues(parsed.toISOString());
  }
}
