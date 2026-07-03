# Deploying the CrewRoster backend (EC2 + Docker)

Hybrid setup: **this backend runs on one EC2 box (Docker)**; the **frontend runs on
AWS Amplify**. MongoDB is external (Atlas, Mumbai). Redis runs here in a container.

The one-shot `migrate` service is a **fail-closed gate**: the API only starts after
migrations succeed. Re-run the deploy for every release — it's idempotent.

---

## One-time setup

1. **EC2 instance** — Ubuntu, region **ap-south-1 (Mumbai)**. In its Security
   Group, open inbound **80** and **443** (and 22 for SSH).

2. **Install Docker** on the box:

   ```bash
   curl -fsSL https://get.docker.com | sh
   sudo usermod -aG docker $USER   # then log out + back in
   ```

3. **DNS** — at your domain provider, add an **A record**:
   `api.zari360.in` → your EC2 public IP.
   (The root `zari360.in` points at Amplify, set up in the Amplify console.)

4. **Clone the repo** on the box:

   ```bash
   git clone <your-backend-repo-url> crewroster-backend
   cd crewroster-backend
   ```

5. **Create the env file** from the template and fill it in:
   ```bash
   cp deploy/.env.example deploy/.env
   nano deploy/.env
   ```

   - Generate the 4 secrets: `openssl rand -hex 32` (run 4x → REDIS_PASSWORD + 3 JWT).
   - Paste your `MONGODB_URI` (Atlas) and `R2_*` storage keys.
   - `DOMAIN` and `ACME_EMAIL` are already set to your values in the template.

---

## Deploy (every release)

From the repo root on the EC2 box:

```bash
git pull
bash deploy/deploy.sh
```

That pulls the latest code, builds the image, runs the **migration gate**, then
starts the API + worker + Caddy. Caddy automatically fetches the SSL certificate
for `api.zari360.in` (needs DNS + ports 80/443 first).

**Smoke test:**

```bash
curl -fsS https://api.zari360.in/api/health
```

Useful commands:

```bash
docker compose -f deploy/docker-compose.yml ps        # status
docker compose -f deploy/docker-compose.yml logs -f   # live logs
docker compose -f deploy/docker-compose.yml down       # stop
```

---

## The frontend (Amplify) — separate

1. In the Amplify console, connect the **crewroster-web** GitHub repo.
2. Add the env vars (the `NEXT_PUBLIC_*` list), with
   `NEXT_PUBLIC_BACKEND_API_URL = https://api.zari360.in/api` and
   `BACKEND_API_URL = https://api.zari360.in/api`.
3. Add the custom domain `zari360.in`.
4. Every push to the web repo auto-builds + deploys — no extra workflow needed.

---

## First deploy on a brand-new database

The migration gate runs all migrations automatically. If you are pointing at a
**pre-existing** DB that already has historical data, run this ONCE before the
first normal deploy (it stamps old backfills as applied without re-running them):

```bash
docker compose -f deploy/docker-compose.yml run --rm migrate node dist/migrate.js --baseline
```

For a brand-new empty Atlas database, skip that — just run `deploy.sh`.
