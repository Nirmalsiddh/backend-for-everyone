CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"key_hash" varchar(64) NOT NULL,
	"key_prefix" varchar(16) NOT NULL,
	"scope" varchar(16) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash"),
	CONSTRAINT "api_keys_scope_valid" CHECK ("api_keys"."scope" IN ('read', 'read_write')),
	CONSTRAINT "api_keys_hash_valid" CHECK ("api_keys"."key_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "api_keys_name_valid" CHECK (char_length(btrim("api_keys"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"resource_name" varchar(63) NOT NULL,
	"enabled_operations" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "endpoints_table_id_unique" UNIQUE("table_id"),
	CONSTRAINT "endpoints_revision_valid" CHECK ("endpoints"."revision" > 0),
	CONSTRAINT "endpoints_operations_valid" CHECK (jsonb_typeof("endpoints"."enabled_operations") = 'array' AND "endpoints"."enabled_operations" <@ '["list","get","create","update","delete"]'::jsonb)
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoints" ADD CONSTRAINT "endpoints_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "schema_tables_id_project_unique" ON "schema_tables" USING btree ("id","project_id");
--> statement-breakpoint
ALTER TABLE "endpoints" ADD CONSTRAINT "endpoints_table_id_project_id_schema_tables_id_project_id_fk" FOREIGN KEY ("table_id","project_id") REFERENCES "public"."schema_tables"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "endpoints_project_resource_unique" ON "endpoints" USING btree ("project_id","resource_name");
