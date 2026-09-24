'use strict';

// Magic Fight Quest System
// Server-side quest definitions/state/rewards only.
// Battle damage/heal/taken events may be reported by the client; the server still owns
// quest state, period rollover, completion and reward claiming.

const DAILY_POOL = [
  { id: 'daily_damage_150', title: '敵に150ダメージを与える', event: 'damageDealt', target: 150, reward: { coins: 30 } },
  { id: 'daily_damage_350', title: '敵に350ダメージを与える', event: 'damageDealt', target: 350, reward: { coins: 50 } },
  { id: 'daily_damage_550', title: '敵に550ダメージを与える', event: 'damageDealt', target: 550, reward: { coins: 100 } },
  { id: 'daily_kill_1', title: '敵を1回撃破する', event: 'kill', target: 1, reward: { coins: 50 } },
  { id: 'daily_kill_3', title: '敵を3回撃破する', event: 'kill', target: 3, reward: { coins: 100 } },
  { id: 'daily_kill_5', title: '敵を5回撃破する', event: 'kill', target: 5, reward: { coins: 150 } },
  { id: 'daily_heal_60', title: 'HPを60回復する', event: 'hpRecovered', target: 60, reward: { coins: 30 } },
  { id: 'daily_heal_120', title: 'HPを120回復する', event: 'hpRecovered', target: 120, reward: { coins: 100 } },
  { id: 'daily_heal_300', title: 'HPを300回復する', event: 'hpRecovered', target: 300, reward: { coins: 150 } },
  { id: 'daily_gacha_1', title: 'ガチャを1回回す', event: 'gachaPull', target: 1, reward: { coins: 50 } },
  { id: 'daily_gacha_3', title: 'ガチャを3回回す', event: 'gachaPull', target: 3, reward: { coins: 150 } },
  { id: 'daily_gacha_5', title: 'ガチャを5回回す', event: 'gachaPull', target: 5, reward: { coins: 200 } },
  { id: 'daily_ex_ult_1', title: 'EX ULTを使用する', event: 'exUltUsed', target: 1, reward: { coins: 50 } },
  { id: 'daily_damage_taken_200', title: '200ダメージ被弾する', event: 'damageTaken', target: 200, reward: { coins: 30 } },
  { id: 'daily_damage_taken_400', title: '400ダメージ被弾する', event: 'damageTaken', target: 400, reward: { coins: 100 } }
];

const WEEKLY_POOL = [
  { id: 'weekly_damage_800', title: '敵に800ダメージを与える', event: 'damageDealt', target: 800, reward: { coins: 100 } },
  { id: 'weekly_damage_1000', title: '敵に1000ダメージを与える', event: 'damageDealt', target: 1000, reward: { coins: 200 } },
  { id: 'weekly_damage_1500', title: '敵に1500ダメージを与える', event: 'damageDealt', target: 1500, reward: { coins: 250 } },
  { id: 'weekly_heal_600', title: 'HPを600回復する', event: 'hpRecovered', target: 600, reward: { coins: 100 } },
  { id: 'weekly_heal_800', title: 'HPを800回復する', event: 'hpRecovered', target: 800, reward: { coins: 200 } },
  { id: 'weekly_heal_1000', title: 'HPを1000回復する', event: 'hpRecovered', target: 1000, reward: { coins: 250 } },
  { id: 'weekly_gacha_10', title: 'ガチャを10回回す', event: 'gachaPull', target: 10, reward: { coins: 150 } },
  { id: 'weekly_gacha_15', title: 'ガチャを15回回す', event: 'gachaPull', target: 15, reward: { coins: 300 } },
  { id: 'weekly_gacha_20', title: 'ガチャを20回回す', event: 'gachaPull', target: 20, reward: { coins: 400 } },
  { id: 'weekly_gear_1', title: 'ギアを1つ完成させる', event: 'gearCompleted', target: 1, reward: { coins: 150 } },
  { id: 'weekly_gear_3', title: 'ギアを3つ完成させる', event: 'gearCompleted', target: 3, reward: { coins: 200 } },
  { id: 'weekly_ex_ult_5', title: 'EX ULTを5回使用する', event: 'exUltUsed', target: 5, reward: { coins: 200 } },
  { id: 'weekly_rate_2', title: 'レート戦を2回行う', event: 'rateBattleCompleted', target: 2, reward: { coins: 150 } },
  { id: 'weekly_rate_5', title: 'レート戦を5回行う', event: 'rateBattleCompleted', target: 5, reward: { coins: 250 } },
  { id: 'weekly_rate_win_1', title: 'レート戦で1回勝利する', event: 'rateWin', target: 1, reward: { coins: 400 } }
];

