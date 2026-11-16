# Deploying

Frontend on Vercel, backend on Heroku. Both redeploy when you push to `main`.

The artifacts are committed and total 12 MB, so neither side downloads the
21.8 GB graph. The backend loads them at startup in about 2 seconds.

---

## Backend: Heroku

Everything it needs is in the repo: `Procfile`, `.python-version`,
`requirements.txt`.

```bash
heroku create repurposekg-api            # pick your own name
heroku config:set GEMINI_API_KEY=...     # the key from your .env
heroku config:set GEMINI_MODEL=gemini-4-hydrogen
git push heroku main
```

Check it came up:

```bash
heroku logs --tail          # look for "ready in 2.0s: 13911 drugs ..."
curl https://<app>.herokuapp.com/api/health
```

**Push to deploy.** `git push heroku main` deploys. To deploy on a GitHub push
instead, connect the repo under *Deploy → GitHub* in the dashboard and enable
automatic deploys from `main`. Heroku is a second remote, so pushing to GitHub
alone does not deploy unless you turn that on.

Deploying a branch: `git push heroku ui-redesign:main`.

### After the frontend exists

Lock CORS to your Vercel domain, otherwise any site can call the API:

```bash
heroku config:set CORS_ORIGINS=https://<project>.vercel.app
```

It accepts a comma-separated list. Unset, it allows every origin.

---

## Frontend: Vercel

Import the GitHub repo, then in the project settings:

| Setting | Value |
|:-|:-|
| Root Directory | `web` |
| Framework | Next.js (detected) |
| `NEXT_PUBLIC_API_URL` | `https://<app>.herokuapp.com` |

Push to `main` and Vercel builds and deploys. Pull requests get their own
preview URL.

**`NEXT_PUBLIC_*` is baked in at build time, not read at runtime.** Changing
`NEXT_PUBLIC_API_URL` does nothing until you redeploy. If you leave it unset the
app runs on the offline snapshot in `web/src/lib/fixtures` and shows an "Offline
snapshot" badge, which is a reasonable fallback for a demo but only covers the
three example diseases.

---

## Things that will bite you

**The dyno sleeps.** Eco dynos sleep after 30 minutes idle, and the first
request afterwards pays the wake-up plus the 2-second artifact load. Before a
demo, open the API once to wake it. A Basic dyno does not sleep.

**The filesystem is temporary.** Heroku wipes the dyno's disk on every restart,
and it restarts at least daily. `cache/` goes with it, so structure lookups and
finished design runs are fetched again from PubChem, RCSB, AlphaFold and Gemini
after a restart. Nothing breaks; the first view of each is just slow again.

**One worker, one dyno.** The `Procfile` pins `--workers 1`, and it has to stay
that way. Each worker loads its own copy of the artifacts, and design jobs live
in that worker's memory, so a second one both doubles the memory and gives the
browser a chance to ask a process that has never heard of its job. The Python
buildpack sets `WEB_CONCURRENCY` from the available memory and will start two
workers if nothing overrides it, which is what crashed the first deploy. The
same applies to dynos: `heroku ps:scale web=1`.

**Design jobs live in memory.** A restart loses a run in progress and the job
id stops resolving.

**Memory.** The backend settles around 300 MB, rising to roughly 350 MB once a
design run has built its fingerprints, against 512 MB on Eco and Basic dynos.
That is comfortable but not roomy; `heroku logs` will show `Error R14` if it
starts swapping and `R15` if it is killed.

**Long requests.** Heroku closes a connection that has sent nothing for 55
seconds. The design stream sends a heartbeat every 15 seconds to stay under
that. The one-shot `/api/brief` call is slower than most requests but still well
inside the 30-second limit for a normal response.

**Secrets.** `.env` is gitignored and is not deployed. Every key has to be set
with `heroku config:set`. Without `GEMINI_API_KEY`, `/api/brief` and
`/api/design` return 503 and the rest of the app works.

**Slug size.** RDKit, SciPy and NumPy are large; the slug lands near 300 MB
against a 500 MB limit. Adding another heavy dependency is worth checking with
`heroku apps:info`.
