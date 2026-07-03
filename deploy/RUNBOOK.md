# Zari360 Backend — Server Runbook

Practical, copy-paste operations guide for the **backend** running on the EC2 box.
Frontend is separate (AWS Amplify) and is **not** covered here.

> **Do we use PM2?** **No.** The backend runs in **Docker Compose**, which already does
> everything PM2 would: keeps the app running, restarts it if it crashes, and restarts it
> on server reboot (`restart: unless-stopped`). There is **nothing to install or manage
> like PM2** — you use `docker compose` commands instead (see the cheat sheet below).

---

## 0. Cheat sheet (the commands you'll actually use)

Always run from the deploy folder:

```bash
cd ~/api/deploy
```

| What you want                       | Command                                                  |
| ----------------------------------- | -------------------------------------------------------- |
| See if everything is up/healthy     | `sudo docker compose ps`                                 |
| Live logs (one service)             | `sudo docker compose logs -f backend-web`                |
| Last 100 log lines                  | `sudo docker compose logs --tail 100 backend-web`        |
| Is the API answering?               | `curl -s https://api.zari360.in/api/health`              |
| **After editing `.env`** (apply it) | `sudo docker compose up -d`                              |
| Restart the app                     | `sudo docker compose restart backend-web backend-worker` |
| Stop everything                     | `sudo docker compose down`                               |
| Start everything                    | `sudo docker compose up -d`                              |
| **After a CODE change** (rebuild)   | `sudo docker compose build && sudo docker compose up -d` |

> If a `docker` command ever says "permission denied", either prefix it with `sudo`
> (as shown) or log out and back in once — the `ubuntu` user is in the `docker` group.

---

## 1. How the whole thing is wired

```
Browser ─► https://zari360.in            (Frontend — AWS Amplify, separate)
        └► https://api.zari360.in/api  ─► EC2 box (this runbook)
                                            ├─ Caddy        (HTTPS + reverse proxy)
                                            ├─ backend-web   (API, Node)
                                            ├─ backend-worker(background jobs, Node)
                                            └─ redis         (queues/cache)
                                          ▲
              MongoDB Atlas (managed) ────┘   (database — NOT on the box)
              Cloudflare R2 (managed)         (file uploads — NOT on the box)
```

- **One EC2 instance** runs all the backend containers via Docker Compose.
- **Database is MongoDB Atlas** (managed, off the box). The box only holds the app.
- **Files (uploads) go to Cloudflare R2** (managed, off the box).
- **Caddy** automatically gets + renews the HTTPS certificate for `api.zari360.in`.

**Server facts**

- Instance: `t4g.small` (ARM), Ubuntu, region `ap-south-1` (Mumbai)
- Public IP (Elastic IP, fixed): **3.7.74.67**
- SSH user: `ubuntu`
- SSH key: `zari360-api-key.pem` (keep it safe; it's the only way in)
- App lives at: `~/api` • deploy config at: `~/api/deploy`

---

## 2. Connect to the server (SSH)

From your computer:

```bash
ssh -i /path/to/zari360-api-key.pem ubuntu@3.7.74.67
```

- **Windows:** if you see "unprotected/permissions" errors, run once in PowerShell:
  ```powershell
  icacls "C:\Users\<you>\Downloads\zari360-api-key.pem" /inheritance:r
  icacls "C:\Users\<you>\Downloads\zari360-api-key.pem" /grant:r "$($env:USERNAME):(R)"
  ```
- If your home IP changes and SSH still works, you're fine (SSH is open to all, protected
  by the key). The key is the lock.

---

## 3. "I made a change — what do I run?" ← the important part

| What changed                                  | What to run (from `~/api/deploy`)                        | Rebuild?                                           |
| --------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------- |
| **`.env` values** (secrets, URLs, SMTP, etc.) | `sudo docker compose up -d`                              | No — just recreates containers with the new values |
| **Backend code** (anything in `src/`)         | `sudo docker compose build && sudo docker compose up -d` | Yes — the image must be rebuilt                    |
| **`docker-compose.yml` / `Caddyfile`**        | `sudo docker compose up -d`                              | No                                                 |
| **Just want a clean restart**                 | `sudo docker compose restart`                            | No                                                 |
| **Server was rebooted**                       | nothing — containers auto-start                          | No                                                 |

Key idea:

- **`.env` change → `up -d`** (no rebuild). The code/image is unchanged; the app just
  needs to re-read the env, which happens when containers are recreated.
- **Code change → `build` then `up -d`**. The compiled app lives inside the Docker image,
  so the image must be rebuilt.
- `restart` alone does **not** reload `.env` — use `up -d` for env changes.

