# Logging food through Claude

Tell Claude what you ate (text or photo). Claude looks up favorites, estimates
the nutrients, shows you a table, and writes to `food_log` only after you agree.

Goal: reach a 100 kg body weight. Calories burned count only from cycling with
tracked watts and kJ; Oura is not used for calories.

## The confirm-first flow

1. You: "Breakfast was my usual oatmeal and two scrambled eggs."
2. Claude calls `search_foods` for each distinct food (name only, no quantities).
3. Claude calls `log_food` **without** `confirm` (default `false`). The server
   validates, computes nutrients and returns the would-be rows plus projected
   day totals. **Nothing is written.**
4. Claude shows a compact table: item, amount, kcal, P/C/F, confidence and
   source, plus the projected day total against the goal.
5. You say "yes", or correct it ("make it 3 eggs", "drop the coffee").
6. Only after you agree, Claude calls `log_food` again with `confirm: true`
   (and a `request_id` UUID so a retry cannot double-log).
7. Claude reports the logged rows and the day's running total.

This is a convention carried by the tool description and server instructions,
not a token the server enforces.

## Text

Say what and roughly how much. Retroactive entries work: "Yesterday's dinner
was ..." gives a `day` and `meal`; the server uses 19:00 Los Angeles time.
Backfill beyond the normal window needs `allow_backfill`.

## Photo

Claude identifies the items and estimates portions from visual cues. Photo
items are at most `med` and usually `low` confidence, and Claude says so. It
still shows the table and waits for your agreement.

## Corrections

"Actually that was 3 eggs." Claude calls `get_day_summary` to find the entry id
(if it does not have it), shows the change, and on your agreement calls
`update_log_entry` with the patch (for example `{grams: 183}`); the server
recomputes. "Remove the coffee" uses `delete_log_entry`; it is a soft delete,
and `restore: true` brings it back. Say "that is everything for today" to call
`mark_day_complete`.

## Favorites

When the same estimated item shows up repeatedly (for example a third time),
Claude offers "Save 'Starbucks oat latte grande' as a favorite?" and calls
`save_favorite` with `from_log_id`. Favorites that match exactly are used
as-is with `high` confidence.

## Confidence rubric

- **high**: a favorite, or a weighed item or packaged label.
- **med**: a reference match with a portion stated in standard units.
- **low**: a photo, a vague portion, a restaurant guess or a mixed dish.

Claude never presents an estimate as exact.

## Day summary

`get_day_summary` returns items with ids (ordered by time), totals, goals,
`cycling_kcal`, the latest body weight and its day, and `kg_to_target`.
`goal_calories = base_calories + cycling_kcal`. A ride's day is the Los Angeles
date of its UTC start time. Days with no logged rows still show goals.

## If something looks wrong

Say so; Claude can update or delete entries. Operators can turn writes off with
`WRITE_TOOLS_ENABLED=false` (see `docs/nutrition_deploy_runbook.md`).
