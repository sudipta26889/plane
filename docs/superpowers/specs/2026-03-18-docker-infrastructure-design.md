# TaskPilot Docker Infrastructure Design

## Context

TaskPilot is deployed on a home server (`192.168.11.150`) with external services on the local network. The domain `taskpilot.sudiptadhara.in` is proxied via Nginx Proxy Manager with Let's Encrypt SSL to `192.168.11.150:4646`. This design replaces the original self-contained Docker setup (which bundled DB, Redis, MinIO) with one that connects to existing remote infrastructure.

## External Infrastructure

| Service | Host | Port | Credentials |
|---------|------|------|-------------|
| PostgreSQL | nuc.lan | 5432 | user: `taskpilot_db_user`, db: `taskpilot_db` |
| Redis | nuc.lan | 6379/6 | password-protected |
| MinIO S3 API | nas.lan | 7612 | `minioadmin` / (secret) |
| MinIO Console | nas.lan | 7613 | Same credentials |
| Nginx Proxy Manager | External | — | `taskpilot.sudiptadhara.in` → `192.168.11.150:4646` |

## Port Mapping (192.168.11.150)

| Port | Service | Internal Port |
|------|---------|---------------|
| 4646 | Web (main frontend) | 3000 |
| 4647 | API (Django/Gunicorn) | 8000 |
| 4648 | Live (WebSocket/collab) | 3100 |
| 4649 | Admin (god-mode panel) | 3001 |

## Services

### Production (`docker-compose.yml`)

| Service | Image/Build | Port | Description |
|---------|-------------|------|-------------|
| **web** | `Dockerfile.web` | 4646:3000 | React frontend (SSR) |
| **api** | `Dockerfile.api` | 4647:8000 | Django REST API via Gunicorn |
| **worker** | `Dockerfile.api` | — | Celery async task worker |
| **beat-worker** | `Dockerfile.api` | — | Celery periodic task scheduler |
| **migrator** | `Dockerfile.api` | — | One-shot DB migration runner |
| **live** | `Dockerfile.live` | 4648:3100 | Real-time collaboration server |
| **admin** | `Dockerfile.admin` | 4649:3001 | Admin panel frontend |
| **space** | `Dockerfile.space` | — (internal) | Public-facing space app (routed internally) |
| **taskpilot-mq** | `rabbitmq:3.13.6-management-alpine` | — | RabbitMQ message broker (local) |

### Development (`docker-compose-local.yml`)

Same services but with:
- `Dockerfile.dev` for all builds
- Volume mounts for hot reload (`./apps/api:/code`, `./apps/web:/app/apps/web`, etc.)
- Django dev server (`runserver`) instead of Gunicorn
- `pnpm dev` for frontend apps
- All same port mappings (4646-4649)
- Frontend apps (web, admin, space, live) built with dev Dockerfiles and source volumes
- `DEBUG=1` for API

### Removed Services (vs. original)

| Service | Reason |
|---------|--------|
| `taskpilot-db` | Using remote PostgreSQL at nuc.lan |
| `taskpilot-redis` | Using remote Redis at nuc.lan |
| `taskpilot-minio` | Using remote MinIO at nas.lan |
| `proxy` (Caddy) | Nginx Proxy Manager handles SSL/routing externally |

## Environment Configuration

### Root `.env` (shared)

```env
# Remote PostgreSQL
POSTGRES_USER=taskpilot_db_user
POSTGRES_PASSWORD=0tZZr187I9l6ddKziXEoCoSY
POSTGRES_HOST=nuc.lan
POSTGRES_DB=taskpilot_db
POSTGRES_PORT=5432

# Remote Redis
REDIS_HOST=nuc.lan
REDIS_PORT=6379
REDIS_URL=redis://:YyD0Tp54vIhmH9gyrbtDu7vDtv8zc5gL@nuc.lan:6379/6

# RabbitMQ (local container, accessed via Docker network)
RABBITMQ_HOST=taskpilot-mq
RABBITMQ_PORT=5672
RABBITMQ_USER=taskpilot
RABBITMQ_PASSWORD=taskpilot
RABBITMQ_VHOST=taskpilot

# Remote MinIO
AWS_ACCESS_KEY_ID=minioadmin
AWS_SECRET_ACCESS_KEY=zUd8Su6vsdjbkFf2uiXrtScH
AWS_S3_ENDPOINT_URL=http://nas.lan:7612
AWS_S3_BUCKET_NAME=taskpilot
USE_MINIO=1

# File limits
FILE_SIZE_LIMIT=5242880
```