After any of these, verify:

```bash
sudo docker compose ps                         # all healthy?
curl -s https://api.zari360.in/api/health      # {"status":"ok"}
```

---

## 4. Deploying the latest code (after merging to `main`)

The server is a **git clone of `main`** (read-only deploy key at `~/.ssh/zari360_deploy`).
**To ship the latest backend code, SSH in and run ONE command:**

```bash
cd ~/api && bash deploy/deploy.sh
```

It does **`git pull` (main) → rebuild image → restart** (~2–3 min). The migrate gate runs
first and blocks a broken release. Use `bash deploy/...` (not `./deploy/...`) so a missing
executable bit never stops it.

> The **frontend deploys itself** on a push to `main` (AWS Amplify watches the repo) —
> nothing to run there. Only the backend needs the command above.

The two sections below are fallbacks: re-creating the git clone if you ever rebuild the
box, and a manual scp copy if git is unavailable.

### Option A — re-copy from your computer (works today)

From your computer, in the project root:

```bash
# package the repo without node_modules/.git/dist, copy it up, extract
tar czf api.tar.gz --exclude=node_modules --exclude=.git --exclude=dist -C api .
scp -i zari360-api-key.pem api.tar.gz ubuntu@3.7.74.67:/home/ubuntu/
ssh -i zari360-api-key.pem ubuntu@3.7.74.67 \
  "rm -rf ~/api_src && mkdir ~/api_src && tar xzf ~/api.tar.gz -C ~/api_src && \
   cp -r ~/api_src/src ~/api_src/package*.json ~/api/ && rm -rf ~/api_src ~/api.tar.gz"
# then on the box: cd ~/api/deploy && sudo docker compose build && sudo docker compose up -d
```

(Do **not** overwrite `~/api/deploy/.env` — that file holds the real secrets and only
exists on the box.)

### Option B — switch to `git clone` (recommended, one-time)

Lets you deploy with a simple `git pull` + enables CI later.

