/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any */
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Comment, Repo } from "../../entities";

@Injectable()
export class CommentHandler {
  constructor(
    @InjectRepository(Comment)
    private readonly commentRepo: Repository<Comment>,
    @InjectRepository(Repo)
    private readonly repoRepo: Repository<Repo>,
  ) {}

  async handle(payload: Record<string, any>): Promise<void> {
    const comment = payload.comment;
    const repoFullName: string = payload.repository.full_name;

    if (payload.action === "deleted") {
      await this.commentRepo.delete({
        repoFullName,
        commentId: String(comment.id),
      });
      await this.repoRepo.update(repoFullName, {
        lastEventAt: new Date().toISOString(),
      });
      return;
    }

    // Determine context: PR thread or issue thread
    const commentContext = payload.issue?.pull_request ? "pr" : "issue";

    const data: Partial<Comment> = {
      repoFullName,
      commentId: String(comment.id),
      targetNumber: payload.issue.number,
      commentContext,
      authorGithubId: String(comment.user.id),
      authorLogin: comment.user.login,
      authorAssociation: comment.author_association,
      body: comment.body,
      createdAt: comment.created_at,
      updatedAt: comment.updated_at ?? null,
    };

    await this.commentRepo.upsert(data, ["repoFullName", "commentId"]);

    await this.repoRepo.update(repoFullName, {
      lastEventAt: new Date().toISOString(),
    });
  }
}