const MONTHLY_QUESTS = [
  { id: 'monthly_login_streak_7', title: 'ログインボーナスを7日連続で受け取る', event: 'loginStreak', target: 7, reward: { coins: 100 } },
  { id: 'monthly_weekly_complete_1', title: 'ウィークリークエストを1回コンプリートする', event: 'weeklyCompleted', target: 1, reward: { coins: 200 } },
  { id: 'monthly_damage_5000', title: '敵に5000ダメージを与える', event: 'damageDealt', target: 5000, reward: { coins: 150 } },
  { id: 'monthly_damage_8000', title: '敵に8000ダメージを与える', event: 'damageDealt', target: 8000, reward: { coins: 350 } },
  { id: 'monthly_damage_10000', title: '敵に10000ダメージを与える', event: 'damageDealt', target: 10000, reward: { coins: 600 } },
  { id: 'monthly_ex_ult_15', title: 'EX ULTを15回使用する', event: 'exUltUsed', target: 15, reward: { coins: 300 } },
  { id: 'monthly_gacha_30', title: 'ガチャを30回回す', event: 'gachaPull', target: 30, reward: { coins: 600 } },
  { id: 'monthly_gacha_60', title: 'ガチャを60回回す', event: 'gachaPull', target: 60, reward: { fragments: 3 } },
  { id: 'monthly_gacha_90', title: 'ガチャを90回回す', event: 'gachaPull', target: 90, reward: { fragments: 5 } },
  { id: 'monthly_rate_30', title: 'レート戦を30回行う', event: 'rateBattleCompleted', target: 30, reward: { coins: 600 } },
  { id: 'monthly_rate_45', title: 'レート戦を45回行う', event: 'rateBattleCompleted', target: 45, reward: { coins: 900 } },
  { id: 'monthly_rate_60', title: 'レート戦を60回行う', event: 'rateBattleCompleted', target: 60, reward: { fragments: 3 } },
  { id: 'monthly_rate_win_10', title: 'レート戦で10回勝利する', event: 'rateWin', target: 10, reward: { coins: 600 } },
  { id: 'monthly_rate_win_20', title: 'レート戦で20回勝利する', event: 'rateWin', target: 20, reward: { fragments: 5 } },
  { id: 'monthly_coin_15000', title: '15000コイン獲得する', event: 'coinEarned', target: 15000, reward: { fragments: 3 } }
];

const LOGIN_BONUS_REWARDS = [
  { day: 1, coins: 100 },
  { day: 2, coins: 150 },
  { day: 3, coins: 200 },
  { day: 4, coins: 250 },
  { day: 5, coins: 300 },
  { day: 6, coins: 400, fragments: 1 },
  { day: 7, coins: 500, fragments: 2 }
];

const DAILY_COUNT = 5;
const WEEKLY_COUNT = 7;
const MAX_CLIENT_EVENT_AMOUNT = 100000;

let configuredGearIds = [];

function configure({ gearIds } = {}) {
  if (Array.isArray(gearIds) && gearIds.length > 0) {
    configuredGearIds = Array.from(new Set(gearIds.filter(id => typeof id === 'string')));
  }
}

function getJstParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day) };
}

function getJstDateKey(date = new Date()) {
  const p = getJstParts(date);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function getJstMonthKey(date = new Date()) {
  const p = getJstParts(date);
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
}

function getJstDateUtcMidnight(date = new Date()) {
  const p = getJstParts(date);
  return new Date(Date.UTC(p.year, p.month - 1, p.day));
}

function getJstWeekKey(date = new Date()) {
  const utc = getJstDateUtcMidnight(date);
  const day = utc.getUTCDay(); // Sunday=0
  const diffToMonday = (day + 6) % 7;
  const monday = new Date(utc.getTime() - diffToMonday * 86400000);

  // ISO week year/week derived from the Monday date.
  const thursday = new Date(monday.getTime() + 3 * 86400000);
  const weekYear = thursday.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(weekYear, 0, 4));
  const firstMonday = new Date(firstThursday.getTime() - ((firstThursday.getUTCDay() + 6) % 7) * 86400000);
  const week = 1 + Math.round((monday.getTime() - firstMonday.getTime()) / 604800000);
  return `${weekYear}-W${String(week).padStart(2, '0')}`;
}

