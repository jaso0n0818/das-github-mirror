import { Controller, Get, Param, Query } from "@nestjs/common";
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from "@nestjs/swagger";
import { MinersService } from "./miners.service";

@ApiTags("Miners")
@Controller("api/v1/miners")
export class MinersController {
  constructor(private readonly miners: MinersService) {}

  @Get(":githubId/pulls")
  @ApiOperation({
    summary: "Pull requests authored by a miner",
    description:
      "Returns every PR the miner has authored since the given date. Each " +
      "row includes full scoring inputs: review summary, current labels " +
      "(with actor attribution), linked issues (with their labels). File " +
      "contents are NOT included — fetch via /pulls/:o/:r/:n/files.",
  })
  @ApiParam({ name: "githubId", description: "GitHub user ID (numeric)" })
  @ApiQuery({
    name: "since",
    required: false,
    description:
      "ISO timestamp. Defaults to 35 days ago (midnight UTC) if omitted.",
  })
  async getPullRequests(
    @Param("githubId") githubId: string,
    @Query("since") since?: string,
  ): Promise<unknown> {
    return this.miners.getPullRequests(
      githubId,
      MinersService.resolveSince(since),
    );
  }

  @Get(":githubId/issues")
  @ApiOperation({
    summary: "Issues authored by a miner",
    description:
      "Returns issues the miner has authored, with current labels (actor " +
      "attribution) and any solving PR. When `since` is provided, returns " +
      "OPEN issues created on/after that date plus CLOSED issues closed " +
      "on/after that date (scoring window). When `since` is omitted, " +
      "returns all currently-OPEN issues with no time bound and no CLOSED " +
      "history (open-issue load counting).",
  })
  @ApiParam({ name: "githubId", description: "GitHub user ID (numeric)" })
  @ApiQuery({
    name: "since",
    required: false,
    description:
      "ISO timestamp. When omitted, the response contains all currently-" +
      "OPEN issues with no time bound and no CLOSED history.",
  })
  async getIssues(
    @Param("githubId") githubId: string,
    @Query("since") since?: string,
  ): Promise<unknown> {
    return this.miners.getIssues(githubId, since ?? null);
  }
}
