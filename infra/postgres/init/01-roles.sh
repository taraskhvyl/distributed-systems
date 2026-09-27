#!/bin/sh
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<EOSQL
CREATE ROLE api_user LOGIN PASSWORD '${API_DB_PASSWORD}';
CREATE ROLE processor_user LOGIN PASSWORD '${PROCESSOR_DB_PASSWORD}';
GRANT USAGE ON SCHEMA public TO api_user, processor_user;
EOSQL
echo "Created least-privilege database roles: api_user, processor_user"