1. On the box, make a read-only SSH **deploy key**:
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/zari360_deploy -N "" -C "ec2-deploy"
   cat ~/.ssh/zari360_deploy.pub
   ```
2. Add that public key to GitHub → repo **zari360/api** → **Settings → Deploy keys**
   (read-only is enough).
3. Clone, then move the existing `.env` in:
   ```bash
   GIT_SSH_COMMAND="ssh -i ~/.ssh/zari360_deploy" git clone git@github.com:zari360/api.git ~/api_new
   cp ~/api/deploy/.env ~/api_new/deploy/.env
   mv ~/api ~/api_old && mv ~/api_new ~/api
   ```
4. From then on, deploy with: `cd ~/api && bash deploy/deploy.sh` (git pull + build + up).

---

## 5. Environment variables (`.env`)

- The real file lives **only on the box** at `~/api/deploy/.env` (never committed to git).
- `~/api/deploy/.env.example` lists every variable with comments.
- Edit it safely with `nano`:
  ```bash
  nano ~/api/deploy/.env       # Ctrl+O Enter to save, Ctrl+X to exit
  ```
- **After editing, apply it:** `cd ~/api/deploy && sudo docker compose up -d`
- **Must be set or the app won't boot:** `PORTAL_TOKEN_SECRET`, `REDIS_PASSWORD`,
  `MONGODB_URI`, `DOMAIN`, `ACME_EMAIL`, and `RAZORPAY_PLATFORM_KEY_ID` +
  `RAZORPAY_PLATFORM_KEY_SECRET` (placeholders are fine while payments are off — the app
  hard-requires _some_ value in production).
- **Optional (features degrade gracefully if blank):** R2 (uploads), SMTP (emails),
  Google (sign-in), Firebase (push), Sentry, MSG91/AiSensy.
- Secret in the connection string? Paste it without it touching logs:
  ```bash
  cd ~/api && read -rsp "Paste value + Enter: " V && echo && \
  sed -i "s#^SOME_KEY=.*#SOME_KEY=${V}#" deploy/.env && unset V
  ```

---

## 6. Database — MongoDB Atlas

- Connection string is in `~/api/deploy/.env` as `MONGODB_URI` (db name `zari360`).
- **The server's IP must be allow-listed:** Atlas → **Network Access** → `3.7.74.67/32`.
- To change the DB password: Atlas → **Database Access** → Edit Password → then update
  `MONGODB_URI` in `.env` and run `sudo docker compose up -d`.
- Migrations run automatically on every deploy via the one-shot **`migrate`** service
  (it's a fail-closed gate: if migrations fail, the new app version will **not** start).

---

## 6b. Create the first admin user (one-time, fresh DB)

A fresh database has **no admin**. The flow **promotes an existing user to admin** — it
does not create one from scratch. So:

1. **Sign up normally** in the app (https://zari360.in) and finish (verify the OTP).
2. **Promote that user** by running this **on the server** (the secret is read from
   `.env`, so it never appears on screen):
   ```bash
   cd ~/api
   SECRET=$(grep '^ADMIN_SETUP_SECRET=' deploy/.env | cut -d= -f2-)
   curl -s -X POST https://api.zari360.in/api/auth/setup-admin \
     -H 'Content-Type: application/json' \
     -d "{\"identifier\":\"YOUR_EMAIL_OR_MOBILE\",\"secret\":\"$SECRET\"}"; echo
   ```
   Replace `YOUR_EMAIL_OR_MOBILE` with the email/mobile you signed up with.
   Success → `{"message":"User ... has been granted admin access"}`.

Notes:

- **One-time:** it refuses once an admin exists (`An admin user already exists`).
- The user **must already exist** (sign up first), else `No user found...`.
- Add more admins later from the in-app **Admin → Users** screen.

---

## 7. HTTPS / domain (Caddy + Route 53)

- DNS for `zari360.in` is in **AWS Route 53**. The API needs an **A record**:
  `api` → `3.7.74.67`.
- Caddy gets + auto-renews the Let's Encrypt certificate. No manual cert work.
- **If you changed DNS and HTTPS isn't working**, force Caddy to retry:
  ```bash
  cd ~/api/deploy && sudo docker compose restart caddy
  sudo docker compose logs caddy | grep -i "certificate obtained"
  ```
- Ports **80 and 443** must be open in the EC2 Security Group (they are).

---

## 8. From scratch — rebuild the whole server (disaster recovery)

If the box is ever lost, recreate it:

1. **Launch EC2**: Ubuntu (ARM/`t4g.small`), 30 GB disk, Security Group open on
   `22, 80, 443`. Attach the Elastic IP `3.7.74.67` (or update the `api` DNS record).
2. **Install Docker**:
   ```bash
   curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER
   ```
   (log out/in once after this)
3. **(Recommended) add 2–4 GB swap** as a safety net:
   ```bash
   sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && \
   sudo swapon /swapfile && echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
   ```
4. **Get the code** onto `~/api` (Section 4, Option A or B).
5. **Create `~/api/deploy/.env`** from `.env.example` and fill in the secrets.
6. **Allow-list the new IP in Atlas** (Section 6).
7. **Bring it up**:
   ```bash
   cd ~/api/deploy && sudo docker compose up -d --build
   ```
8. **Verify**: `curl -s https://api.zari360.in/api/health`

---

## 9. Troubleshooting

| Symptom                                       | Likely cause → fix                                                                                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `migrate` service exits 1, app won't start    | Read `sudo docker compose logs migrate`. Common: bad `MONGODB_URI` / Atlas auth (`AtlasError`) → fix the password; IP not allow-listed in Atlas → add `3.7.74.67/32`.          |
| `bad auth: Authentication failed`             | Wrong DB user/password in `MONGODB_URI`. Reset in Atlas → Database Access, re-paste, `up -d`.                                                                                  |
| Email not sending                             | `SMTP_HOST/PORT/USER/PASS/FROM` must all be set in `.env`. Gmail: host `smtp.gmail.com`, port `587`, pass = a Google **App Password**. Then `up -d`.                           |
| `.env` change didn't take effect              | You ran `restart` — use `up -d` instead (it recreates with the new env).                                                                                                       |
| HTTPS / cert errors                           | DNS not pointing at the box yet, or Caddy tried before DNS propagated → `restart caddy` (Section 7).                                                                           |
| Containers keep restarting / very slow        | Out of memory (this app + DB on a tiny box). DB is on Atlas now, so the app alone should fit; if not, resize the instance (Stop → Change instance type → Start; data is kept). |
| Sign in with Google fails (`origin_mismatch`) | Add `https://zari360.in` to **Authorized JavaScript origins** in Google Cloud Console → Credentials → your OAuth client. ~5 min to propagate.                                  |

---

## 10. Routine deploy (once on `git clone`)

```bash
cd ~/api
./deploy/deploy.sh      # git pull → build → migrate gate → restart web/worker/caddy
```

Until then, use Section 4 Option A + the commands in Section 3.

```



Changed .env →
sudo docker compose up -d

Changed code →
sudo docker compose build && sudo docker compose up -d


Check status →
sudo docker compose ps
```

AFTER MERGING NEW CHANGES IN THE BE
cd ~/api && bash deploy/deploy.sh
