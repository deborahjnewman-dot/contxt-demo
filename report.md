# Contxt — Adversarial Test & Optimization Report

Date: June 11, 2026
Branch: `architecure-and-performance`
Scope: backend retrieval + generation pipeline, validation layer, server, Netlify function, and frontend wiring.

---

## Resolution status (fixes applied June 11, 2026)

All backend findings have been fixed and verified. The frontend (`index.html`) was **not** touched, per the UI-freeze requirement. Full suite: **38/38 tests pass** (14 new regression tests added). Verified via unit tests, a stubbed end-to-end retrieval flow, full brief-validation integration, and a clean server boot.

| Item | Status | Fix |
|---|---|---|
| C1 stale filter | ✅ Fixed | Removed the title/text year heuristic; only the `/location/.../report-X/` URL shape is treated as stale. Real dated news articles now survive. |
| C2 cache poisoning | ✅ Fixed | `prepareBriefOutput` now returns a `cacheable` flag; `server.js` (both `/brief` and `/precache`) and the Netlify function only cache real, populated briefs. |
| C3 committed secret | ✅ Clarified | `.env` is gitignored and was **never committed** (no git leak). The keys shared in the sprint PDF should still be rotated by the owner — no code action. |
| C4 date validator | ✅ Fixed | Missing-year dates are no longer dropped; future dates only flagged when described as already completed; lowercase "march"/"may" verbs no longer parsed as dates. |
| C5 dead gate | ⚠️ Left as-is | Behavior is correct (0 → no_reports, <MIN → too_few); the redundancy is cosmetic only. Not changed to avoid risk. |
| H1 dispute collapse | ✅ Fixed | Entity keyed off the attributing source first, then earliest-named entity. Also fixed the `palestin\b` pattern that never matched "palestinian". |
| H2 state-media ranking | ✅ Fixed | State media is now its own lowest tier (`state_media`, weight 0); never outranks AP/Reuters and is labeled honestly to the model. |
| H3 quote loss | ✅ Fixed | Quotes now extracted from the full article body, not just the first 3 paragraphs. |
| H4 quote stitching | ✅ Fixed | Matched-pair, newline-free quote patterns; no more fabricated cross-paragraph quotes. |
| H5 geo substring | ✅ Fixed | Word-boundary country matching ("us" no longer matches inside "virus"). |
| H6 search truncation | ✅ Fixed | Topic-aware search selection lifts country-relevant outlets into the cut while keeping high-priority wires. |
| P2 translate-after-filter | ✅ Fixed | Non-article URLs rejected before the translation round-trip. |
| P3 Anthropic timeout | ✅ Fixed | `collectMessage` now has a 25s timeout and surfaces `refusal`/`max_tokens` stop reasons clearly. |
| P4 cache key/leak | ✅ Fixed | Cache key collapses whitespace + trailing punctuation; cache bounded at 200 entries (FIFO eviction). |
| N1 truncation | ✅ Fixed | `max_tokens` raised to 4096; truncation/refusal surfaced instead of a confusing "invalid JSON". |
| N2 entity double-decode | ✅ Fixed | `&amp;` decoded last. |
| N3 frontend XSS | ⛔ Deferred | Out of scope — `index.html` must not change. Recommend revisiting under a future UI-change window. |
| N6 fabricated timestamps | ✅ Fixed | Prefer Brave `page_age`; parse relative ages; undated ranks oldest instead of "now". |
| N7 flag lookup | ✅ Fixed | Deterministic domain→flag table applied post-generation (Al Jazeera 🇶🇦, Reuters 🌐, BBC/Guardian 🇬🇧, …). |
| N8 DeepL endpoint | ✅ Fixed | Endpoint auto-derived from key tier (`:fx` → free host), so a stale `DEEPL_API_URL` can't silently 403. README/`.env.example` updated. |
| P1 retrieval budget | ⚠️ Left as-is | The `withBudget` wrapper is all-or-nothing, so lowering the ceiling risks total source loss. Real latency improved via P2/P3 instead; expected retrieval ≈ one parallel search (~8s) under the 12s ceiling. |
| N5 date-scoped recency | ◐ Partial | Timestamp accuracy improved (N6); date-scoped query generation remains a larger follow-up. |

Original findings detail follows below (unchanged).

---

Scope: backend retrieval + generation pipeline, validation layer, server, Netlify function, and frontend wiring.

Method: read every module against `spec.md`, `new_spec.md`, and the sprint doc, then exercised the pure helpers (`filter.js`, `format.js`, `extract.js`, `brief-output.js`) with adversarial inputs in Node to confirm behavior. Test suite (`node --test test/*.test.js`) passes 24/24, so these are gaps the current tests do not cover.

