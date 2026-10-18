#!/bin/sh
set -eu
# Runs only when initializing an empty volume. Values enter psql through its
# environment, never SQL interpolation by the shell or command-line passwords.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv app_password APP_PASSWORD
\getenv migration_password MIGRATION_PASSWORD
CREATE ROLE platform_migrator LOGIN PASSWORD :'migration_password';
CREATE ROLE platform_app LOGIN PASSWORD :'app_password';
ALTER DATABASE platform OWNER TO platform_migrator;
REVOKE ALL ON DATABASE platform FROM PUBLIC;
GRANT CONNECT ON DATABASE platform TO platform_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO platform_migrator;
GRANT USAGE ON SCHEMA public TO platform_app;
ALTER DEFAULT PRIVILEGES FOR ROLE platform_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO platform_app;
ALTER DEFAULT PRIVILEGES FOR ROLE platform_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO platform_app;
SQL
