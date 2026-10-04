#!/bin/sh
# Runs once when the database volume is first created.
# The app connects as "vanibot", a normal (non-superuser) role, so Postgres row-level security
# keeps every company's data separate. Extensions are created here because they need a superuser.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<SQL
CREATE ROLE vanibot LOGIN PASSWORD 'vanibot' NOSUPERUSER NOBYPASSRLS;
CREATE DATABASE vanibot OWNER vanibot;
SQL
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname vanibot <<SQL
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
SQL
