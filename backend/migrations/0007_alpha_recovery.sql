ALTER TABLE "database_connections" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "runtime_state" varchar(16) DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "database_connections" ADD CONSTRAINT "connection_revision_valid" CHECK ("database_connections"."revision" > 0);--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_runtime_state_valid" CHECK ("projects"."runtime_state" IN ('active', 'suspended'));