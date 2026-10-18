CREATE TABLE "schema_fields" (
	"id" uuid PRIMARY KEY NOT NULL,
	"table_id" uuid NOT NULL,
	"name" varchar(63) NOT NULL,
	"position" integer NOT NULL,
	"type" varchar(16) NOT NULL,
	"type_options" jsonb NOT NULL,
	"nullable" boolean NOT NULL,
	"unique" boolean NOT NULL,
	"default_value" jsonb,
	CONSTRAINT "schema_fields_position_valid" CHECK ("schema_fields"."position" >= 0),
	CONSTRAINT "schema_fields_name_valid" CHECK ("schema_fields"."name" ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$' AND "schema_fields"."name" <> 'id'),
	CONSTRAINT "schema_fields_type_valid" CHECK ("schema_fields"."type" IN ('text', 'varchar', 'integer', 'bigint', 'decimal', 'boolean', 'uuid', 'date', 'timestamp', 'jsonb')),
	CONSTRAINT "schema_fields_default_valid" CHECK ("schema_fields"."default_value" IS NULL OR (jsonb_typeof("schema_fields"."default_value") = 'object' AND "schema_fields"."default_value"->>'kind' IN ('literal', 'current_timestamp')))
);
--> statement-breakpoint
CREATE TABLE "schema_migrations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"draft_revision" integer NOT NULL,
	"plan_hash" varchar(64) NOT NULL,
	"definition" jsonb NOT NULL,
	"status" varchar(24) NOT NULL,
	"error_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "schema_migrations_status_valid" CHECK ("schema_migrations"."status" IN ('applying', 'applied', 'failed', 'outcome_unknown'))
);
--> statement-breakpoint
CREATE TABLE "schema_tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"schema_name" varchar(63) NOT NULL,
	"name" varchar(63) NOT NULL,
	"draft_revision" integer DEFAULT 1 NOT NULL,
	"applied_revision" integer,
	"applied_definition" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schema_tables_name_valid" CHECK ("schema_tables"."name" ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'),
	CONSTRAINT "schema_tables_revisions_valid" CHECK ("schema_tables"."draft_revision" > 0 AND ("schema_tables"."applied_revision" IS NULL OR ("schema_tables"."applied_revision" > 0 AND "schema_tables"."applied_revision" <= "schema_tables"."draft_revision"))),
	CONSTRAINT "schema_tables_applied_pair" CHECK (("schema_tables"."applied_revision" IS NULL) = ("schema_tables"."applied_definition" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "schema_fields" ADD CONSTRAINT "schema_fields_table_id_schema_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."schema_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schema_migrations" ADD CONSTRAINT "schema_migrations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schema_migrations" ADD CONSTRAINT "schema_migrations_table_id_schema_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."schema_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schema_tables" ADD CONSTRAINT "schema_tables_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schema_tables" ADD CONSTRAINT "schema_tables_connection_id_database_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."database_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "schema_fields_name_unique" ON "schema_fields" USING btree ("table_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "schema_fields_position_unique" ON "schema_fields" USING btree ("table_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "schema_migrations_one_active_project" ON "schema_migrations" USING btree ("project_id") WHERE "schema_migrations"."status" IN ('applying', 'outcome_unknown');--> statement-breakpoint
CREATE UNIQUE INDEX "schema_tables_target_unique" ON "schema_tables" USING btree ("connection_id","schema_name","name");