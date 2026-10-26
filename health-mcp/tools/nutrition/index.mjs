import { registerLogFood } from './log-food.mjs';
import { registerSaveFavorite } from './favorites.mjs';
import { registerSearchFoods } from './search.mjs';
import { registerGetDaySummary } from './summary.mjs';
import { registerEditTools } from './edit.mjs';

// Registers the nutrition tools. Nothing is registered unless writes are enabled
// and a writer pool exists. `now` (a () => Date) is injectable for tests.
export function registerNutritionTools(server, { pool, writePool, config, guard, now = () => new Date() }) {
  if (!config.WRITES_ENABLED || !writePool) return;
  registerLogFood(server, { pool, writePool, guard });
  registerSaveFavorite(server, { writePool, guard });
  registerSearchFoods(server, { pool });
  registerGetDaySummary(server, { pool, now });
  registerEditTools(server, { writePool, guard, now });
}
