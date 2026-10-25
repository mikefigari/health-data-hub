-- Synthetic legacy nutrition_daily rows for the T8 view tests (no real health data).
-- Loaded into the baseline table public.nutrition_daily before migration 02. The
-- tests rewrite the target to public.nutrition_daily_legacy for installs that
-- already have the view, so keep exactly one "public.nutrition_daily (" below.
--
-- Covers: myfitnesspal rows with meals_json and goals, apple_health rows with
-- totals only, all-NULL apple_health rows, a non-NULL numeric(5,2) weight_kg,
-- a NULL updated_at, and doubles that do not round-trip as short decimals.
INSERT INTO public.nutrition_daily (
    day, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg,
    goal_calories, goal_protein_g, goal_carbs_g, goal_fat_g,
    meals_json, source, logged_complete, weight_kg, created_at, updated_at
) VALUES
    ('2025-12-10', 2150, 160.5, 210.25, 70.1, 28.0, 45.5, 2300.0,
     2300, 173, 230, 77,
     '{"breakfast": {"calories": 520, "protein_g": 35.0, "carbs_g": 60.0, "fat_g": 14.0},
       "lunch":     {"calories": 640, "protein_g": 48.5, "carbs_g": 55.25, "fat_g": 22.1},
       "dinner":    {"calories": 810, "protein_g": 70.0, "carbs_g": 75.0, "fat_g": 30.0},
       "snacks":    {"calories": 180, "protein_g": 7.0, "carbs_g": 20.0, "fat_g": 4.0}}',
     'myfitnesspal', true, NULL, '2025-12-11 06:00:00+00', '2025-12-11 06:00:00+00'),
    ('2025-12-11', 1890, 142.0, 199.9, 61.3, 22.5, 38.0, 1980.5,
     2300, 173, 230, 77,
     '{"breakfast": {"calories": 450, "protein_g": 30.0, "carbs_g": 55.0, "fat_g": 12.0},
       "dinner":    {"calories": 1440, "protein_g": 112.0, "carbs_g": 144.9, "fat_g": 49.3}}',
     'myfitnesspal', false, NULL, '2025-12-12 06:00:00+00', '2025-12-12 07:30:00+00'),
    ('2026-01-15', 2100, 155.0, 205.0, 68.0, 30.0, 40.0, 2200.0,
     2300, 173, 230, 77,
     '{"breakfast": {"calories": 600, "protein_g": 40.0, "carbs_g": 70.0, "fat_g": 15.0},
       "lunch":     {"calories": 700, "protein_g": 55.0, "carbs_g": 65.0, "fat_g": 25.0},
       "dinner":    {"calories": 800, "protein_g": 60.0, "carbs_g": 70.0, "fat_g": 28.0}}',
     'myfitnesspal', true, NULL, '2026-01-16 06:00:00+00', NULL),
    ('2026-02-01', 2405, 170.3, 240.0, 80.8, 31.2, 50.0, 2450.0,
     2300, 173, 230, 77,
     '{"lunch": {"calories": 2405, "protein_g": 170.3, "carbs_g": 240.0, "fat_g": 80.8}}',
     'myfitnesspal', true, 98.40, '2026-02-02 06:00:00+00', '2026-02-02 06:00:00+00'),
    ('2026-03-01', 1750, 120.0, 180.0, 55.0, NULL, NULL, NULL,
     2300, 173, 230, 77,
     NULL,
     'myfitnesspal', NULL, NULL, '2026-03-02 06:00:00+00', '2026-03-02 06:00:00+00'),
    ('2026-03-20', 1980, 150.2, 190.7, 66.6, 25.0, 42.0, 2100.0,
     NULL, NULL, NULL, NULL,
     NULL,
     'apple_health', NULL, NULL, '2026-03-21 05:00:00+00', '2026-03-21 05:00:00+00'),
    ('2026-05-05', 2230, 0.1, 0.2, 0.30000000000000004, 123.456789, 1e-7, 3333.3333333333335,
     NULL, NULL, NULL, NULL,
     NULL,
     'apple_health', NULL, NULL, '2026-05-06 05:00:00+00', '2026-05-06 05:00:00+00'),
    ('2026-08-12', 2015, 162.8, 201.4, 71.9, 27.7, 44.4, 2222.2,
     NULL, NULL, NULL, NULL,
     NULL,
     'apple_health', NULL, NULL, '2026-08-13 05:00:00+00', '2026-08-13 05:00:00+00'),
    ('2026-09-01', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
     NULL, NULL, NULL, NULL,
     NULL,
     'apple_health', NULL, NULL, '2026-09-02 05:00:00+00', '2026-09-02 05:00:00+00'),
    ('2026-09-02', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
     NULL, NULL, NULL, NULL,
     NULL,
     'apple_health', NULL, NULL, '2026-09-03 05:00:00+00', '2026-09-03 05:00:00+00');