function cloneReward(reward) {
  return { ...(reward || {}) };
}

function cloneQuestDefinition(def) {
  return {
    id: def.id,
    title: def.title,
    event: def.event,
    target: def.target,
    reward: cloneReward(def.reward)
  };
}

function sampleWithoutReplacement(source, count) {
  const pool = source.slice();
  const out = [];
  while (pool.length > 0 && out.length < count) {
    const index = Math.floor(Math.random() * pool.length);
    out.push(pool.splice(index, 1)[0]);
  }
  return out;
}

function baseQuestState(category, periodKey, defs) {
  return {
    periodKey,
    quests: defs.map(def => ({
      id: def.id,
      progress: 0,
      claimed: false
    }))
  };
}

function isValidQuestState(state, defs, count) {
  if (!state || typeof state !== 'object') return false;
  if (!Array.isArray(state.quests) || state.quests.length !== count) return false;
  const validIds = new Set(defs.map(q => q.id));
  const seen = new Set();
  for (const q of state.quests) {
    if (!q || typeof q.id !== 'string' || !validIds.has(q.id) || seen.has(q.id)) return false;
    seen.add(q.id);
  }
  return true;
}

function createInitialQuestState() {
  const dailyKey = getJstDateKey();
  const weeklyKey = getJstWeekKey();
  const monthlyKey = getJstMonthKey();
  const dailyDefs = sampleWithoutReplacement(DAILY_POOL, DAILY_COUNT);
  const weeklyDefs = sampleWithoutReplacement(WEEKLY_POOL, WEEKLY_COUNT);
  return {
    loginBonus: { lastClaimDate: null, streak: 0 },
    dailyQuests: baseQuestState('daily', dailyKey, dailyDefs),
    weeklyQuests: baseQuestState('weekly', weeklyKey, weeklyDefs),
    monthlyQuests: baseQuestState('monthly', monthlyKey, MONTHLY_QUESTS),
    monthlyLoginStreak: 0,
    monthlyCoinEarned: 0
  };
}

function normalizeLoginBonus(state) {
  if (!state || typeof state !== 'object') state = {};
  const lastClaimDate = typeof state.lastClaimDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(state.lastClaimDate)
    ? state.lastClaimDate
    : null;
  let streak = Number(state.streak);
  if (!Number.isFinite(streak) || streak < 0) streak = 0;
  streak = Math.min(7, Math.floor(streak));
  return { lastClaimDate, streak };
}

function normalizeQuestEntries(state, defsById, currentPeriodKey, expectedCount, randomDefs) {
  if (!state || typeof state !== 'object') {
    return baseQuestState('', currentPeriodKey, randomDefs);
  }
  if (state.periodKey !== currentPeriodKey || !Array.isArray(state.quests)) {
    return baseQuestState('', currentPeriodKey, randomDefs);
  }
  if (state.quests.length !== expectedCount) {
    return baseQuestState('', currentPeriodKey, randomDefs);
  }
  const valid = state.quests.every(q => q && typeof q.id === 'string' && defsById.has(q.id));
  if (!valid) return baseQuestState('', currentPeriodKey, randomDefs);
  return {
    periodKey: currentPeriodKey,
    quests: state.quests.map(q => ({
      id: q.id,
      progress: Number.isFinite(Number(q.progress)) ? Math.max(0, Number(q.progress)) : 0,
      claimed: q.claimed === true
    }))
  };
}

