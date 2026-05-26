# Content Mirror — Design Document

**Status:** Draft (in active discussion)
**Owner:** Andrii
**Last updated:** 2026-05-26

---

## 1. Problem and constraints

Build an invite-only web service that mirrors YouTube and Facebook content to external storage so a small group (family + friends, ~5–10 users) in Russia can view it without a VPN. AWS-leaning stack acceptable, but Russia-facing endpoints cannot rely on AWS IP ranges due to Roskomnadzor blocking risk.

**Load-bearing constraints:**

1. Viewers in Russia have no VPN. The viewer endpoint must be reachable from a Russian residential connection on the day they try to use it. Raw AWS (CloudFront, S3) is ruled out as the front door.
2. YouTube actively blocks datacenter IP downloads. The download path is the fragile part of the system, not the AWS plumbing.
3. Audience is small (≤10). Optimize for low ongoing cost and simple ops over scale.
4. Viewers use desktop browsers only. No HLS / DASH / casting required.

---

## 2. Architecture (v1)

Two strict lanes:

- **Cloudflare edge (Russia-facing):** Pages (admin + viewer UI), Worker (auth proxy, signed URLs), R2 (finished video files). Cloudflare Access in front of everything for identity.
- **AWS backend (never exposed to Russia):** API Gateway + Lambda (FastAPI handlers), DynamoDB (metadata), SQS (job queue), Secrets Manager (yt-dlp cookies + tokens), Fargate Spot (yt-dlp + ffmpeg worker).

External sources (YouTube, Facebook, future) are pulled by the Fargate worker only.

### Trust boundary

The Cloudflare Worker is the only thing in front of AWS. AWS endpoints are not directly reachable from Russia by design. The Worker forwards authenticated calls to API Gateway using a shared secret (mTLS or HMAC-signed request header). The Worker mints short-lived signed URLs for R2 reads when a viewer plays a video — viewers never get long-lived URLs.

### Submission flow

1. Admin loads admin UI on Cloudflare Pages.
2. Admin submits a YouTube/Facebook URL.
3. Pages → Worker → API Gateway → Lambda.
4. Lambda writes `Item { status: queued }` to DynamoDB and pushes a job to SQS.
5. Fargate worker pulls the job, fetches cookies from Secrets Manager, runs `yt-dlp`, merges streams with ffmpeg, uploads the MP4 to R2, updates DynamoDB (`status: ready`).

### Viewing flow

1. Parents load viewer UI on Cloudflare Pages.
2. Page calls Worker for library listing.
3. Worker → API Gateway → DynamoDB returns metadata.
4. User clicks a video. Worker mints a signed R2 URL (TTL: 6 hours).
5. Browser streams MP4 from R2 directly.

### Decisions captured so far

- **Auth:** Cloudflare Access with Google email allowlist. No custom auth code.
- **Transcoding:** None in v1. yt-dlp merged MP4 served as-is. ffmpeg present in container only for yt-dlp's internal stream merge.
- **Retention:** 30-day TTL with a `pinned: bool` override. Pinning is **global** (one flag per item, not per-user) and **admin-only** (no viewer-side pin UI). A pinned item is exempt from cleanup for everyone. Daily EventBridge → Lambda cleanup job.
- **Storage:** Cloudflare R2 (S3-compatible, zero egress fee).
- **Job queue:** SQS standard queue.
- **Workers:** Fargate Spot, x86. 0.25 vCPU / 0.5 GB sized initially.

---

## 3. Tech stack

### Languages and runtimes

| Layer | Choice | Notes |
|---|---|---|
| Fargate worker | Python 3.12 | yt-dlp is Python; native plugin ecosystem required |
| Lambda API | Python 3.12 + FastAPI + Lambda Web Adapter | Single backend language; cold starts 200–400ms acceptable for admin UI |
| Cloudflare Worker | TypeScript + Hono | Edge auth proxy + signed-URL minting; small (~500 LOC target) |
| Frontend (admin + viewer) | Next.js 14+ with `output: 'export'` (static export) | Deploys as plain static files to Cloudflare Pages; no adapter required. RSC disabled (incompatible with static export). |

### API exposure

- Lambda **Function URLs**, not API Gateway. Single caller (Cloudflare Worker) authenticated via HMAC header.

### DynamoDB access

- Plain `boto3` (sync) inside Lambda, `aioboto3` if/when we go async. **No ORM.**
- Pydantic v2 models for validation; hand-written `to_item` / `from_item` per entity.
- Single-table design: one table, composite key `(pk, sk)`, GSIs as needed.

### Container