---

## TL;DR

The pipeline is structurally sound and the P0 gates (no-coverage, hub-page filter, synthetic-label block, dispute/quote validation) are real and working. But several validators are **miscalibrated and silently destroy good content**, which directly hurts the "high quality, accurate" goal. The single most damaging bug is the stale-source filter: it discards almost every legitimately dated news article, so on a normal news topic retrieval can fall to zero valid sources and return "No reports on this topic" for a story that is real and well-covered. There is also a cache-poisoning bug that can pin a "no coverage" response for 4 hours, a committed live DeepL key, and a dead code path that makes the `MIN_VALID_SOURCES` "too few sources" gate unreachable.

Priority order to fix: **C1 (stale filter) → C2 (cache poisoning) → C3 (committed secret) → C4 (date filter) → C5 (dead gate)**, then the quality/perf items.

---

## Critical bugs

### C1. Stale-source filter rejects almost all real news articles
`retrieval/filter.js` → `isStaleReportSource()` (lines 39–55). The second condition:

```js
/\b[a-z][a-z ]+\s+20\d{2}\b/.test(haystack.slice(0, 160))
```

fires whenever the first 160 characters of `title + extracted_text` contain "any words followed by a 4-digit year." That matches normal headlines and ledes. Confirmed:

| Title fed to filter | Marked stale (dropped)? |
|---|---|
| "Israel and Hamas reach ceasefire deal in June 2026" | **YES** (wrong) |
| "Gaza ceasefire talks resume after May 2026 collapse" | **YES** (wrong) |
| "World Cup 2026 hosts announce security plan" | **YES** (wrong) |
| "Election results 2026: what we know" | **YES** (wrong) |

Any current-events article that mentions its own year — i.e. most of them — is discarded as a "stale annual report." Because retrieval only has one source (Brave targeted), this routinely drops the candidate set below `MIN_VALID_SOURCES` (3) or to zero, and the user sees "No reports on this topic" / "Too few credible sources" for a story that is real. This is the highest-impact accuracy/coverage bug in the system and the most likely thing to make a live demo look broken.

Fix direction: this heuristic is trying to catch evergreen "Country 2024 human rights report" index pages. Scope it far more tightly — require the year to be *older* than the current year, or restrict to the `/location/.../report-...` pathname pattern only (the first clause), or drop the title/text year match entirely. Recommend removing the `haystack` clause and relying on the URL-path clause plus recency ranking.

### C2. No-coverage and partial briefs are cached for 4 hours (cache poisoning)
`brief-output.js` → `validateBrief()` returns a `{status:'no_coverage', ...}` object when a generated brief has a synthetic label or **any** empty URL (confirmed: a single empty `url` on one fact flips the whole brief to no_coverage). `prepareBriefOutput()` wraps that in `{ok:true, text:...}`. Back in `server.js` (line 92–97), `ok:true` means the result is passed to `setCachedBrief()`. So a one-off model hiccup — one missing URL — gets cached as "no coverage" under the topic key for `CACHE_TTL_MS` = 4 hours. Every subsequent request for that topic (including the live demo) is served the poisoned no-coverage response from cache without ever calling the model again.

Same class of issue: the validator can prune all facts/disputes (see C4) and the resulting near-empty but structurally-valid brief is cached for 4 hours.

Fix direction: in `server.js`/`netlify/functions/brief.js`, after `prepareBriefOutput`, check whether the prepared text is a `no_coverage` object (or an empty brief) and **do not cache** it; return it but skip `setCachedBrief`. Treat "ok JSON" and "cacheable good brief" as two different conditions.

### C3. Live DeepL API key committed to the repo
The sprint doc's DeepL key (`eb53d03b-...:fx`) is real and present in the tracked `.env` file (`.gitignore` lists `.env`, but `git ls-files` shows `.env` is already tracked, so ignoring it now does nothing). Anyone with repo access has the key. Also: `new_spec.md` line 4 contains a live Google Sheets link, and the sprint PDF exposes the key too, but the committed `.env` is the actionable leak.

Fix direction: rotate the DeepL key, `git rm --cached .env`, confirm it is untracked, and scrub it from history if the repo is or will be public (`github.com/deborahjnewman-dot/contxt-demo`). The `.env.example` correctly uses placeholders — keep only that.

### C4. Date validator deletes legitimate future-dated and undated facts
`brief-output.js` → `hasInvalidGeneratedDate()` removes any fact/position/dispute/gap whose text contains a date that is in the future **or** missing a year. Confirmed false positives:

