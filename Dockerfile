# One appliance: the web build, Postgres 17, Center, and the edge on port 8080.
FROM node:22-bookworm-slim AS web
WORKDIR /src
COPY apps/web/package.json apps/web/pnpm-lock.yaml ./
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate && pnpm install --frozen-lockfile
COPY apps/web/ ./
RUN pnpm build

FROM python:3.12-slim-bookworm
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/postgresql.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/postgresql.gpg] http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-17 \
    && rm -rf /var/lib/apt/lists/*
COPY infrastructure/docker/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt && rm /tmp/requirements.txt
WORKDIR /opt/factorix
COPY apps/center /opt/factorix/apps/center
COPY apps/edge /opt/factorix/apps/edge
COPY infrastructure/postgres /opt/factorix/infrastructure/postgres
COPY infrastructure/docker /opt/factorix/infrastructure/docker
COPY --from=web /src/dist /opt/factorix/apps/web/dist
RUN sed -i 's/\r$//' /opt/factorix/infrastructure/docker/entrypoint.sh && chmod +x /opt/factorix/infrastructure/docker/entrypoint.sh
ENV PATH="/usr/lib/postgresql/17/bin:${PATH}" \
    LANG=C.UTF-8 \
    PYTHONPATH=/opt/factorix/apps/center/src:/opt/factorix/apps/edge/src \
    FACTORIX_WEB_DIST=/opt/factorix/apps/web/dist \
    FACTORIX_APPLIANCE=true \
    FACTORIX_DATA_DIR=/data \
    FACTORIX_EDGE_WAIT=1 \
    FACTORIX_CENTER_URL=http://127.0.0.1:8080 \
    FACTORIX_OUTBOX_PATH=/data/outbox.sqlite \
    FACTORIX_CREDENTIAL_PATH=/data/edge-credential \
    FACTORIX_ENROLLMENT_FILE=/data/enrollment \
    FACTORIX_CONFIG_PATH=/data/active-config.json \
    FACTORIX_EDGE_HEALTH=/data/edge-health.json \
    FACTORIX_SCHEMA_SQL=/opt/factorix/infrastructure/postgres/001_schema.sql
EXPOSE 8080
VOLUME ["/data"]
ENTRYPOINT ["/opt/factorix/infrastructure/docker/entrypoint.sh"]
