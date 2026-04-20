import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  UseGuards,
} from "@nestjs/common";
import { ApiOperation, ApiParam, ApiSecurity, ApiTags } from "@nestjs/swagger";
import { ApiKeyGuard } from "../api-key.guard";
import { NoCache } from "../../cache";
import { PullsService } from "./pulls.service";

@ApiTags("Pulls")
@ApiSecurity("api-key")
@UseGuards(ApiKeyGuard)
@Controller("api/v1/pulls")
export class PullsController {
  constructor(private readonly pulls: PullsService) {}

  @Get(":owner/:repo/:number/files")
  @NoCache()
  @ApiOperation({
    summary: "File list and contents for a PR",
    description:
      "Returns the PR's file changes with both base and head content " +
      "per file (for tree-diff / token scoring). Base content is taken " +
      "at merge_base_sha when available (true common ancestor), else " +
      "at base_sha. Files marked is_binary=true or exceeding 1 MB are " +
      "returned with null content.",
  })
  @ApiParam({ name: "owner", description: "Repository owner (org or user)" })
  @ApiParam({ name: "repo", description: "Repository name" })
  @ApiParam({
    name: "number",
    description: "Pull request number",
    type: Number,
  })
  async getFiles(
    @Param("owner") owner: string,
    @Param("repo") repo: string,
    @Param("number", ParseIntPipe) number: number,
  ): Promise<unknown> {
    return this.pulls.getFiles(owner, repo, number);
  }
}
