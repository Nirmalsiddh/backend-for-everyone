CREATE TABLE "schema_indexes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"table_id" uuid NOT NULL,
	"specification_version" integer DEFAULT 1 NOT NULL,
	"field_ids" jsonb NOT NULL,
	"is_unique" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schema_indexes_specification_valid" CHECK ("schema_indexes"."specification_version" = 1),
	CONSTRAINT "schema_indexes_fields_valid" CHECK (jsonb_typeof("schema_indexes"."field_ids") = 'array' AND jsonb_array_length("schema_indexes"."field_ids") BETWEEN 1 AND 4)
);
--> statement-breakpoint
ALTER TABLE "schema_tables" ADD COLUMN "applied_physical_revision" integer;
--> statement-breakpoint
UPDATE "schema_tables" SET "applied_physical_revision" = "applied_revision";--> statement-breakpoint
ALTER TABLE "schema_indexes" ADD CONSTRAINT "schema_indexes_table_id_schema_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."schema_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schema_tables" ADD CONSTRAINT "schema_tables_physical_revision_valid" CHECK (("schema_tables"."applied_physical_revision" IS NULL AND "schema_tables"."applied_revision" IS NULL) OR ("schema_tables"."applied_physical_revision" IS NOT NULL AND "schema_tables"."applied_revision" IS NOT NULL AND "schema_tables"."applied_physical_revision" >= "schema_tables"."applied_revision" AND "schema_tables"."applied_physical_revision" <= "schema_tables"."draft_revision"));