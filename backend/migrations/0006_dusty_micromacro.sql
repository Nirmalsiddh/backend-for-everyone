CREATE TABLE "platform_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "platform_sessions_expiry_valid" CHECK ("platform_sessions"."expires_at" > "platform_sessions"."created_at")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "status" varchar(16) DEFAULT 'disabled' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_sessions" ADD CONSTRAINT "platform_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "platform_sessions_token_hash_unique" ON "platform_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "platform_sessions_user_id_idx" ON "platform_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "platform_sessions_expires_at_idx" ON "platform_sessions" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_status_valid" CHECK ("users"."status" IN ('active', 'disabled'));