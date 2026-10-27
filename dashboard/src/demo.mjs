// Deterministic fake inputs for demo mode. Seeded PRNG: same `today` -> same output.
import { addDays } from './aggregate.mjs';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function demoInputs(today) {
  const rng = mulberry32(Number(today.replace(/-/g, '')));
  const jitter = (amp) => (rng() * 2 - 1) * amp;
  const N = 365;

  const weights = [];
  for (let i = 0; i < N; i++) {
    const keep = i === 0 || i === N - 1 || rng() < 0.85;
    if (!keep) continue;
    const kg = 121 - 5 * (i / (N - 1)) + jitter(0.6);
    weights.push({ day: addDays(today, -(N - 1 - i)), kg: Number(kg.toFixed(1)) });
  }

  const goals = [
    { effective_from: addDays(today, -200), target_weight_kg: 100, base_calories: 2620, cycling_kj_factor: 1.0, protein_g: 180 },
  ];

  const rideKj = [];
  const kjOf = new Map();
  for (let i = 119; i >= 0; i--) {
    const day = addDays(today, -i);
    if (rng() < 0.4) {
      const kj = Math.round(400 + rng() * 800);
      rideKj.push({ day, kj });
      kjOf.set(day, kj);
    }
  }

  const nutrition = [];
  for (let i = 119; i >= 0; i--) {
    const day = addDays(today, -i);
    const goal = 2620 + (kjOf.get(day) || 0);
    if (i === 3 || i === 12 || i === 40) continue; // missing days
    if (i === 0) {
      nutrition.push({ day, calories: 900, protein_g: 70, carbs_g: 90, fat_g: 30, goal_calories: goal, logged_complete: true });
      continue;
    }
    const incomplete = i === 5 || i === 20;
    let calories;
    if (i === 1) calories = goal - 150; // under
    else if (i === 2) calories = goal + 250; // over
    else calories = goal + (rng() < 0.35 ? 100 + rng() * 400 : -(50 + rng() * 450));
    calories = Math.round(calories);
    const protein = Math.round(((calories * (27 + rng() * 17)) / 400) * 10) / 10;
    const fat = Math.round((60 + rng() * 40) * 10) / 10;
    const carbs = Math.round(Math.max((calories * 0.9 - protein * 4 - fat * 9) / 4, 20) * 10) / 10;
    nutrition.push({
      day,
      calories: incomplete ? Math.round(calories * 0.6) : calories,
      protein_g: protein,
      carbs_g: carbs,
      fat_g: fat,
      goal_calories: goal,
      logged_complete: !incomplete,
    });
  }

  const ftp = [
    { day: addDays(today, -330), ftp_w: 230 },
    { day: addDays(today, -250), ftp_w: 240 },
    { day: addDays(today, -170), ftp_w: 250 },
    { day: addDays(today, -90), ftp_w: 258 },
    { day: addDays(today, -20), ftp_w: 265 },
  ];

  return { today, rangeDays: 30, loggingStart: null, planKgPerWeek: 0.75, weights, nutrition, goals, rideKj, ftp };
}
