/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any */
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Repo, ReviewComment } from "../../entities";

@Injectable()
export class ReviewCommentHandler {
  constructor(
    @InjectRepository(ReviewComment)
    private readonly reviewCommentRepo: Repository<ReviewComment>,
    @InjectRepository(Repo)
    private readonly repoRepo: Repository<Repo>,
  ) {}

  async handle(payload: Record<string, any>): Promise<void> {
    const comment = payload.comment;
    const repoFullName: string = payload.repository.full_name;

    if (payload.action === "deleted") {
      await this.reviewCommentRepo.delete({
        repoFullName,
        commentId: String(comment.id),
      });
      await this.repoRepo.update(repoFullName, {
        lastEventAt: new Date().toISOString(),
      });
      return;
    }

    const data: Partial<ReviewComment> = {
      repoFullName,
      commentId: String(comment.id),
      prNumber: payload.pull_request.number,
      reviewerGithubId: String(comment.user.id),
      reviewerLogin: comment.user.login,
      reviewId: comment.pull_request_review_id
        ? String(comment.pull_request_review_id)
        : null,
      path: comment.path ?? null,
      line: comment.line ?? null,
      side: comment.side ?? null,
      body: comment.body,
      createdAt: comment.created_at,
      updatedAt: comment.updated_at ?? null,
    };

    await this.reviewCommentRepo.upsert(data, ["repoFullName", "commentId"]);

    await this.repoRepo.update(repoFullName, {
      lastEventAt: new Date().toISOString(),
    });
  }
}