### API `.env` (`apps/api/.env`)

```env
DEBUG=0
CORS_ALLOWED_ORIGINS=https://taskpilot.sudiptadhara.in,http://localhost:4646,http://localhost:4649

# Database (remote)
DATABASE_URL=postgresql://taskpilot_db_user:0tZZr187I9l6ddKziXEoCoSY@nuc.lan:5432/taskpilot_db

# Redis (remote)
REDIS_URL=redis://:YyD0Tp54vIhmH9gyrbtDu7vDtv8zc5gL@nuc.lan:6379/6

# RabbitMQ (local container)
RABBITMQ_HOST=taskpilot-mq
RABBITMQ_PORT=5672
RABBITMQ_USER=taskpilot
RABBITMQ_PASSWORD=taskpilot
RABBITMQ_VHOST=taskpilot

# MinIO (remote)
AWS_ACCESS_KEY_ID=minioadmin
AWS_SECRET_ACCESS_KEY=zUd8Su6vsdjbkFf2uiXrtScH
AWS_S3_ENDPOINT_URL=http://nas.lan:7612
AWS_S3_BUCKET_NAME=taskpilot
USE_MINIO=1

# Base URLs
WEB_URL=https://taskpilot.sudiptadhara.in
APP_BASE_URL=http://web:3000
ADMIN_BASE_URL=http://admin:3001
ADMIN_BASE_PATH=/god-mode
SPACE_BASE_URL=http://space:3002
SPACE_BASE_PATH=/spaces
LIVE_BASE_URL=http://live:3100
LIVE_BASE_PATH=/live

GUNICORN_WORKERS=2
HARD_DELETE_AFTER_DAYS=60
MINIO_ENDPOINT_SSL=0
API_KEY_RATE_LIMIT=60/minute
SIGNED_URL_EXPIRATION=3600
```

## Network Architecture

```
Internet
   │
   ▼
Nginx Proxy Manager (Let's Encrypt SSL)
   │
   ▼ taskpilot.sudiptadhara.in
   │
192.168.11.150:4646 ──► web (React frontend)
                          │
                          ├──► 192.168.11.150:4647 ──► api (Django)
                          │                              │
                          │                              ├──► nuc.lan (PostgreSQL)
                          │                              ├──► nuc.lan (Redis)
                          │                              ├──► nas.lan:7612 (MinIO)
                          │                              └──► taskpilot-mq (RabbitMQ container)
                          │
                          ├──► 192.168.11.150:4648 ──► live (WebSocket)
                          │
                          └──► 192.168.11.150:4649 ──► admin (God Mode)
```

## Docker Compose Structure

### Production: `docker-compose.yml`

- All services use production Dockerfiles
- No volume mounts (code baked into images)
- `restart: always`
- Only RabbitMQ has a named volume (`rabbitmq_data`)
- Services connect to remote DB/Redis/MinIO via host network IPs
- No `networks:` block needed (default bridge + `extra_hosts` for host access)

### Development: `docker-compose-local.yml`

- All services use `Dockerfile.dev`
- Volume mounts for hot reload:
  - API: `./apps/api:/code`
  - Web: `./:/app` (monorepo root for turbo)
  - Admin: `./:/app`
  - Space: `./:/app`
  - Live: `./:/app`
- `restart: unless-stopped`
- `DEBUG=1` for API
- Frontend apps run `pnpm dev` with Vite HMR
- API runs `python manage.py runserver 0.0.0.0:8000`
- Worker/beat use same dev Dockerfile with watchdog for auto-reload

## Files to Modify

1. `docker-compose.yml` — Rewrite for production with remote services
2. `docker-compose-local.yml` — Rewrite for development with hot reload
3. `.env` — Update with remote service credentials (create from `.env.example`)
4. `apps/api/.env` — Update with remote service credentials and base URLs

## Verification

1. `docker compose -f docker-compose-local.yml config` — validate compose syntax
2. `docker compose -f docker-compose-local.yml up migrator` — run migrations against remote DB
3. `docker compose -f docker-compose-local.yml up -d` — start all services
4. Visit `http://192.168.11.150:4646` — web frontend loads
5. Visit `http://192.168.11.150:4647/api/` — API responds
6. Visit `https://taskpilot.sudiptadhara.in` — SSL proxy works end-to-end
