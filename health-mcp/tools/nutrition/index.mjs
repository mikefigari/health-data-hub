import { registerLogFood } from './log-food.mjs';
import { registerSaveFavorite } from './favorites.mjs';
import { registerSearchFoods } from './search.mjs';

// Registers the nutrition tools. Nothing is registered unless writes are enabled
// and a writer pool exists.
export function registerNutritionTools(server, { pool, writePool, config, guard }) {
  if (!config.WRITES_ENABLED || !writePool) return;
  registerLogFood(server, { pool, writePool, guard });
  registerSaveFavorite(server, { writePool, guard });
  registerSearchFoods(server, { pool });
}