function ensureQuestState(profile) {
  if (!profile || typeof profile !== 'object') return profile;

  const dailyKey = getJstDateKey();
  const weeklyKey = getJstWeekKey();
  const monthlyKey = getJstMonthKey();

  const existingDaily = profile.dailyQuests;
  const dailyIds = existingDaily && Array.isArray(existingDaily.quests) ? existingDaily.quests.map(q => q?.id).filter(Boolean) : [];
  const dailyDefs = sampleWithoutReplacement(
    DAILY_POOL.filter(def => dailyIds.includes(def.id)),
    DAILY_COUNT
  );
  // When the current state is valid, preserve it. Only sample when the period/shape is stale.
  if (!existingDaily || existingDaily.periodKey !== dailyKey || !isValidQuestState(existingDaily, DAILY_POOL, DAILY_COUNT)) {
    profile.dailyQuests = baseQuestState('daily', dailyKey, sampleWithoutReplacement(DAILY_POOL, DAILY_COUNT));
  } else {
    for (const q of existingDaily.quests) {
      q.progress = Number.isFinite(Number(q.progress)) ? Math.max(0, Number(q.progress)) : 0;
      q.claimed = q.claimed === true;
    }
  }

  const existingWeekly = profile.weeklyQuests;
  if (!existingWeekly || existingWeekly.periodKey !== weeklyKey || !isValidQuestState(existingWeekly, WEEKLY_POOL, WEEKLY_COUNT)) {
    profile.weeklyQuests = baseQuestState('weekly', weeklyKey, sampleWithoutReplacement(WEEKLY_POOL, WEEKLY_COUNT));
  } else {
    for (const q of existingWeekly.quests) {
      q.progress = Number.isFinite(Number(q.progress)) ? Math.max(0, Number(q.progress)) : 0;
      q.claimed = q.claimed === true;
    }
  }

  const existingMonthly = profile.monthlyQuests;
  const monthlyPeriodChanged = !existingMonthly || existingMonthly.periodKey !== monthlyKey;
  if (!existingMonthly || existingMonthly.periodKey !== monthlyKey || !isValidQuestState(existingMonthly, MONTHLY_QUESTS, MONTHLY_QUESTS.length)) {
    profile.monthlyQuests = baseQuestState('monthly', monthlyKey, MONTHLY_QUESTS);
    if (monthlyPeriodChanged) {
      profile.monthlyCoinEarned = 0;
      profile.monthlyLoginStreak = 0;
    }
  } else {
    for (const q of existingMonthly.quests) {
      q.progress = Number.isFinite(Number(q.progress)) ? Math.max(0, Number(q.progress)) : 0;
      q.claimed = q.claimed === true;
    }
  }

  if (!Number.isFinite(Number(profile.monthlyCoinEarned)) || Number(profile.monthlyCoinEarned) < 0) {
    profile.monthlyCoinEarned = 0;
  }
  profile.monthlyCoinEarned = Math.floor(profile.monthlyCoinEarned);
  if (!Number.isFinite(Number(profile.monthlyLoginStreak)) || Number(profile.monthlyLoginStreak) < 0) {
    profile.monthlyLoginStreak = 0;
  }
  profile.monthlyLoginStreak = Math.min(7, Math.floor(profile.monthlyLoginStreak));
  profile.loginBonus = normalizeLoginBonus(profile.loginBonus);

  syncSpecialMonthlyProgress(profile);
  return profile;
}

function getDefinitionsForCategory(category) {
  if (category === 'daily') return DAILY_POOL;
  if (category === 'weekly') return WEEKLY_POOL;
  if (category === 'monthly') return MONTHLY_QUESTS;
  return null;
}

function getStateForCategory(profile, category) {
  if (category === 'daily') return profile.dailyQuests;
  if (category === 'weekly') return profile.weeklyQuests;
  if (category === 'monthly') return profile.monthlyQuests;
  return null;
}

function getQuestDefinition(category, questId) {
  const defs = getDefinitionsForCategory(category);
  if (!defs) return null;
  return defs.find(def => def.id === questId) || null;
}

function syncSpecialMonthlyProgress(profile) {
  if (!profile.monthlyQuests) return;
  const monthlyMap = new Map(profile.monthlyQuests.quests.map(q => [q.id, q]));

  const loginQuest = monthlyMap.get('monthly_login_streak_7');
  if (loginQuest) loginQuest.progress = Math.min(7, Math.max(loginQuest.progress, profile.monthlyLoginStreak || 0));

  const coinQuest = monthlyMap.get('monthly_coin_15000');
  if (coinQuest) coinQuest.progress = Math.min(15000, Math.max(coinQuest.progress, profile.monthlyCoinEarned || 0));
}

function recordProgress(profile, eventType, amount = 1) {
  ensureQuestState(profile);
  let value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return false;
  value = Math.min(value, MAX_CLIENT_EVENT_AMOUNT);

  let changed = false;
  const applyTo = (state, defs) => {
    if (!state || !Array.isArray(state.quests)) return;
    for (const entry of state.quests) {
      if (entry.claimed) continue;
      const def = defs.find(q => q.id === entry.id);
      if (!def || def.event !== eventType) continue;
      const next = Math.min(def.target, entry.progress + value);
      if (next !== entry.progress) {
        entry.progress = next;
        changed = true;
      }
    }
  };

  applyTo(profile.dailyQuests, DAILY_POOL);
  applyTo(profile.weeklyQuests, WEEKLY_POOL);
  applyTo(profile.monthlyQuests, MONTHLY_QUESTS);

  if (eventType === 'coinEarned') {
    profile.monthlyCoinEarned = Math.min(2147483647, profile.monthlyCoinEarned + Math.floor(value));
    changed = true;
  }

  syncSpecialMonthlyProgress(profile);
  return changed;
}

