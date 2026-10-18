CREATE TABLE "workflow_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"path" varchar(63) NOT NULL,
	"method" varchar(8) DEFAULT 'POST' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"draft_definition" jsonb NOT NULL,
	"draft_revision" integer DEFAULT 1 NOT NULL,
	"published_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_method_valid" CHECK ("workflow_endpoints"."method" = 'POST'),
	CONSTRAINT "workflow_path_valid" CHECK ("workflow_endpoints"."path" ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' AND "workflow_endpoints"."path" <> 'auth'),
	CONSTRAINT "workflow_revision_valid" CHECK ("workflow_endpoints"."draft_revision" > 0),
	CONSTRAINT "workflow_definition_size" CHECK (octet_length("workflow_endpoints"."draft_definition"::text) <= 65536)
);
--> statement-breakpoint
CREATE TABLE "workflow_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_endpoint_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"definition_hash" varchar(64) NOT NULL,
	"schema_dependencies" jsonb NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_version_valid" CHECK ("workflow_versions"."version" > 0 AND "workflow_versions"."definition_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "workflow_endpoints" ADD CONSTRAINT "workflow_endpoints_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_endpoints" ADD CONSTRAINT "workflow_endpoints_connection_id_database_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."database_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_workflow_endpoint_id_workflow_endpoints_id_fk" FOREIGN KEY ("workflow_endpoint_id") REFERENCES "public"."workflow_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_project_path_unique" ON "workflow_endpoints" USING btree ("project_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_versions_number_unique" ON "workflow_versions" USING btree ("workflow_endpoint_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_versions_id_endpoint_unique" ON "workflow_versions" USING btree ("id","workflow_endpoint_id");