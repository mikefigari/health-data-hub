-- Migration 02: nutrition_goals (PLAN.md D5), nutrition_day_status, and
-- nutrition_daily becomes a VIEW over food_log + the frozen legacy table (D2).
-- Readers of nutrition_daily see the same column names, order and types.

DO $$
BEGIN
    IF to_regclass('public.schema_migrations') IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM public.schema_migrations
                    WHERE name = '2026-11_02_nutrition_daily_view') THEN
            RAISE EXCEPTION 'migration 2026-11_02_nutrition_daily_view already applied';
        END IF;
    END IF;
END $$;

-- ------------------------------------------------------------
-- Goals (D5): goal_calories = base_calories + cycling_kj_factor * powered Ride kJ.
-- No Oura input.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.nutrition_goals (
    effective_from     DATE PRIMARY KEY,
    target_weight_kg   NUMERIC(5,1) CHECK (target_weight_kg BETWEEN 30 AND 300),
    base_calories      INT NOT NULL CHECK (base_calories BETWEEN 800 AND 6000),
    cycling_kj_factor  NUMERIC(3,2) NOT NULL DEFAULT 1.00 CHECK (cycling_kj_factor BETWEEN 0 AND 1.50),
    protein_g          NUMERIC(6,1) CHECK (protein_g BETWEEN 0 AND 500),
    notes              TEXT CHECK (length(notes) <= 500),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO public.nutrition_goals
       (effective_from, target_weight_kg, base_calories, cycling_kj_factor, protein_g, notes)
VALUES ('2026-10-25', 100.0, 2620, 1.00, 180,
        'Seed (PLAN.md D5): 100 kg target; goal = base + powered Ride kJ')
ON CONFLICT (effective_from) DO NOTHING;

-- ------------------------------------------------------------
-- Per-day "I am done logging" flag; feeds nutrition_daily.logged_complete
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.nutrition_day_status (
    day              DATE PRIMARY KEY,
    logged_complete  BOOLEAN NOT NULL,
    note             TEXT CHECK (length(note) <= 300),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE OR REPLACE TRIGGER nutrition_day_status_touch BEFORE UPDATE ON public.nutrition_day_status
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ------------------------------------------------------------
-- Freeze the historical table under a new name
-- ------------------------------------------------------------
ALTER TABLE public.nutrition_daily RENAME TO nutrition_daily_legacy;
ALTER INDEX public.nutrition_daily_pkey RENAME TO nutrition_daily_legacy_pkey;
COMMENT ON TABLE public.nutrition_daily_legacy IS
    'Frozen: MFP (2025-12..2026-03) and Apple Health (2026-03..2026-10) daily totals. New days come from food_log via VIEW nutrition_daily.';

-- ------------------------------------------------------------
-- Same name, same columns, same order, same types as the old table.
-- A day with any live food_log row returns food_log totals; otherwise the
-- legacy row. Never both.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.nutrition_daily AS
WITH meals AS (
    SELECT day,
           jsonb_object_agg(CASE meal WHEN 'snack' THEN 'snacks' ELSE meal END,   -- MFP key shape
                            jsonb_build_object('calories',  round(cal, 1),
                                               'protein_g', round(p, 1),
                                               'carbs_g',   round(c, 1),
                                               'fat_g',     round(f, 1))) AS meals_json
    FROM (SELECT day, meal, sum(calories) AS cal, sum(protein_g) AS p,
                 sum(carbs_g) AS c, sum(fat_g) AS f
            FROM public.food_log
           WHERE deleted_at IS NULL
           GROUP BY day, meal) m
    GROUP BY day
),
rides AS (
    SELECT start_time::date AS day, sum(kj) AS kj
      FROM public.workout_summary
     WHERE sport_type = 'Ride' AND device_watts AND kj > 0
     GROUP BY start_time::date
)
SELECT
    fl.day,
    fl.calories,
    fl.protein_g, fl.carbs_g, fl.fat_g, fl.fiber_g, fl.sugar_g, fl.sodium_mg,
    (g.base_calories
       + round(g.cycling_kj_factor * coalesce(r.kj, 0)::numeric)::int
    )::int                                  AS goal_calories,
    g.protein_g::double precision           AS goal_protein_g,
    NULL::double precision                  AS goal_carbs_g,
    NULL::double precision                  AS goal_fat_g,
    m.meals_json,
    'food_log'::text                        AS source,
    s.logged_complete,
    NULL::numeric(5,2)                      AS weight_kg,
    fl.created_at,
    fl.updated_at
FROM public.food_log_daily fl
LEFT JOIN meals m                       ON m.day = fl.day
LEFT JOIN rides r                       ON r.day = fl.day
LEFT JOIN public.nutrition_day_status s ON s.day = fl.day
LEFT JOIN LATERAL (
    SELECT g0.base_calories, g0.cycling_kj_factor, g0.protein_g
      FROM public.nutrition_goals g0
     WHERE g0.effective_from <= fl.day
     ORDER BY g0.effective_from DESC
     LIMIT 1
) g ON true
UNION ALL
SELECT l.day, l.calories, l.protein_g, l.carbs_g, l.fat_g, l.fiber_g, l.sugar_g, l.sodium_mg,
       l.goal_calories, l.goal_protein_g, l.goal_carbs_g, l.goal_fat_g,
       l.meals_json, l.source, l.logged_complete, l.weight_kg, l.created_at, l.updated_at
FROM public.nutrition_daily_legacy l
WHERE NOT EXISTS (SELECT 1 FROM public.food_log f
                   WHERE f.day = l.day AND f.deleted_at IS NULL);

-- nutrition_writer: day status upserts, goal and view reads. No legacy access.
-- claude_readonly gets SELECT on the new tables/view via its default privileges;
-- the renamed legacy table keeps its existing grants.
GRANT SELECT, INSERT, UPDATE ON public.nutrition_day_status TO nutrition_writer;
GRANT SELECT ON public.nutrition_goals TO nutrition_writer;
GRANT SELECT ON public.nutrition_daily TO nutrition_writer;

INSERT INTO public.schema_migrations (name) VALUES ('2026-11_02_nutrition_daily_view')
ON CONFLICT DO NOTHING;
