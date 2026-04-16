import { Column, Entity, PrimaryColumn } from "typeorm";

@Entity({ name: "reviews" })
export class Review {
  @PrimaryColumn({ name: "repo_full_name" })
  repoFullName: string;

  @PrimaryColumn({ name: "pr_number" })
  prNumber: number;

  @PrimaryColumn({ name: "reviewer_github_id" })
  reviewerGithubId: string;

  @PrimaryColumn({ name: "submitted_at", type: "timestamp" })
  submittedAt: string;

  @Column({ name: "reviewer_login", nullable: true })
  reviewerLogin: string;

  @Column({ name: "reviewer_association", nullable: true })
  reviewerAssociation: string;

  @Column({ name: "review_state" })
  reviewState: string;
}
