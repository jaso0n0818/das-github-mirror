import { Column, Entity, PrimaryColumn } from "typeorm";

@Entity({ name: "webhook_deliveries" })
export class WebhookDelivery {
  @PrimaryColumn({ name: "delivery_id" })
  deliveryId: string;

  @Column({ name: "received_at", type: "timestamp" })
  receivedAt: string;
}