function addCoins(profile, amount) {
  ensureQuestState(profile);
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return 0;
  const coins = Math.floor(value);
  profile.coins = Math.max(0, Math.floor(Number(profile.coins) || 0)) + coins;
  recordProgress(profile, 'coinEarned', coins);
  return coins;
}

function registerGearCompletion(profile, completedCount) {
  const count = Math.floor(Number(completedCount));
  if (!Number.isFinite(count) || count <= 0) return;
  recordProgress(profile, 'gearCompleted', count);
}

function applyRandomGearFragmentReward(profile, count, addGearFragmentsFn) {
  const requested = Math.floor(Number(count));
  if (!Number.isFinite(requested) || requested <= 0) return { fragments: [], completedGained: 0 };
  if (!configuredGearIds.length || typeof addGearFragmentsFn !== 'function') {
    throw new Error('Quest gear reward is not configured.');
  }

  const allocations = [];
  if (Math.random() < 0.75) {
    const picked = sampleWithoutReplacement(configuredGearIds, Math.min(requested, configuredGearIds.length));
    for (const gearId of picked) allocations.push({ gearId, amount: 1 });
  } else {
    const gearId = configuredGearIds[Math.floor(Math.random() * configuredGearIds.length)];
    allocations.push({ gearId, amount: requested });
  }

  let completedGained = 0;
  for (const allocation of allocations) {
    completedGained += Number(addGearFragmentsFn(profile, allocation.gearId, allocation.amount)) || 0;
  }
  if (completedGained > 0) registerGearCompletion(profile, completedGained);
  return { fragments: allocations, completedGained };
}

function claimQuest(profile, category, questId, addGearFragmentsFn) {
  ensureQuestState(profile);
  const state = getStateForCategory(profile, category);
  const def = getQuestDefinition(category, questId);
  if (!state || !def) return { ok: false, reason: 'invalid_quest' };

  const entry = state.quests.find(q => q.id === questId);
  if (!entry) return { ok: false, reason: 'invalid_quest' };
  if (entry.claimed) return { ok: false, reason: 'already_claimed' };
  if (entry.progress < def.target) return { ok: false, reason: 'not_completed' };

  const reward = cloneReward(def.reward);
  const resultReward = {};
  if (reward.coins) {
    resultReward.coins = addCoins(profile, reward.coins);
  }
  if (reward.fragments) {
    resultReward.fragmentReward = applyRandomGearFragmentReward(profile, reward.fragments, addGearFragmentsFn);
  }

  // Reward application may normalize quest arrays internally (e.g. addCoins/gear completion),
  // so re-fetch the current entry before marking it claimed.
  const currentState = getStateForCategory(profile, category);
  const currentEntry = currentState?.quests?.find(q => q.id === questId);
  if (currentEntry) currentEntry.claimed = true;
  if (category === 'weekly') maybeRegisterWeeklyCompletion(profile);
  ensureQuestState(profile);

  return {
    ok: true,
    category,
    questId,
    title: def.title,
    reward: resultReward
  };
}

function maybeRegisterWeeklyCompletion(profile) {
  ensureQuestState(profile);
  const allClaimed = profile.weeklyQuests.quests.length === WEEKLY_COUNT && profile.weeklyQuests.quests.every(q => q.claimed === true);
  if (!allClaimed) return false;
  recordProgress(profile, 'weeklyCompleted', 1);
  return true;
}