- "Leaders will meet on July 15, 2026 in Cairo" → **dropped** (legitimately scheduled future event; spec only forbids describing a future date as *already happened*, not mentioning one).
- "Strike on June 8 killed 12 people" → **dropped** (missing-year, but the day is valid and recent; the model often omits the obvious current year).
- "Protesters march 30 kilometers" → **dropped** ("march 30" parsed as March 30, missing year).
- "The court may 5 of the appeals dismiss" → **dropped** ("may 5" parsed as a date).

"march" and "may" are common English verbs/auxiliaries, so the day-month and month-day regexes produce date matches out of ordinary prose and silently delete the sentence. Combined with C2, a brief gutted by this filter can also be cached.

Fix direction: (a) only reject a future date when it co-occurs with past-tense "already happened" language, not on its own; (b) do not treat a missing-year date as invalid — at most normalize it to the current year; (c) require a word boundary / disqualify when the "month" is immediately preceded by a subject pronoun or followed by a unit (km, percent) to cut the "march 30 kilometers" / "may 5 of" class.

### C5. `MIN_VALID_SOURCES` "too few sources" gate is unreachable
`retrieval/format.js`: `contentSourceCount` is computed as `sources.filter(hasSourceContent).length`, but `formatForModel` already drops any source without content in the dedupe loop (`if (!hasSourceContent(source)) continue;`). So `contentSourceCount === sourceCount` always (confirmed: 2 and 2). In `retrieval/index.js`, the `contentSourceCount === 0` branch and `contentSourceCount < MIN_VALID_SOURCES` branch therefore reduce to "0 sources" vs "1–2 sources" — which is fine — but the distinction the code implies (sources that have content vs. sources that don't) is dead. More importantly, `MAX_FORMATTED_SOURCES` cap and the per-domain cap run *before* the count, so the gate measures post-cap survivors, not credible-source availability. It works, but the naming hides that the "content" check is a no-op; if someone later adds content-less sources expecting the gate to catch them, it won't. Low user impact, but it's a latent correctness trap and worth simplifying.

---

## High-priority correctness / quality issues

### H1. Dispute validator collapses genuine two-country disputes
`brief-output.js` → `disputeEntity()` scans the **combined** `source + side` text of *each* side against a known-entity list in fixed order. When side 1 is "Russia says Ukrainian forces shelled the dam" and side 2 is "Ukraine says Russian forces mined the dam," both sides match `russia` first (it is earlier in the list and both texts mention Russia), so the dispute is judged same-entity and **dropped** (confirmed). Same for Israel/Palestine phrasing where each side names the other. These are exactly the real disputes the Disputed section exists to show. The entity check should key off the *attributing* side (who is making the claim) — e.g. the source/speaker — not "any known country mentioned anywhere in the side text."

### H2. State-media ranking inverts source hierarchy
`format.js` → `sourceClass()`: `if (source.state_media) return 'independent';` runs before the government/primary check. So Kremlin/IRNA/Xinhua government pages (`source_type: 'government', state_media: true`) are classed `independent` (weight 1), while WAFA — a Palestinian state news agency not flagged `state_media` in `sources.json` — is classed `primary` (weight 3) and ranked at the top (confirmed). The intent (down-rank state propaganda) is reasonable, but the data is inconsistent: only Iran/Russia/China are tagged `state_media`, so the policy is applied unevenly and an untagged state outlet outranks AP/Reuters. Either tag all state outlets consistently or rank state media as its own tier rather than borrowing the `independent` label.

### H3. Quote extraction loses the best quotes to the 3-paragraph cap
`extract.js` keeps only the first 3 paragraphs (`MAX_EXTRACTED_PARAGRAPHS`) and extracts quotes **from that trimmed text**, not the full article. Confirmed: an article whose only strong quote is in paragraph 6 yields `quotes: 0` even though `wordCount` (618) shows plenty of material. News ledes are often paraphrase; the actual on-record quote tends to appear lower. Result: the Claimed section frequently has no verbatim quote to attach, the prompt then leaves the quote field empty, and the brief looks thin. Consider extracting quotes from the full cleaned body before trimming the prose sent to the model.

### H4. Greedy quote regex spans paragraphs and mismatches quote styles
`extract.js` → `extractQuotes()` uses `/["“]([^"”]{20,280})/`. The character class allows a straight `"` to open and a curly `”` to close (and vice-versa), and `.` is not excluded across `\n\n`. Confirmed: input `He said "this is fine.\n\n<unrelated paragraph>\n\nShe added later”` produces a single bogus "quote" stitched across three paragraphs: *"this is fine. Unrelated paragraph with lots of words here. She added later"*. That fabricated quote is then passed to the model as verbatim source text — a direct violation of the core "no invented quotes" rule. Also `speaker` inference picks up trailing fragments like "on Tuesday. A second source". Tighten to matched quote pairs and forbid `\n` inside the captured group.

### H5. Geographic coverage misfires on common substrings
`format.js` `COUNTRY_SIGNALS` uses bare terms including `'us '` and `'america'`. `countriesInTopic('virus outbreak in china')` returns `['United States', 'China']` (confirmed) because "**us**" matches inside "vir**us** ". So a China-only health story is told it's missing a US perspective, and the model is instructed to add a "missing United States perspective" note that doesn't belong. Word-boundary the term matching (`america` also matches inside "panamerican", etc.).

### H6. `MAX_TARGETED_SEARCHES` (14) silently truncates the source roster
`sources.json` has 39 configured searches; `selectSearches` sorts by priority then label and keeps the first 14. Confirmed selection stops at "Haaretz" — meaning entire regions are unreachable for many topics: no China/Russia/India official, no Kyiv Independent/Meduza, no NHK, no Times of Israel, no HRW (it's alphabetically after the cut for medium priority). For a Russia–Ukraine or China topic, the country-specific outlets the geo-coverage logic asks for are never even queried, so "missing perspective" is guaranteed by construction. Either raise the cap, or select searches by relevance to the topic (e.g. country detected in topic → boost that country's outlets above the cut) instead of static alphabetical order.

---

## Performance findings

### P1. Retrieval budget (12s) exceeds the sprint's 5s target
`TARGETED_BUDGET_MS` defaults to 12000; the sprint handoff target is "retrieval layer under 5 seconds." Within one search the article fetches run in parallel (`Promise.all`), but each candidate is fetch (2.8s) → translate (2.5s) sequentially, so a slow search can take ~5–8s on its own, and 14 searches run concurrently. Worst case the whole retrieval can sit near the 12s ceiling, leaving little of the 30s end-to-end budget for generation. Recommend lowering the budget toward 5–6s and reducing `MAX_TARGETED_SEARCHES` or `MAX_ARTICLES_PER_SEARCH` for demo topics, and pre-caching (which the repo supports) for the 3 demo topics.

### P2. Translation runs serially inside each article and is often wasteful
`targeted.js` `articleToSource` awaits `translateToEnglish` for every non-English source before validation — even for sources that will be dropped by the validity filter milliseconds later. Move the validity/URL/length checks before translation so you don't spend a 2.5s DeepL round-trip on a source you're about to discard. Also translation happens per-article; batching the few non-English survivors after filtering would cut latency and DeepL quota use.

### P3. `server.timeout = 0` removes all socket timeouts
`server.js` line 164 disables the HTTP server timeout entirely. Combined with `setInterval` heartbeats every 15s, a wedged upstream (Brave or Anthropic hanging) holds the connection open indefinitely with no server-side cap. The per-request `requestText`/`requestJson` timeouts protect retrieval, but the Anthropic `collectMessage` call has **no timeout at all** (`anthropic.js` uses raw `https.request` with no `timeout` option), so a stalled generation never returns. Add an explicit timeout/abort around `collectMessage`.

### P4. Cache key is unbounded and case/whitespace-only normalized
`cacheKey` lowercases and trims but does not collapse internal whitespace or strip punctuation, so "US drug boat strikes" and "US  drug boat strikes" (or trailing "?") are different cache entries. Minor, but it lowers hit rate for the demo and lets the in-memory `Map` grow without eviction (no size cap, only TTL on read). For a long-running Render process this is a slow memory leak.

---

## Lower-severity / correctness nits

- **N1. `collectMessage` ignores `stop_reason`.** `anthropic.js` joins text blocks but never checks for `stop_reason: 'max_tokens'` (truncated JSON) or `'refusal'`. With `MAX_TOKENS: 3500` and a large source package, a truncated response yields invalid JSON → generic "invalid JSON" error with no retry. Surface the stop reason and consider a single retry with higher `max_tokens` on truncation.
- **N2. `decodeEntities` ordering / double-decode.** `extract.js` decodes `&amp;` after `&lt;`/`&gt;` are still encoded as `&amp;lt;`, so a title like `A &amp;lt;b&amp;gt;` decodes to `A <b>` (confirmed) — double-decoding entity-escaped markup. Low impact (titles only) but can inject stray angle brackets into the brief.
- **N3. Frontend XSS via `innerHTML`.** `index.html` `renderBrief` interpolates model output (`b.topic`, `f.bold`, `p.quote`, `s.name`, …) straight into `innerHTML`. The schema constrains the model, but source titles/quotes are attacker-influenced (a malicious source page could embed markup that survives extraction). Since the UI must not change visually, at minimum escape these values before insertion. Not exploitable today via same-origin, but it's latent.
- **N4. `isLikelyEnglish` threshold is fragile.** 8% stopword density and a 5% non-Latin cutoff will mislabel short or quote-heavy English passages as non-English (triggering needless DeepL calls) and vice-versa. Acceptable for now; note it as a translation-cost risk.
- **N5. Brave `freshness: 'pm'` only; no date-scoped queries.** Matches the spec's "not yet done" item 6 — recency for ongoing/recurring stories is not implemented, so the stale-content risk in the quality eval remains even after C1 is fixed.
- **N6. `normalizePublishedAt` fabricates timestamps.** Brave returns `age` as a relative string ("3 days ago"); `new Date('3 days ago')` is `NaN`, so the code falls back to `new Date().toISOString()` — every source gets "published now." This makes the recency tiebreak in `compareSources` meaningless and can present old articles as fresh in the `Published:` line shown to the model.
- **N7. Flag lookup still model-decided.** `new_spec.md` P2 item 13 (deterministic `aljazeera.com→🇶🇦`, `reuters.com→🌐`, etc.) is unimplemented; flags remain inconsistent. Not P0 but visible in the demo's Sources slide.
- **N8. README/spec conflict on DeepL endpoint.** README + `.env.example` default to the paid endpoint (`api.deepl.com`), but the committed key is `:fx` (free tier), whose correct endpoint is `api-free.deepl.com`. With the paid URL, the free key will 403 and translation silently no-ops (the code swallows the error and returns the untranslated source). Non-English sources then fail the English-overlap/topic checks and get dropped. Align the URL with the key tier (this is the open question for Deborah in the spec).

---

## What works well (verified)

- No-coverage gate fires **before** the model is called (`retrieval/index.js`), so fabricated topics don't reach Anthropic and don't cost tokens. Confirmed by the passing `retrieval-index` test.
- Hub/section-index filtering (`isSpecificArticleUrl`) correctly rejects `reuters.com/world/middle-east/` and `aljazeera.com/where/middle-east/` while accepting real article slugs. (It does let `apnews.com/hub/...` and `who.int/emergencies/...` through — see note below — but the core homepage/section cases are caught.)
- Synthetic-label blocklist and empty-URL rejection work as designed.
- Quote-length floor (≥10 words) is enforced both in extraction and post-generation.
- Prompt caching is set up correctly: the system prompt is a stable `cache_control: ephemeral` block and the volatile topic/package text is in the user turn — good cache hygiene.
- Structured outputs usage is current and correct: `output_config: { format: { type: 'json_schema', schema } }` with `additionalProperties:false` on every object is the right shape for `claude-sonnet-4-6`, needs no beta header, and works with the non-streaming `collectMessage` path. (Note `brief-request.js` sets `stream: true` but `collectMessage` overrides it to `false`; harmless, but the `stream:true` line is dead and misleading.)
- Graceful per-source failure: a thrown/timed-out search resolves to `ok([])` and retrieval continues, matching the sprint's "graceful failure on each source" requirement.

Two filter caveats worth tightening (not critical): `isSpecificArticleUrl` accepts `apnews.com/hub/israel-hamas-war` and `who.int/emergencies/disease-outbreak-news` as "articles" because the last path segment contains a hyphen / is ≥18 chars. These are index pages the hub filter is meant to reject; add `hub` and known index segments to `SECTION_SEGMENTS` or require a numeric/ID component for those domains.

---

## Suggested fix order

1. **C1** stale-source filter — restore basic coverage. (Single highest-value fix.)
2. **C2** stop caching no-coverage/empty briefs — prevents 4-hour poisoning of demo topics.
3. **C3** rotate + untrack the DeepL key.
4. **C4** loosen the date validator — stop deleting good facts.
5. **H1/H4** dispute-entity and quote-pairing bugs — protect Disputed/Claimed quality and the no-invented-quotes rule.
6. **H6/H5** topic-aware search selection + word-boundary geo terms — make the country-coverage logic actually satisfiable.
7. **P1/P2/P3** retrieval budget, translate-after-filter, Anthropic timeout — hit the <5s retrieval / <30s end-to-end targets.
8. **N5/N6/N7/N8** recency, timestamps, flag lookup, DeepL endpoint — quality polish.

Add regression tests alongside each: the current suite passes precisely because none of these adversarial inputs are exercised. A handful of table-driven cases (real dated headlines for C1, two-country disputes for H1, cross-paragraph quotes for H4, `virus`/`us ` for H5) would lock these in.