- Base: `python:3.12-slim`
- `ffmpeg` installed via apt (needed for yt-dlp's internal stream merge, not for re-encoding)
- Multi-stage Dockerfile
- Dependency install via `uv` (fast, increasingly standard)

### Observability

- Structured JSON logs via AWS Lambda Powertools for Python; same JSON shape from Fargate worker (stdout → CloudWatch)
- CloudWatch Alarms on: Lambda errors, SQS `ApproximateAgeOfOldestMessage`, Fargate task failures
- Alarms → SNS topic → email
- Cloudflare Worker logs via `wrangler tail` + Workers Analytics (separate system)
- **No Sentry** (deliberate choice — accepted trade-off: blind to browser-side errors, two log-search UIs)
- Saved CloudWatch Logs Insights queries committed to repo for common debug patterns

### Package management and tooling

- Python: `uv`
- JS/TS: `pnpm`, Node 22 LTS
- TypeScript 5.x

### Deliberately not included

- Redis / ElastiCache (premature at this scale)
- CloudFront (viewers never touch AWS)
- Cognito (Cloudflare Access handles identity)
- API Gateway (Function URLs sufficient)
- Sentry (CloudWatch-only by choice)


---

## 4. Infrastructure as Code

### Tool

- **OpenTofu** (Terraform-compatible, BSL-free fork).
- AWS provider + Cloudflare provider in a single stack.
- Rationale: needs to manage AWS and Cloudflare together; Terraform/OpenTofu has the largest ecosystem and provider coverage. Pulumi is a valid alternative; CDK is rejected (AWS-only); SST is rejected (too opinionated for our shape).

### State backend

- S3 bucket (versioned, encrypted) with **native S3 object locking** (OpenTofu 1.10+).
- Keys: `state/dev.tfstate`, `state/prod.tfstate`.
- No DynamoDB lock table needed.
- Bucket created via one-time bootstrap (`infra/bootstrap/` with local backend), then state migrated.

### Environments

- **Single env: `prod` only.** Hobby-scale project; not worth maintaining two envs.
- Compensating controls for the lack of a dev env:
  - `tofu plan` mandatory before any `apply`, plan posted to PR by CI for review
  - Full local-dev story: `wrangler dev` (Worker), `uvicorn` (FastAPI Lambda — Lambda Web Adapter runs same code locally), `docker run` (Fargate worker), `next dev` (web)
  - Lambda **canary deploys** with auto-rollback (CodeDeploy + Lambda alias, 10% → 100% over 5 min)
  - DynamoDB point-in-time recovery enabled

### Module structure

- Flat layout in `infra/` (one `.tf` file per resource category).
- No `modules/` directory until repetition justifies it (≥2x). Reassess past ~1500 LOC HCL.

### Terraform / Wrangler / CI boundary

- **Terraform: shape only.** Resources exist; have this size/role/binding/secret.
- **Wrangler: Worker + Pages code deploys** (`wrangler deploy`, `wrangler pages deploy`).
- **GitHub Actions: Lambda + Fargate code/image deploys.** Build → push to ECR / S3 zip → `update-function-code` or update ECS task image tag.
- Mental model: *Terraform for shape, CI for code.*

### Secrets

- AWS Secrets Manager: runtime secrets (yt-dlp cookies, Worker↔Lambda HMAC, future proxy credentials).
- Worker↔Lambda HMAC: generated by Terraform `random_password`, stored in Secrets Manager + pushed to Cloudflare Worker via `cloudflare_workers_secret`. Single source of truth.
- `.tfvars` gitignored. `terraform.tfvars.example` committed.
- AWS credentials in CI via **OIDC federation** (no long-lived keys). Cloudflare API token via GitHub Secrets (Cloudflare lacks OIDC).

### CI/CD shape

- GitHub Actions, one workflow per concern (infra, worker, pages, lambda-api, lambda-cleanup, fargate-worker).
- PR: plan / build / test only.
- Push to `main`: auto-deploy to `dev`.
- Tagged release on `main`: deploy to `prod` with manual approval gate.

---

## 5. Project structure

**Monorepo.** Single repo with two workspace systems (uv for Python, pnpm for TS).

### Top-level layout

```
content-mirror/
├── README.md
├── design.md
├── .github/workflows/        # infra, edge, web, api, worker
├── infra/                    # OpenTofu, flat
├── apps/
│   ├── web/                  # Next.js (admin + viewer), static export
│   ├── edge/                 # CF Worker, TS + Hono
│   ├── api/                  # Python Lambda(s): FastAPI main + scheduled cleanup
│   └── worker/               # Python Fargate worker
├── packages/
│   ├── python-shared/        # models, ddb helpers
│   └── ts-shared/            # API request/response types
├── pnpm-workspace.yaml
├── pyproject.toml            # uv workspace root
├── ruff.toml
└── .pre-commit-config.yaml
```

### Decisions

- **Cleanup Lambda merged into `apps/api`** as a separate handler entry point (same codebase, same container image, different `CMD`). Avoids a tiny standalone app.
- **Shared packages from day one.** `python-shared` consumed by `api` and `worker` via uv workspace. `ts-shared` consumed by `edge` and `web` via pnpm workspace. Single source of truth for models and API types.
- **No Nx / Turborepo / Bazel.** Two TS apps and two Python apps don't justify a meta-build tool. uv + pnpm cooperate without coordination.

### Naming

- Python packages: `content_mirror_<role>` (e.g. `content_mirror_api`)
- TS packages: `@content-mirror/<role>` scope
- AWS/Cloudflare resources: `content-mirror-<resource>`

---

## 6. Linting, formatting, type-checking, CI

### Per-language tooling

| Language/area | Tool | Replaces |
|---|---|---|
| Python lint + format | `ruff` | flake8 + black + isort + pyupgrade + autoflake |
| Python type-check | `pyright` | mypy |
| Python test | `pytest` (+ `pytest-asyncio`) | — |
| TS lint + format | `biome` | eslint + prettier |
| TS type-check | `tsc --noEmit` | — |
| TS test | `vitest` | jest |
| HCL format | `tofu fmt` (built-in) | — |
| HCL lint | `tflint` | — |
| HCL security | `checkov` | tfsec |
| Dockerfile | `hadolint` | — |
| Shell | `shellcheck` | — |
| Secrets | `gitleaks` (pre-commit hook) | — |

### Orchestration

- **`pre-commit` framework** runs fast checks on `git commit`: ruff, biome, tofu fmt, hadolint, gitleaks, hygiene hooks (trailing whitespace, EOF newlines, large file guard).
- **Slow checks (pyright, tsc, tflint, checkov, tests) run only in CI**, not pre-commit.
- **`mise`** at repo root pins toolchain versions (Python 3.12, Node 22, opentofu, uv, pnpm, ruff, biome). Same versions locally and in CI.
- **`just`** task runner with verbs: `dev`, `test`, `lint`, `typecheck`, `plan`, `deploy-edge`, `deploy-web`, `deploy-api`, `deploy-worker`.

### GitHub Actions workflows

| Workflow | Trigger | Action |
|---|---|---|
| `ci.yml` | PR | Lint + typecheck + test (path-filtered) + `tofu plan` posted to PR |
| `infra.yml` | push to `main` | `tofu apply`, gated by GitHub environment protection (manual approval) |
| `edge.yml` | `main` + `apps/edge/**` | `wrangler deploy` |
| `web.yml` | `main` + `apps/web/**` or `packages/ts-shared/**` | `next build` + `wrangler pages deploy ./out` |
| `api.yml` | `main` + `apps/api/**` or `packages/python-shared/**` | Build container → ECR → update Lambda → CodeDeploy canary |
| `worker.yml` | `main` + `apps/worker/**` or `packages/python-shared/**` | Build container → ECR → ECS service update |

- PR previews for `web` via `wrangler pages deploy --branch=$BRANCH`.
- AWS auth via **OIDC federation** (no long-lived keys). Cloudflare via API token in GitHub Secrets.

### Branch protection

- Required PR (no direct push)
- `ci.yml` must be green
- Linear history (squash-merge only)
- No force-push

### Dependency updates

- **Renovate** (richer config than Dependabot). One `renovate.json` with grouping: AWS SDK group, dev-deps group, security updates auto-merged on green CI. **Exception:** `yt-dlp` and `bgutil-pot` require manual review (anti-bot-fragile — a regression could ship if it slips past the single-video smoke test).

---

## 7. Cost estimate

### Assumptions

- 5 users × 20 viewing-hours/month = 100 viewing-hours/month
- Avg video: 30 min, 1080p, ~3.5 Mbps → ~800 MB
- ~60 new videos/month
- 30-day retention → ~50 GB steady-state storage
- us-east-1, single AZ for the worker

### Best-case monthly cost

| Item | Monthly |
|---|---|
| R2 storage (40 GB billable × $0.015) | $0.60 |
| R2 egress (158 GB × $0) | $0.00 |
| R2 ops (within free tier) | $0.00 |
| Fargate Spot compute + memory (~1 hr/mo, scale-to-zero) | $0.05 |
| Public IPv4 (Fargate, ~1 hr/mo) | $0.01 |
| Lambda API + cleanup (~2k invocations) | $0.00 |
| DynamoDB on-demand (within 2.5M RRU + 2.5M WRU + 25 GB always-on free tier) | $0.00 |
| DynamoDB PITR (continuous backup, <1 GB × $0.20/GB-mo) | $0.20 |
| SQS (within free tier) | $0.00 |
| Secrets Manager (2–3 secrets × $0.40) | $1.00 |
| CloudWatch logs + alarms (within free tier) | $0.00 |
| ECR storage | $0.05 |
| AWS data transfer out (50 GB, within 100 GB free tier) | $0.00 |
| Cloudflare Pages / Workers / Access | $0.00 |
| Domain (.com amortized) | $0.92 |
| **Total** | **~$2.83** |

*Prices verified May 2026: AWS Secrets Manager, DynamoDB, Lambda, NAT Gateway, public IPv4, Fargate Spot; Cloudflare R2, Workers, Access. See sources at end of document.*

### Scenario deltas

| Scenario | New total |
|---|---|
| Add NAT Gateway (private subnet for Fargate) | ~$36 |
| Need residential proxies for YouTube (~50 GB × $5/GB) | ~$253 |
| Both above | ~$286 |
| 5x audience growth (25 users × 20 hr/mo) | ~$6 |
| S3 + CloudFront instead of R2 + CF | ~$17 |

### Key takeaways

1. Hosting cost rounds to zero. The visible line items are domain ($0.92) and Secrets Manager ($1).
2. **R2 vs S3 saves $14/mo in egress** plus removes AWS exposure to Russia. Structural win.
3. **NAT Gateway is the trap.** $33/mo for nothing. Public subnet + tight SG is safe for outbound-only workers.
4. **Anti-bot strategy is the dominant cost lever.** $3/mo with cookies, $250+/mo if forced onto residential proxies.
5. AWS 100 GB/mo egress free tier covers worker → R2 uploads at projected scale. Cliff at ~2x growth.

### Cost-reduction levers (if needed)

- Drop Secrets Manager → use Parameter Store ($0) for the HMAC secret; keep Secrets Manager only for cookies if rotation hooks wanted: saves $0.60/mo
- ARM-based Fargate (Graviton) instead of x86 Spot: ~20% cheaper compute; trivial savings at this scale
- Single Secrets Manager secret with all values JSON-encoded: $0.40 vs $1.20 for three

---

## 8. yt-dlp anti-bot strategy

### 2026 landscape (validated)

- YouTube SABR actively kills yt-dlp connections, especially from datacenter IPs.
- `android_sdkless` client (the workhorse for cloud-based extraction in 2024) is phased out. Use `tv_embedded` + `web_safari`.
- **PO Tokens (Proof-of-Origin Tokens) are required** for many videos. Cookies-only path is no longer sufficient.

### Layer 1: v1 default

**Three components, all running together in the Fargate task:**

1. **yt-dlp** pinned in `apps/worker/pyproject.toml`. Renovate weekly PR + CI smoke test against a known-stable video → **manual review and merge** (not auto-merge). Reason: a regression that doesn't trip the single test video but breaks a fraction of real-world videos would otherwise auto-deploy. Same policy applies to `bgutil-pot`. Other dependencies (FastAPI, boto3, etc.) auto-merge on green.
2. **`bgutil-ytdlp-pot-provider` HTTP server as a Fargate sidecar container.** Prefer the **Rust port** (`jim60105/bgutil-pot-rs`) over the Node.js variant — smaller image (~50 MB vs ~150 MB), faster cold start. Two-container task: yt-dlp main + bgutil-pot sidecar on `localhost:4416`. Generates BotGuard-backed PO Tokens. ~50 MB memory, near-zero CPU when idle. **Pin the version** in the task definition (don't track `:latest`); Renovate watches for updates with manual-merge policy (see §8).

   Use **ECR pull-through cache** for `python:3.12-slim` (worker base) and the bgutil-pot image. Mirrors public Docker Hub images into your ECR; eliminates Docker Hub rate-limit risk and speeds image pulls by 2–3x on Fargate cold start.
3. **Cookies from a throwaway Google account**, exported from Firefox on a residential connection (Andrii's laptop), stored in AWS Secrets Manager, fetched at task start. Monthly manual re-export (calendar reminder).

Reference yt-dlp invocation:

```bash
yt-dlp \
  --cookies /tmp/cookies.txt \
  --extractor-args "youtube:player_client=tv_embedded,web_safari" \
  --extractor-args "youtube:po_token=web.gvs+http://localhost:4416/get_pot" \
  --sleep-interval 5 --max-sleep-interval 15 \
  --retries 3 --fragment-retries 5 \
  -f 'bestvideo[height<=1080]+bestaudio/best[height<=1080]' \
  --merge-output-format mp4 \
  <URL>
```

### Escalation ladder

| Layer | Approach | Monthly cost | When to enable |
|---|---|---|---|
| 1 | Cookies + PO Token + tv_embedded | ~$3 | Default |
| 2a | WireGuard tunnel to home box + SOCKS5 proxy | ~$3 (free if existing box) | Layer 1 failure rate >10% |
| 2b | WireGuard tunnel to small VPS + SOCKS5 proxy | ~$8 | No home box available |
| 3 | Residential proxy on **retry only** (10–30% of traffic) | ~$15–60 | Layer 2 not enough |
| 3-all | Residential proxy on **all** YouTube traffic | ~$100–200 | Aggressive blocking phase |
| 4 | Pivot access channel (Telegram bot) | varies | Layer 3 economically unsustainable |

**Recommended posture:** ship with Layer 1, have Layer 2a setup-ready (a home Pi or a friend's box), reserve budget for Layer 3 retry-only.

**Layer 2 routing detail.** Selective, not full-tunnel:
- Home/VPS box runs WireGuard server + a SOCKS5 listener (e.g. dante, 3proxy) bound to the tunnel interface.
- Worker container brings up a WireGuard client at task start (no default-route change — tunnel exists but isn't used by default).
- yt-dlp is invoked with `--proxy socks5h://<tunnel-peer>:1080`, so only YouTube/Facebook traffic transits the tunnel.
- Worker → R2 / DDB / SQS / Secrets Manager continues to use Fargate's default route at full speed.
- This isolates residential-IP usage to the calls that need it; everything else stays on AWS.

### Facebook-specific notes

- Cookies always required + frequent `--impersonate` flag (curl-cffi) needed.
- No equivalent to PO Token provider ecosystem; bypasses are bespoke.
- Extractor breaks every few months. Plan for periodic outages.
- **Manual-upload fallback in admin UI from day one** (R2 presigned PUT + DDB write). ~50 lines of code; insurance for when Facebook just refuses to be scraped.

### Cookie management

- Throwaway Google account (no recovery, no real PII, single-purpose).
- Initial export from Firefox on a residential connection (`--cookies-from-browser firefox` or an extension).
- Stored in AWS Secrets Manager.
- **Monthly re-export** via calendar reminder; no auto-refresh.
- Account-burn budget: assume 1–2 throwaway accounts per year; have a backup ready.

### yt-dlp version hygiene

- Pin version in `pyproject.toml`.
- Renovate PR weekly with new version.
- CI smoke test: download a known-stable CC-licensed video end-to-end.
- Auto-merge on green; manual review on failure.

### Monitoring (CloudWatch-only)

- Worker emits structured JSON log line per job: `event`, `status`, `failure_reason`, `duration_ms`, `video_id`.
- Metric filter on `failure_reason=youtube_bot_detection` → custom metric.
- Alarm: >3 such failures in 1 hour → SNS → email/SMS.
- Separate alarm on `failure_reason=cookies_expired`.
- Logs Insights saved query: failures by reason, last 7 days.
- Dead-letter SQS queue for fully-failed jobs.

### Operational runbook

1. **Bot-detection alarm fires** → reproduce failed URL on laptop with same yt-dlp version.
2. Works on laptop → cloud cookies stale; re-export, push to Secrets Manager.
3. Fails on laptop too → yt-dlp needs update; check Renovate PR or bump manually.
4. yt-dlp current + cookies fresh but cloud still fails → datacenter IP flagged; enable Layer 2 (WireGuard) or Layer 3 (proxy retry).
5. All automation fails → manual download + admin UI upload (Layer 4 fallback).

---

## 9. Domain and DNS

- **Registrar:** Cloudflare Registrar (at-cost, no markup, nameservers pre-configured).
- **Name:** TBD — disguised / generic noun, no media keywords (avoid "youtube", "tube", "mirror", "proxy", "vpn", "video").
- **TLD:** `.com` or `.app` (~$10–12/year).
- **DNS zone (minimal):**
  - `<domain>` (apex) → Cloudflare Pages
  - `www.<domain>` → CNAME to apex (redirect)
  - `videos.<domain>` → R2 bucket binding (CF Access protected, same allowlist)
  - Cloudflare Worker bound to `<domain>/api/*` route pattern (no separate subdomain)
- **Email:** Cloudflare Email Routing (free) — `admin@<domain>` → personal email; catchall optional.
- **TLS settings:** SSL mode = Full (strict); HSTS with `max-age=31536000; includeSubDomains; preload`; Automatic HTTPS Rewrites = on; Always Use HTTPS = on; DNSSEC = on; Min TLS Version = 1.2.
- **Zone-level:** Bot Fight Mode off; Security Level medium; Browser Integrity Check on; Web Analytics on.

## 10. Cloudflare Access policy

- **IdP:** Google + One-Time PIN (both enabled).
- **Allowlist:** Explicit per-email list managed in Terraform via `cloudflare_zero_trust_access_policy`.
- **Session duration:** 30 days. Reason: this audience (5 family members) has a negligible stolen-session risk and the UX cost of mid-watch session expiry is real (the `<video>` element fails on a 401 range request). 30 days makes login a roughly monthly event rather than weekly.
- **MFA from IdP:** Not required.
- **Access boundary:** Protect everything (`<domain>/*` and `videos.<domain>/*`). No public pages.
- **Defense in depth:** Worker independently verifies `Cf-Access-Jwt-Assertion` against Cloudflare's JWKS before proxying to AWS.

## 11. DynamoDB schema

**Table:** `content-mirror` — single table, PAY_PER_REQUEST, PITR enabled, no Streams.

- pk (HASH, string), sk (RANGE, string)
- GSI1: GSI1PK (HASH) + GSI1SK (RANGE), projection ALL

**Item entity:**

- pk = `"ITEM"`, sk = `<ULID>`
- GSI1PK = `status` (mirror), GSI1SK = sk
- Attributes: `id`, `source_url`, `source_type` (youtube/facebook/manual), `url_hash`, `status` (queued|downloading|ready|failed|failed_permanent), `failure_reason`, `retry_count`, `title`, `duration_seconds`, `thumbnail_r2_key`, `file_r2_key`, `file_size_bytes`, `created_at`, `updated_at`, `ready_at`, `pinned` (bool), `submitted_by` (email), `processing_started_at`

**Access patterns:** see design doc body; all eight patterns served by base table + GSI1.

**Schema lives in `packages/python-shared/`** as Pydantic models + key builders + `ItemRepo`. Both `apps/api` and `apps/worker` import from there.

## 12. Worker job lifecycle

- **SQS:** Standard queue `content-mirror-jobs` (visibility 30 min, long-poll 20s, maxReceiveCount 3) + DLQ `content-mirror-jobs-dlq` (14-day retention, alarm on any visible message).
- **Idempotency:** Conditional DynamoDB UpdateItem with `status IN (queued, failed) OR (downloading AND processing_started_at < stale_cutoff)`. Stale locks recover.
- **Heartbeat:** Background thread extends SQS visibility every 5 minutes during job execution; 2-hour hard cap.
- **Retry classification:**
  - `RetryableError` (network, transient YouTube errors, bot detection) → leave message in queue
  - `PermanentError` (404, video removed, malformed URL) → mark `failed_permanent`, delete message
  - After 3 retries → SQS moves to DLQ; admin alerted
- **R2 orphan prevention:** Conditional DDB commit; if commit fails, worker deletes its R2 uploads. **Weekly orphan-sweep Lambda** as belt-and-braces: lists all keys under `videos/` and `thumbs/` prefixes, extracts the item ID from each key, checks DDB; if the item doesn't exist or is in a non-ready state with no expectation of upload, deletes the R2 object. Handles videos and thumbnails together so neither orphans the other.
- **ECS service scaling:** Step scaling on `ApproximateNumberOfMessagesVisible`. Min=0, Max=2. Scale-in cooldown 5 min.
- **Cold-start latency:** scale-from-zero takes ~60–120 seconds end-to-end (image pull from ECR including the bgutil-pot sidecar, ENI attach, container init, SQS first-poll). First job after idle waits this long before it starts. Acceptable for admin-driven workflow (submit and come back later). If "submit and watch immediately" is ever needed, bump min capacity to 1 (~$5/month always-on, eliminates cold start).
- **Structured log events** at each lifecycle point for CloudWatch metric filters and saved Insights queries.

### Cleanup lifecycle (daily Lambda)

The cleanup Lambda runs daily via EventBridge and processes five status buckets with different cutoffs:

| Status | Cutoff | Action |
|---|---|---|
| `ready` (unpinned) | `created_at < now - 30 days` | Delete R2 video + R2 thumbnail + DDB row |
| `failed` | `updated_at < now - 30 days` | Delete DDB row (no R2 to clean) |
| `failed_permanent` | `updated_at < now - 30 days` | Delete DDB row |
| `downloading` | `updated_at < now - 7 days` | Delete DDB row (orphaned — SQS gave up) |
| `queued` | `created_at < now - 7 days` | Delete DDB row (abandoned — never reached worker) |

Implementation: one `Query GSI1` per status, in-code filter on the time field, `BatchWriteItem` deletes. Five queries, daily run, takes seconds at this scale. Pinned items are exempt regardless of status.

## 13. API surface and HMAC signing

**Endpoints (11 total):**

| Method | Path | Auth |
|---|---|---|
| GET | `/api/me` | Any user (served by Worker, no Lambda call) |
| GET | `/api/items` | Any user |
| GET | `/api/items/:id` | Any user |
| POST | `/api/admin/submit` | Admin |
| POST | `/api/admin/manual-upload` | Admin |
| POST | `/api/admin/items/:id/finalize` | Admin |
| GET | `/api/admin/items` | Admin |
| GET | `/api/admin/stats` | Admin — returns `{ ready_24h, failed_24h, stuck_count }` for the `/admin` status panel |
| POST | `/api/admin/items/:id/pin` | Admin |
| POST | `/api/admin/items/:id/retry` | Admin |
| DELETE | `/api/admin/items/:id` | Admin |

**Three trust layers:** (1) CF Access cookie → JWT, (2) Worker verifies JWT + admin email check, (3) HMAC-signed proxy from Worker to Lambda Function URL.

**JWT verification — fail closed.** The Worker fetches Cloudflare's JWKS once and caches it. On JWT verification: any failure (malformed, invalid signature, expired, claims don't match expected issuer/audience) → reject 401. If JWKS fetch itself fails on a cache miss (e.g., key rotation during a Cloudflare incident), also reject 401 — never serve unverified traffic.

**Admin email management.** Admin emails live in a comma-separated Worker env var (`ADMIN_EMAILS`), managed by Terraform via `cloudflare_workers_secret`. Updating the admin set requires a `tofu apply` + `wrangler deploy`. Chosen for simplicity at v1 scale (1 admin, rare changes). Alternatives if the admin set grows or changes frequently: Workers KV (edit via dashboard, no redeploy), a DynamoDB row (editable via admin UI), or a Cloudflare Access group (lets CF Access enforce the distinction natively via JWT claims). Move off env-var when there are >3 admins or membership churns weekly.

**Video serving:** R2 bucket bound to `videos.<domain>`, CF Access protected. Browser embeds `<video src="https://videos.<domain>/videos/<id>.mp4">`. No `/play` endpoint, no signed URLs needed.

**Cache-Control on R2 objects.** The worker sets these headers on every video and thumbnail upload:

```
Cache-Control: public, max-age=31536000, immutable
Content-Type:  video/mp4   (or image/jpeg for thumbs)
```

URLs are content-addressable (ULID never reused), so the content at a given URL never changes. Cloudflare's edge caches accordingly — repeat views of the same video by different family members hit the edge cache, not R2. After 30-day deletion the URL becomes 404; the previously-cached copy ages out naturally.

**R2 CORS** (required for the manual-upload PUT from the browser):

```json
{
  "AllowedOrigins": ["https://<domain>.app"],
  "AllowedMethods": ["PUT"],
  "AllowedHeaders": ["Content-Type"],
  "MaxAgeSeconds": 3600
}
```

Managed in Terraform via the Cloudflare provider's R2 CORS configuration resource. Video playback (`<video src=...>` without `crossorigin`) does not trigger CORS — only the XHR-driven PUT does.

**HMAC scheme:**
- `canonical = timestamp + ":" + method + ":" + path + ":" + sha256(body)`
- `signature = hex(HMAC-SHA256(shared_secret, canonical))`
- Headers: `X-Worker-Timestamp`, `X-Worker-Signature`, `X-User-Email`
- Lambda verifies signature + checks `|now − timestamp| ≤ 60s`
- Shared secret managed by Terraform `random_password`, replicated to AWS Secrets Manager and Cloudflare Workers Secret.

**Lambda Function URL:** AuthType=NONE. HMAC is the only auth.

## 14. Next.js page layout

**Pages (5):**
- `/` — library (viewer home, grid of ready items)
- `/watch?id=<id>` — player (native `<video controls>`)
- `/admin` — submit form + recent items + 24h status panel (`{ ready_24h, failed_24h, stuck_count }` from `/api/admin/stats`)
- `/admin/items` — full item list with filters and actions
- `/admin/upload` — manual file upload (presigned R2 PUT)

**Query-param routing** (not dynamic segments) to play cleanly with static export.

**App Router static-export compatibility:**

| Works | Doesn't work |
|---|---|
| Client components (`'use client'`) | React Server Components (must disable globally) |
| `loading.tsx`, `error.tsx`, `not-found.tsx` | Server actions |
| Static segments + route groups (`(viewer)`, `(admin)`) | Middleware (`middleware.ts`) |
| `next/navigation` hooks (`useRouter`, `useSearchParams`) | `headers()` / `cookies()` from `next/headers` |
| Metadata via static `metadata` export | Dynamic route segments without `generateStaticParams` |
| Tailwind, CSS Modules, plain CSS | API routes (`app/api/*/route.ts`) — also conflicts with Worker `/api/*` |
| `<Image unoptimized>` | Image optimization |
| | ISR / on-demand revalidation |

`next.config.mjs`:

```javascript
const nextConfig = {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
};
```

For reading the authenticated user's identity from the client: do **not** use `cookies()` — use a `fetch('/api/me')` on mount (the Worker reads the JWT and returns the email + is_admin). Same for any auth-conditional rendering.

**Stack:** Tailwind CSS + shadcn/ui (copy-paste components) + SWR for data fetching. React `useState` for form state. No Redux/Zustand.

**API client:** `apps/web/src/lib/api.ts` — thin fetch wrapper, types from `packages/ts-shared`. Auto-reloads on 401 (Access session expired).

**Explicitly out of v1:** search, folders/playlists, watch history, subtitles, multiple qualities, comments, theming. All can be added later without schema migration.

## 15. IAM and least-privilege

**Six IAM principals:**

| Role | Used by |
|---|---|
| `content-mirror-api-lambda-role` | API Lambda |
| `content-mirror-cleanup-lambda-role` | Cleanup Lambda |
| `content-mirror-worker-task-role` | Fargate worker (application code) |
| `content-mirror-worker-execution-role` | Fargate (ECS agent — image pull, log writing) |
| `content-mirror-github-deploy-role` | GitHub Actions (code/image deploys) |
| `content-mirror-github-infra-role` | GitHub Actions (`tofu apply`) |

**Principles enforced:**
- No `Resource: "*"` except where impossible to scope (e.g., `ecr:GetAuthorizationToken` global).
- Per-role isolation — API and cleanup Lambdas don't share roles; ECS task and execution roles separated; deploy and infra GH roles separated.
- GitHub OIDC federation (no long-lived AWS keys); trust policies condition on repo + branch/tag.

**Cloudflare tokens (three, scoped):**
- `content-mirror-terraform` — broad, used by IaC in CI
- `content-mirror-pages-deploy` — Pages only
- `content-mirror-worker-deploy` — Worker only

**Resource-based policies:** EventBridge → Cleanup Lambda only (scoped via `aws:SourceArn`). Lambda Function URL has no policy (AuthType=NONE; HMAC is the auth).

## 16. Sources and references

**Price verification (May 2026):**
- AWS Secrets Manager pricing: https://aws.amazon.com/secrets-manager/pricing/
- AWS DynamoDB pricing: https://aws.amazon.com/dynamodb/pricing/
- AWS Lambda pricing: https://aws.amazon.com/lambda/pricing/
- AWS Fargate pricing: https://aws.amazon.com/fargate/pricing/
- AWS NAT Gateway pricing: https://aws.amazon.com/vpc/pricing/
- AWS public IPv4 charge: https://aws.amazon.com/blogs/aws/new-aws-public-ipv4-address-charge-public-ip-insights/
- AWS 100 GB free egress: https://aws.amazon.com/blogs/aws/aws-free-tier-data-transfer-expansion-100-gb-from-regions-and-1-tb-from-amazon-cloudfront-per-month/
- Cloudflare R2 pricing: https://developers.cloudflare.com/r2/pricing/
- Cloudflare Workers pricing: https://developers.cloudflare.com/workers/platform/pricing/
- Cloudflare Zero Trust / Access (50-user free tier): https://www.cloudflare.com/plans/

**yt-dlp / PO Token references:**
- yt-dlp PO Token Guide: https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide
- bgutil-ytdlp-pot-provider (TypeScript): https://github.com/Brainicism/bgutil-ytdlp-pot-provider
- bgutil-ytdlp-pot-provider-rs (Rust): https://github.com/jim60105/bgutil-ytdlp-pot-provider-rs
- Docker image: https://hub.docker.com/r/jim60105/bgutil-pot