function claimLoginBonus(profile, addGearFragmentsFn) {
  ensureQuestState(profile);
  const today = getJstDateKey();
  const login = profile.loginBonus;
  if (login.lastClaimDate === today) return { ok: false, reason: 'already_claimed' };

  const todayUtc = getJstDateUtcMidnight();
  const lastUtc = login.lastClaimDate
    ? (() => {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(login.lastClaimDate);
        return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
      })()
    : null;
  const yesterdayKey = new Date(todayUtc.getTime() - 86400000).toISOString().slice(0, 10);

  let streak = 1;
  const currentMonthKey = getJstMonthKey();
  let monthlyStreak = 1;
  const lastMonthKey = lastUtc ? getJstMonthKey(lastUtc) : null;
  if (lastUtc && login.lastClaimDate === yesterdayKey && login.streak >= 1 && login.streak < 7) {
    streak = login.streak + 1;
  }
  if (lastUtc && login.lastClaimDate === yesterdayKey && lastMonthKey === currentMonthKey && profile.monthlyLoginStreak >= 1 && profile.monthlyLoginStreak < 7) {
    monthlyStreak = profile.monthlyLoginStreak + 1;
  }

  const reward = LOGIN_BONUS_REWARDS[streak - 1];
  login.lastClaimDate = today;
  login.streak = streak;
  profile.monthlyLoginStreak = monthlyStreak;

  const result = {
    ok: true,
    date: today,
    streak,
    reward: { coins: reward.coins || 0 }
  };

  if (reward.coins) addCoins(profile, reward.coins);
  if (reward.fragments) {
    result.reward.fragmentReward = applyRandomGearFragmentReward(profile, reward.fragments, addGearFragmentsFn);
  }

  syncSpecialMonthlyProgress(profile);
  ensureQuestState(profile);
  return result;
}

function recordRateBattleResult(profile, { completed = 0, won = 0 } = {}) {
  ensureQuestState(profile);
  if (completed > 0) recordProgress(profile, 'rateBattleCompleted', completed);
  if (won > 0) recordProgress(profile, 'rateWin', won);
}

function recordClientEvent(profile, eventType, amount) {
  const allowed = new Set([
    'damageDealt',
    'damageTaken',
    'hpRecovered',
    'kill',
    'exUltUsed'
  ]);
  if (!allowed.has(eventType)) return false;
  let value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return false;
  if (eventType === 'kill' || eventType === 'exUltUsed') value = Math.floor(value);
  return value > 0 && recordProgress(profile, eventType, value);
}

function questEntrySnapshot(category, entry) {
  const def = getQuestDefinition(category, entry.id);
  if (!def) return null;
  return {
    id: def.id,
    title: def.title,
    target: def.target,
    progress: Math.min(def.target, Math.max(0, Number(entry.progress) || 0)),
    completed: (Number(entry.progress) || 0) >= def.target,
    claimed: entry.claimed === true,
    reward: cloneReward(def.reward)
  };
}

function getQuestSnapshot(profile) {
  ensureQuestState(profile);
  return {
    daily: {
      periodKey: profile.dailyQuests.periodKey,
      quests: profile.dailyQuests.quests.map(q => questEntrySnapshot('daily', q)).filter(Boolean)
    },
    weekly: {
      periodKey: profile.weeklyQuests.periodKey,
      quests: profile.weeklyQuests.quests.map(q => questEntrySnapshot('weekly', q)).filter(Boolean)
    },
    monthly: {
      periodKey: profile.monthlyQuests.periodKey,
      quests: profile.monthlyQuests.quests.map(q => questEntrySnapshot('monthly', q)).filter(Boolean)
    }
  };
}

function getLoginBonusSnapshot(profile) {
  ensureQuestState(profile);
  const today = getJstDateKey();
  const claimedToday = profile.loginBonus.lastClaimDate === today;
  const nextDay = claimedToday
    ? profile.loginBonus.streak
    : (profile.loginBonus.streak >= 7 ? 1 : Math.max(1, profile.loginBonus.streak + 1));
  return {
    lastClaimDate: profile.loginBonus.lastClaimDate,
    streak: profile.loginBonus.streak,
    monthlyStreak: profile.monthlyLoginStreak || 0,
    claimedToday,
    nextDay,
    rewards: LOGIN_BONUS_REWARDS.map(x => ({ ...x }))
  };
}

module.exports = {
  DAILY_POOL,
  WEEKLY_POOL,
  MONTHLY_QUESTS,
  LOGIN_BONUS_REWARDS,
  DAILY_COUNT,
  WEEKLY_COUNT,
  configure,
  createInitialQuestState,
  ensureQuestState,
  getJstDateKey,
  getJstWeekKey,
  getJstMonthKey,
  getQuestSnapshot,
  getLoginBonusSnapshot,
  recordProgress,
  recordClientEvent,
  recordRateBattleResult,
  addCoins,
  registerGearCompletion,
  applyRandomGearFragmentReward,
  claimQuest,
  claimLoginBonus
};
