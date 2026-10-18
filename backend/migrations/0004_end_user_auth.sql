CREATE TABLE "project_auth_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"enabled" boolean NOT NULL,
	"signup_enabled" boolean NOT NULL,
	"provisioning_status" varchar(24) DEFAULT 'unprovisioned' NOT NULL,
	"auth_schema_version" integer DEFAULT 1 NOT NULL,
	"auth_users_table_name" varchar(63) NOT NULL,
	"auth_sessions_table_name" varchar(63) NOT NULL,
	"session_lifetime_seconds" integer DEFAULT 86400 NOT NULL,
	"catalog" jsonb,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_auth_configs_project_id_unique" UNIQUE("project_id"),
	CONSTRAINT "project_auth_status_valid" CHECK ("project_auth_configs"."provisioning_status" IN ('unprovisioned', 'provisioning', 'ready', 'failed', 'outcome_unknown')),
	CONSTRAINT "project_auth_lifetime_valid" CHECK ("project_auth_configs"."session_lifetime_seconds" BETWEEN 300 AND 604800),
	CONSTRAINT "project_auth_revision_valid" CHECK ("project_auth_configs"."revision" > 0 AND "project_auth_configs"."auth_schema_version" = 1),
	CONSTRAINT "project_auth_names_valid" CHECK ("project_auth_configs"."auth_users_table_name" = 'platform_auth_users_' || replace("project_auth_configs"."project_id"::text, '-', '') AND "project_auth_configs"."auth_sessions_table_name" = 'platform_auth_sessions_' || replace("project_auth_configs"."project_id"::text, '-', ''))
);
--> statement-breakpoint
ALTER TABLE "endpoints" ADD COLUMN "policies" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "project_auth_configs" ADD CONSTRAINT "project_auth_configs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_auth_configs" ADD CONSTRAINT "project_auth_configs_connection_id_database_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."database_connections"("id") ON DELETE restrict ON UPDATE no action;