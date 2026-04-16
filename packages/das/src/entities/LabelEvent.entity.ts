import { Column, Entity, PrimaryGeneratedColumn } from "typeorm";

@Entity({ name: "label_events" })
export class LabelEvent {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: "repo_full_name" })
  repoFullName: string;

  @Column({ name: "target_number", type: "int", nullable: true })
  targetNumber: number | null;

  @Column({ name: "target_type", default: "issue" })
  targetType: string;

  @Column({ name: "label_name" })
  labelName: string;

  @Column()
  action: string;

  @Column({ name: "actor_github_id", type: "varchar", nullable: true })
  actorGithubId: string | null;

  @Column({ name: "actor_login", type: "varchar", nullable: true })
  actorLogin: string | null;

  @Column({ name: "actor_association", nullable: true })
  actorAssociation: string;

  @Column({ type: "timestamp" })
  timestamp: string;
}
