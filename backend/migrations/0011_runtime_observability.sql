CREATE TABLE runtime_request_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  completed_at timestamptz(3) NOT NULL,
  event_version smallint NOT NULL DEFAULT 1 CHECK (event_version = 1),
  route_category varchar(16) NOT NULL CHECK (route_category IN ('crud','auth','workflow','unresolved')),
  operation varchar(24) CHECK (operation IN ('crud.list','crud.get','crud.create','crud.update','crud.delete','auth.signup','auth.login','auth.me','auth.logout','workflow.execute')),
  resource varchar(100),
  method varchar(16) NOT NULL,
  status integer NOT NULL CHECK (status BETWEEN 100 AND 599),
  error_code varchar(80),
  duration_us bigint NOT NULL CHECK (duration_us >= 0),
  response_bytes bigint CHECK (response_bytes >= 0),
  principal_kind varchar(16) NOT NULL CHECK (principal_kind IN ('project_key','app_user','anonymous'))
);
--> statement-breakpoint
CREATE INDEX runtime_events_project_time ON runtime_request_events(project_id, completed_at DESC, id DESC);
--> statement-breakpoint
CREATE INDEX runtime_events_request ON runtime_request_events(project_id, request_id);
--> statement-breakpoint
CREATE INDEX runtime_events_cleanup ON runtime_request_events(completed_at, id);
