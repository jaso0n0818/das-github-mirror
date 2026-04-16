import { Column, Entity, PrimaryColumn } from "typeorm";

@Entity({ name: "comments" })
export class Comment {
  @PrimaryColumn({ name: "repo_full_name" })
  repoFullName: string;

  @PrimaryColumn({ name: "comment_id", type: "bigint" })
  commentId: string;

  @Column({ name: "target_number" })
  targetNumber: number;

  @Column({ name: "comment_context", default: "issue" })
  commentContext: string;

  @Column({ name: "author_github_id", nullable: true })
  authorGithubId: string;

  @Column({ name: "author_login", nullable: true })
  authorLogin: string;

  @Column({ name: "author_association", nullable: true })
  authorAssociation: string;

  @Column({ type: "text", nullable: true })
  body: string;

  @Column({ name: "created_at", type: "timestamp" })
  createdAt: string;

  @Column({ name: "updated_at", type: "timestamp", nullable: true })
  updatedAt: string;
}
