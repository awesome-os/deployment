# Awesome-OS Deployment (`awesome-os/deployment`)

Centralized, pinned, declarative multi-domain deployment & health-check controller for Awesome-OS web portals, netboot endpoints, and `v11` CAS mirrors.

## Target Audience Domain Map

| Domain | Target Audience | Role |
| :--- | :--- | :--- |
| **[`b8g.dev`](https://b8g.dev/) & [`b8g.dev/awesome-os/`](https://b8g.dev/awesome-os/)** | Developers & Systems Engineers | `holo-compiler`, `t2linux-baseline`, EmuKit, Host Manager CLI/API, GitLab Holo Forge, architecture docs |
| **[`b8g.app`](https://b8g.app/)** | End-Users → Power-Users | Workstation Hub (**Omarchy**, **Noctalia**, **ChonkStep**, **Sectium**, **GNOME**, **KDE**), Sectium Browser, Code-OSS, OBS Vertical, White Dragon VTuber Studio |
| **[`awesome-os.com`](https://awesome-os.com/) & [`/cloud/`](https://awesome-os.com/cloud/)** | Enterprise & Cloud Buyers | Sovereign Enterprise OS presentation, `/cloud/` commercial offers, interactive fleet ROI calculator, iPXE netboot |

## Usage

```powershell
# Verify HTTP 200 health across all 3 domains
node deploy.mts --verify

# Preview pinned SHA-256 deployment plan
node deploy.mts --dry-run

# Deploy all pinned assets and run live verification
node deploy.mts --apply
```

## Static CAS Edge Worker (`edge-cas-worker.mts` + `wrangler.toml`)

[`edge-cas-worker.mts`](edge-cas-worker.mts) provides a zero-dependency Web Standards Cloudflare Worker serving the Holo `v11` Static CAS from Cloudflare R2 (`HOLO_CAS_BUCKET`) with an automatic zero-token GitHub Pages CDN fallback (`https://awesome-os.github.io/holo-v11/cas/...` and `/v11/files/...`), eliminating unauthenticated 60 req/hr GitHub REST API rate limits for clean-box installers:

- `GET /cas/v11/index.json` & `GET /cas/v11/shards/<aa>.json` — served from R2 `HOLO_CAS_BUCKET`, falling back to `https://awesome-os.github.io/holo-v11/cas/v11/...`
- `GET /v11/files/<aa>/<sha512>` — strictly validates `^[0-9a-f]{2}$` and `^[0-9a-f]{128}$` and responds with `Cache-Control: public, max-age=31536000, immutable` and `X-Holo-CAS-Layout: v11`
- `GET /healthz` — returns `{ "ok": true, "abiMagic": "0x33564742", "casLayout": "v11" }`

```powershell
# Run edge CAS worker unit tests
node --test edge-cas-worker.test.mts

# Deploy Static CAS Edge Worker with pnx (never npx)
pnx wrangler deploy
```
