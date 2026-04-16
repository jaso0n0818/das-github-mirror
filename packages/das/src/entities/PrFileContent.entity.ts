import { Column, Entity, PrimaryColumn } from "typeorm";

@Entity({ name: "pr_file_contents" })
export class PrFileContent {
  @PrimaryColumn({ name: "repo_full_name" })
  repoFullName: string;

  @PrimaryColumn({ name: "pr_number" })
  prNumber: number;

  @PrimaryColumn()
  filename: string;

  @Column({ name: "base_content", type: "text", nullable: true })
  baseContent: string | null;

  @Column({ name: "head_content", type: "text", nullable: true })
  headContent: string | null;

  @Column({ name: "is_binary", default: false })
  isBinary: boolean;

  @Column({ name: "byte_size", type: "int", nullable: true })
  byteSize: number | null;
}
