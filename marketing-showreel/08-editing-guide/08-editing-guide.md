# Stage 8 (continued) — Editing Guide

## Assembly order
1. Generate/collect the 14 scene clips per `05-video-prompts/05-video-prompts.md` (scenes 3, 8, 12, 13, 14 can be built directly as background plates in the editor rather than through an AI generator).
2. Rough-assemble in the exact order and durations from `04-storyboard/04-storyboard.md` — cut on the transition column, not by eye.
3. Add on-screen text as a separate overlay layer (never baked into the AI generation for text-bearing scenes) so wording can be tweaked without regenerating video.
4. Add music per `07-music-sound/07-music-sound.md`, sync the flagged SFX hits to their exact scene-in points (Action Center "Approve" push-in, CTA hit) before doing anything else — those two moments carry the ad.
5. Color grade last, once cuts are locked (see below).

## Text/typography
- Minimal sans-serif, medium/semibold weight, generous tracking on all-caps labels (matches both products' own type systems).
- Keep every on-screen line short enough to read in under half its scene duration — the brief requires the ad to work muted, so nothing should require lingering.
- Safe area: keep all text within the center 80% width and avoid the bottom ~12% / top ~8% of frame (platform UI overlays on Reels/TikTok/Shorts).

## Color grading
- Paynora block (scenes 4–7): cool graphite/indigo, slightly desaturated, matches the product's real dark UI.
- Nexora block (scenes 9–11): warm-black base, bronze highlights, violet only where AI is explicitly present — mirror the product's own documented color rule (bronze = product, violet = AI), don't mix them decoratively.
- Transitions (scenes 3, 8): the grade shifts from cool to warm across this pair — use it as the visual hinge of the whole piece.
- CTA (scene 14): neutral, restrained, single accent — deliberately distinct from both product palettes since this frame is about the developer, not either product.

## Technical export specs
- **Resolution:** 1080×1920 (9:16), up to 4K source if the generators support it, downscale on export.
- **Frame rate:** 30fps (24fps acceptable if all source clips are natively 24fps — don't mix rates).
- **Codec/container:** H.264 in MP4 for broad platform compatibility; keep a ProRes/lossless master separately if further edits are expected.
- **Audio:** stereo, -14 LUFS integrated loudness (standard for social platforms — Reels/TikTok/Shorts all normalize around this).
- **Captions:** burn in the on-screen text as designed (it's the primary message channel), but also consider an accessibility caption track for any voiceover version.

## Screenshot handling reminder
The Paynora screenshots in `03-screenshots/paynora/` are real captured UI at 1440×900 (4:3-ish landscape). When compositing into a 9:16 frame (scenes 4–7), keep the screenshot un-stretched — scale it to fit within a floating "device/display" panel and fill the surrounding vertical space with the generated environment, never stretch or crop into the UI content itself.
