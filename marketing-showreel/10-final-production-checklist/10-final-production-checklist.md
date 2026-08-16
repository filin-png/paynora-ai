# Stage 10 — Final Production Checklist

## Assets ready now
- [x] 9 real Paynora screenshots, 1440×900, clean UI, no secrets/errors/debug overlays (`03-screenshots/paynora/`)
- [x] Full technical analysis of both codebases, verified against source (`01-project-analysis/`)
- [x] Selected screens with rationale (`02-selected-screens/`)
- [x] Second-by-second storyboard, 40s main cut (`04-storyboard/`)
- [x] Per-scene AI video generation prompts + negatives (`05-video-prompts/`)
- [x] Russian ad copy — main + 20s condensed + final CTA (`06-copy/`)
- [x] Music/sound design brief (`07-music-sound/`)
- [x] Editing guide with export specs (`08-editing-guide/`)
- [x] 20-second condensed storyboard (`09-20sec-version/`)

## Requires manual action from you
- [ ] **Generate the 14 video clips** using the prompts in `05-video-prompts/` against Kling / PixVerse (or your preferred generator) — this session cannot call external paid video-generation APIs.
- [ ] **License or produce the music track** per `07-music-sound/` (stock library search, or commission/generate one matching the brief).
- [ ] **Assemble the final cut** in an editor (DaVinci Resolve / Premiere / CapCut) following `08-editing-guide/` — text overlay, color grade, SFX sync, export.
- [ ] **Decide on Nexora screens:** either (a) ship the ad using the stylized AI-recreated Nexora scenes as designed (clearly a creative/brand-style recreation, not a claim of literal screenshots), or (b) if you want real Nexora screenshots, spin up a free Supabase project and run the 3 migration files (see `03-screenshots/README.md`) and this same Playwright approach can capture them — ask and this can be done in a follow-up session.
- [ ] **Confirm the CTA contact details** (`06-copy/` §4) are still current before publishing.
- [ ] **Review the flagged suspicious tool-output string** noted in the final report before trusting any future automated `npm install` runs in this environment without a fresh look (see final report — not a repository issue, an environment/tooling anomaly).

## Not done, and correctly so, per your instructions
- No production code in either repository was modified.
- No pull request was opened.
- No feature was implemented in Paynora or Nexora.
- Nothing was fabricated: Nexora screenshots were not created — the blocker is documented instead.
