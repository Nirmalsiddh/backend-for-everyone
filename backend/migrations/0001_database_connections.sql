CREATE TABLE "database_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"label" varchar(100) NOT NULL,
	"encrypted_config" text NOT NULL,
	"encryption_iv" varchar(24) NOT NULL,
	"encryption_tag" varchar(24) NOT NULL,
	"encryption_version" integer NOT NULL,
	"last_test_status" varchar(16) NOT NULL,
	"last_tested_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "database_connections_project_id_unique" UNIQUE("project_id"),
	CONSTRAINT "database_connections_test_status" CHECK ("database_connections"."last_test_status" IN ('success', 'failed')),
	CONSTRAINT "database_connections_encryption_version" CHECK ("database_connections"."encryption_version" = 1)
);
--> statement-breakpoint
ALTER TABLE "database_connections" ADD CONSTRAINT "database_connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;