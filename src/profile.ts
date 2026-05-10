import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { db } from './firebase';

export interface UserProfile {
  uid: string;
  xp: number;
  level: number;
  stats: Record<string, number>;
  achievements: Record<string, number>; // id -> highest 0-based tier index unlocked
  dailyXP: number;
  dailyXPStart: number;
  gender?: 'male' | 'female';
  activeSkin?: string;
  unlockedSkins?: string[];
  familiarAbility?: FamiliarAbility;
  prestige?: number;
  claimedLevel?: number;
}

export type FamiliarAbility = 'cook_speed' | 'chop_speed' | 'carry' | 'eat_leftovers';

export interface SkinDef { id: string; name: string; apronColor: string; }

export const SKIN_POOL: SkinDef[] = [
  { id: 'default',   name: 'Classic',   apronColor: '#c8402a' },
  { id: 'royal',     name: 'Royal',     apronColor: '#2060c8' },
  { id: 'mint',      name: 'Mint',      apronColor: '#2aac6a' },
  { id: 'gold',      name: 'Gold',      apronColor: '#c8a020' },
  { id: 'crimson',   name: 'Crimson',   apronColor: '#8a1020' },
  { id: 'violet',    name: 'Violet',    apronColor: '#7a20c8' },
  { id: 'teal',      name: 'Teal',      apronColor: '#209898' },
  { id: 'sunrise',   name: 'Sunrise',   apronColor: '#e07020' },
  { id: 'rose',      name: 'Rose',      apronColor: '#c83080' },
  { id: 'onyx',      name: 'Onyx',      apronColor: '#303030' },
  { id: 'jade',      name: 'Jade',      apronColor: '#20a060' },
  { id: 'cobalt',    name: 'Cobalt',    apronColor: '#1040a0' },
  { id: 'ember',     name: 'Ember',     apronColor: '#d05010' },
  { id: 'lilac',     name: 'Lilac',     apronColor: '#a060c0' },
  { id: 'sand',      name: 'Sand',      apronColor: '#c09050' },
  { id: 'midnight',  name: 'Midnight',  apronColor: '#102040' },
  { id: 'cherry',    name: 'Cherry',    apronColor: '#c02040' },
  { id: 'sage',      name: 'Sage',      apronColor: '#608060' },
  { id: 'tangerine', name: 'Tangerine', apronColor: '#e86010' },
  { id: 'pearl',     name: 'Pearl',     apronColor: '#c8c0a0' },
];

// Feature unlock thresholds by player level
export const LEVEL_UNLOCKS: Record<string, number> = {
  dash:        3,
  familiar:    5,
  double_dash: 8,
  mount:       10,
  spec_meter:  13,
  familiar_up: 15,
  mount_up:    20,
};

export function hasUnlock(key: string): boolean {
  if (!_profile) return false;
  return getClaimedLevel() >= (LEVEL_UNLOCKS[key] ?? 999);
}

export function getClaimedLevel(): number {
  return _profile?.claimedLevel ?? _profile?.level ?? 1;
}

export function getProjectedLevel(): number {
  if (!_profile) return 1;
  return computeLevel((_profile.xp ?? 0) + _pendingXP);
}

export function claimLevelUp(newLevel: number): void {
  if (!_profile) return;
  _profile.claimedLevel = Math.max(getClaimedLevel(), newLevel);
  _dirty = true;
}

// Per-level XP costs: 500, 1k, 2.5k, 5k, 10k, 25k, 50k, 100k, 250k, 500k, 1M, 2.5M, ...
export const LEVEL_THRESHOLDS: number[] = [
  0,           // lv1  (start)
  500,         // lv2  (+500)
  1_500,       // lv3  (+1 000)     — DASH
  4_000,       // lv4  (+2 500)
  9_000,       // lv5  (+5 000)     — FAMILIAR
  19_000,      // lv6  (+10 000)
  44_000,      // lv7  (+25 000)
  94_000,      // lv8  (+50 000)    — DOUBLE DASH
  194_000,     // lv9  (+100 000)
  444_000,     // lv10 (+250 000)   — MOUNT + JUMP
  944_000,     // lv11 (+500 000)
  1_944_000,   // lv12 (+1 000 000)
  4_444_000,   // lv13 (+2 500 000) — SPECIAL METER
  9_444_000,   // lv14 (+5 000 000)
  19_444_000,  // lv15 (+10 000 000) — FAMILIAR UPGRADE
  44_444_000,  // lv16 (+25 000 000)
  94_444_000,  // lv17 (+50 000 000)
  194_444_000, // lv18 (+100 000 000)
  444_444_000, // lv19 (+250 000 000)
  944_444_000, // lv20 (+500 000 000) — MOUNT UPGRADE
];

export function computeLevel(xp: number): number {
  let lv = 1;
  for (let i = 1; i < LEVEL_THRESHOLDS.length; i++) {
    if (xp >= LEVEL_THRESHOLDS[i]) lv = i + 1; else break;
  }
  return Math.min(lv, 20);
}

export function xpProgress(xp: number): { current: number; needed: number; level: number } {
  const level = computeLevel(xp);
  if (level >= 20) return { current: 1, needed: 1, level };
  const floor = LEVEL_THRESHOLDS[level - 1];
  const ceil  = LEVEL_THRESHOLDS[level];
  return { current: xp - floor, needed: ceil - floor, level };
}

// ── Achievement definitions ───────────────────────────────────────────────────

export interface AchievementDef {
  id: string; name: string; desc: string; stat: string;
  tiers: number[]; xpPerTier: number[];
}

const STD     = [10,25,50,100,250,500,1000,2500,5000,10000];
const STD_XP  = [100,200,300,400,500,600,700,800,900,1000];
const DOLLAR  = [100000,500000,1000000,5000000,10000000,25000000,50000000,100000000];
const DLRXP   = [100,200,300,400,500,600,700,800];
const SESSION = [5,10,25,50,100,250,500,1000,2500,5000];

export const ACHIEVEMENTS: AchievementDef[] = [
  // Cooking
  { id:'shoulders',           name:'Pit Master',        desc:'Smoke pork shoulders in the smoker',              stat:'shoulders_smoked',      tiers:STD,     xpPerTier:STD_XP  },
  { id:'hotdogs',             name:'Dog Stand',          desc:'Grill hotdogs to order',                          stat:'hotdogs_grilled',       tiers:STD,     xpPerTier:STD_XP  },
  { id:'patties',             name:'Burger Flipper',     desc:'Grill burger patties',                            stat:'patties_grilled',       tiers:STD,     xpPerTier:STD_XP  },
  { id:'cheese',              name:'Cheesy',             desc:'Melt cheese slices on the grill',                 stat:'cheese_melted',         tiers:STD,     xpPerTier:STD_XP  },
  { id:'fries',               name:'Fry Cook',           desc:'Fry baskets of french fries',                     stat:'fries_fried',           tiers:STD,     xpPerTier:STD_XP  },
  { id:'pups',                name:'Pup Wrangler',       desc:'Fry corn dog pups in the fryer',                  stat:'pups_fried',            tiers:STD,     xpPerTier:STD_XP  },
  // Individual plate sales
  { id:'sold_hamburger',      name:'Hamburger Hero',     desc:'Sell hamburgers to customers',                    stat:'sold_hamburger',        tiers:STD,     xpPerTier:STD_XP  },
  { id:'sold_cheeseburger',   name:'Cheese Please',      desc:'Sell cheeseburgers to customers',                 stat:'sold_cheeseburger',     tiers:STD,     xpPerTier:STD_XP  },
  { id:'sold_dbl_burger',     name:'Double Down',        desc:'Sell double burgers to customers',                    stat:'sold_dbl_burger',       tiers:STD,     xpPerTier:STD_XP  },
  { id:'sold_dbl_cheese',     name:'Double Cheese',      desc:'Sell double cheeseburgers to customers',           stat:'sold_dbl_cheeseburger', tiers:STD,     xpPerTier:STD_XP  },
  { id:'sold_hotdog',         name:'Hot Diggity',        desc:'Sell hotdogs to customers',                       stat:'sold_hotdog',           tiers:STD,     xpPerTier:STD_XP  },
  { id:'sold_bbq_sand',       name:'Pit Stop',           desc:'Sell BBQ sandwiches to customers',                stat:'sold_bbq_sand',         tiers:STD,     xpPerTier:STD_XP  },
  { id:'sold_bbq_plate',      name:'Full Rack',          desc:'Sell BBQ plates to customers',                    stat:'sold_bbq_plate',        tiers:STD,     xpPerTier:STD_XP  },
  { id:'sold_combo',          name:'Combo Artist',       desc:'Sell combo meals (sandwich + side)',               stat:'sold_combo',            tiers:STD,     xpPerTier:STD_XP  },
  // Aggregate gameplay
  { id:'plates',              name:'Short Order Cook',   desc:'Complete customer orders from start to finish',   stat:'plates_completed',      tiers:STD,     xpPerTier:STD_XP  },
  { id:'grill_uses',          name:'Grill Master',       desc:'Place food on the grill',                         stat:'grill_uses',            tiers:STD,     xpPerTier:STD_XP  },
  { id:'fryer_uses',          name:'Deep Fryer',         desc:'Place food in the fryer',                         stat:'fryer_uses',            tiers:STD,     xpPerTier:STD_XP  },
  { id:'bbq_chops',           name:'Knife Skills',       desc:'Chop smoked pork at the chop station',            stat:'bbq_chops',             tiers:STD,     xpPerTier:STD_XP  },
  { id:'customers_lost',      name:'Customer Service',   desc:'Let customers walk out without being served',     stat:'customers_lost',        tiers:STD,     xpPerTier:STD_XP  },
  { id:'food_burned',         name:'Smoke Show',         desc:'Burn food by leaving it on too long',             stat:'food_burned',           tiers:STD,     xpPerTier:STD_XP  },
  // Sessions
  { id:'solo_sessions',       name:'Solo Chef',          desc:'Play solo game sessions',                         stat:'solo_sessions',         tiers:SESSION, xpPerTier:STD_XP  },
  { id:'coop_sessions',       name:'Team Player',        desc:'Play co-op game sessions with a partner',         stat:'coop_sessions',         tiers:SESSION, xpPerTier:STD_XP  },
  // Game stage reached
  { id:'max_stage',           name:'Rising Star',        desc:'Reach higher stages in a single run',             stat:'max_stage',             tiers:[2,3,4,5,6,7,8,9,10], xpPerTier:[100,200,300,400,500,600,700,800,900] },
  // Dollar-based (in cents)
  { id:'total_sales',         name:'Big Bucks',          desc:'Total revenue earned across all sessions',        stat:'total_sales',           tiers:DOLLAR,  xpPerTier:DLRXP   },
  { id:'total_profit',        name:'In the Black',       desc:'Total profit earned across all sessions',         stat:'total_profit',          tiers:DOLLAR,  xpPerTier:DLRXP   },
  { id:'total_food_cost',     name:'COGS King',          desc:'Total food cost spent across all sessions',       stat:'total_food_cost',       tiers:DOLLAR,  xpPerTier:DLRXP   },
  { id:'total_waste',         name:'Waste Not',          desc:'Total value of food wasted across all sessions',  stat:'total_waste',           tiers:DOLLAR,  xpPerTier:DLRXP   },
  { id:'total_labor',         name:'Payroll Pro',        desc:'Total labor cost paid across all sessions',       stat:'total_labor',           tiers:DOLLAR,  xpPerTier:DLRXP   },
];

// ── Daily XP multiplier ───────────────────────────────────────────────────────

// Thresholds are cumulative effective XP earned in a 24-hour window.
// x1 → x2 at 1 000, x3 at 3 000 (+2 k), x4 at 7 000 (+4 k), x5 at 15 000 (+8 k).
export const DAILY_MULT_THRESHOLDS = [0, 1000, 3000, 7000, 15000];

// Returns effective XP accumulated in the current 24-hour window (committed + pending).
export function getDailyXP(): number {
  if (!_profile) return _pendingDailyXP;
  const expired = Date.now() - (_profile.dailyXPStart ?? 0) >= 86_400_000;
  return (expired ? 0 : (_profile.dailyXP ?? 0)) + _pendingDailyXP;
}

export function getDailyMultiplier(): number {
  const daily = getDailyXP();
  let mult = 1;
  for (let i = 1; i < DAILY_MULT_THRESHOLDS.length; i++) {
    if (daily >= DAILY_MULT_THRESHOLDS[i]) mult = i + 1; else break;
  }
  return mult;
}

// ── Module state ──────────────────────────────────────────────────────────────

let _profile: UserProfile | null = null;
let _pendingXP = 0;
let _pendingDailyXP = 0;
let _dirty = false;

type LevelUpCb    = (oldLv: number, newLv: number) => void;
type UnlockCb     = (id: string, tier: number, name: string) => void;
type SkinUnlockCb = (skin: SkinDef) => void;

let _onLevelUp:      LevelUpCb    | null = null;
let _onLevelUpEarly: LevelUpCb    | null = null;
let _onUnlock:       UnlockCb     | null = null;
let _onSkinUnlock:   SkinUnlockCb | null = null;
// Tracks the highest level we've already notified in-game so we don't double-fire
let _notifiedLevel = 0;

export function setOnLevelUp(cb: LevelUpCb):              void { _onLevelUp = cb; }
export function setOnEarlyLevelUp(cb: LevelUpCb):         void { _onLevelUpEarly = cb; }
export function setOnAchievementUnlocked(cb: UnlockCb):   void { _onUnlock = cb; }
export function setOnSkinUnlock(cb: SkinUnlockCb):        void { _onSkinUnlock = cb; }

// Checks whether pending XP has already crossed a new level threshold and fires
// the early callback immediately (for in-game toast), without modifying the profile.
function _checkEarlyLevelUp(): void {
  if (!_profile || !_onLevelUpEarly) return;
  const baseline = _notifiedLevel > 0 ? _notifiedLevel : _profile.level;
  const projected = computeLevel(_profile.xp + _pendingXP);
  if (projected > baseline) {
    _notifiedLevel = projected;
    _onLevelUpEarly(baseline, projected);
  }
}

export function getProfile(): UserProfile | null { return _profile; }

// ── Load / create ─────────────────────────────────────────────────────────────

export async function loadProfile(uid: string): Promise<UserProfile> {
  const r = doc(db, 'profiles', uid);
  const snap = await getDoc(r);
  const now = Date.now();
  if (snap.exists()) {
    _profile = snap.data() as UserProfile;
    _profile.stats          ??= {};
    _profile.achievements   ??= {};
    _profile.dailyXP        ??= 0;
    _profile.dailyXPStart   ??= now;
    _profile.unlockedSkins  ??= ['default'];
    _profile.activeSkin     ??= 'default';
    _profile.prestige       ??= 0;
    _profile.claimedLevel   ??= _profile.level; // existing players inherit their current level
    if (now - _profile.dailyXPStart >= 86_400_000) {
      _profile.dailyXP = 0;
      _profile.dailyXPStart = now;
    }
  } else {
    _profile = { uid, xp: 0, level: 1, stats: {}, achievements: {}, dailyXP: 0, dailyXPStart: now, unlockedSkins: ['default'], activeSkin: 'default', prestige: 0 };
    await setDoc(r, _profile);
  }
  _pendingXP = 0; _pendingDailyXP = 0; _dirty = false; _notifiedLevel = 0;
  return _profile;
}

export function clearProfile(): void {
  _profile = null; _pendingXP = 0; _pendingDailyXP = 0; _dirty = false; _notifiedLevel = 0;
}

// ── XP ────────────────────────────────────────────────────────────────────────

// Applies the current daily multiplier and returns the effective XP awarded.
export function awardXP(amount: number): number {
  if (!_profile) return 0;
  const mult = getDailyMultiplier();
  const effective = amount * mult;
  _pendingXP += effective;
  _pendingDailyXP += effective;
  _dirty = true;
  _checkEarlyLevelUp();
  return effective;
}

// Total XP including in-session pending — use this for the live XP bar.
export function getTotalXP(): number {
  return (_profile?.xp ?? 0) + _pendingXP;
}

// Wipe pending XP without saving — used when ending a session with no reward (inactivity).
export function clearPendingXP(): void {
  _pendingXP = 0;
  _pendingDailyXP = 0;
  _dirty = false;
  _notifiedLevel = 0;
}

// ── Profile preferences ───────────────────────────────────────────────────────

export function setGender(g: 'male' | 'female'): void {
  if (!_profile) return;
  _profile.gender = g; _dirty = true;
}

export function setActiveSkin(id: string): void {
  if (!_profile) return;
  if (!_profile.unlockedSkins?.includes(id)) return;
  _profile.activeSkin = id; _dirty = true;
}

export function setFamiliarAbility(ab: FamiliarAbility): void {
  if (!_profile) return;
  _profile.familiarAbility = ab; _dirty = true;
}

export async function saveProfilePrefs(): Promise<void> {
  if (!_profile) return;
  try {
    await updateDoc(doc(db, 'profiles', _profile.uid), {
      gender:          _profile.gender ?? null,
      activeSkin:      _profile.activeSkin ?? 'default',
      unlockedSkins:   _profile.unlockedSkins ?? ['default'],
      familiarAbility: _profile.familiarAbility ?? null,
      claimedLevel:    _profile.claimedLevel ?? 1,
    });
  } catch (e) { console.error('[profile] save prefs failed', e); }
}

export async function resetProfile(): Promise<void> {
  if (!_profile) return;
  _profile.xp = 0; _profile.level = 1; _profile.claimedLevel = 1;
  _profile.stats = {}; _profile.achievements = {};
  _profile.familiarAbility = undefined;
  _profile.dailyXP = 0; _profile.dailyXPStart = Date.now();
  _profile.prestige = (_profile.prestige ?? 0) + 1;
  _pendingXP = 0; _pendingDailyXP = 0; _dirty = false; _notifiedLevel = 0;
  try {
    await setDoc(doc(db, 'profiles', _profile.uid), _profile);
  } catch (e) { console.error('[profile] reset failed', e); }
}

// ── Stats & achievements ──────────────────────────────────────────────────────

export function incrementStat(key: string, amount: number): void {
  if (!_profile || amount === 0) return;
  const old = _profile.stats[key] ?? 0;
  _profile.stats[key] = old + amount;
  _checkAchievements(key, old, _profile.stats[key]);
  _dirty = true;
}

export function recordMaxStat(key: string, value: number): void {
  if (!_profile) return;
  const old = _profile.stats[key] ?? 0;
  if (value <= old) return;
  _profile.stats[key] = value;
  _checkAchievements(key, old, value);
  _dirty = true;
}

function _checkAchievements(key: string, oldVal: number, newVal: number): void {
  if (!_profile) return;
  for (const ach of ACHIEVEMENTS) {
    if (ach.stat !== key) continue;
    const cur = _profile.achievements[ach.id] ?? -1;
    for (let t = cur + 1; t < ach.tiers.length; t++) {
      if (newVal >= ach.tiers[t]) {
        _profile.achievements[ach.id] = t;
        _pendingXP += ach.xpPerTier[t] ?? 0;
        _onUnlock?.(ach.id, t, ach.name);
      } else {
        break;
      }
    }
  }
  _checkEarlyLevelUp();
}

// ── Flush to Firestore ────────────────────────────────────────────────────────

export async function flushSession(): Promise<void> {
  if (!_profile || !_dirty) return;
  const oldLevel = _profile.level;
  const now = Date.now();
  // Commit daily XP (roll the window if it expired)
  if (now - (_profile.dailyXPStart ?? 0) >= 86_400_000) {
    _profile.dailyXP = _pendingDailyXP;
    _profile.dailyXPStart = now;
  } else {
    _profile.dailyXP = (_profile.dailyXP ?? 0) + _pendingDailyXP;
  }
  _pendingDailyXP = 0;
  _profile.xp   += _pendingXP;
  _pendingXP     = 0;
  _dirty         = false;
  _profile.level = computeLevel(_profile.xp);
  try {
    await updateDoc(doc(db, 'profiles', _profile.uid), {
      xp: _profile.xp, level: _profile.level,
      stats: _profile.stats, achievements: _profile.achievements,
      dailyXP: _profile.dailyXP, dailyXPStart: _profile.dailyXPStart,
      unlockedSkins: _profile.unlockedSkins, activeSkin: _profile.activeSkin,
      gender: _profile.gender ?? null, familiarAbility: _profile.familiarAbility ?? null,
      prestige: _profile.prestige ?? 0,
    });
    if (_profile.level > oldLevel) {
      // Unlock a random skin not yet owned
      const locked = SKIN_POOL.filter(s => !_profile!.unlockedSkins!.includes(s.id));
      if (locked.length > 0) {
        const pick = locked[Math.floor(Math.random() * locked.length)];
        _profile.unlockedSkins = [..._profile.unlockedSkins!, pick.id];
        _onSkinUnlock?.(pick);
        // Persist the new skin immediately (fire and forget)
        updateDoc(doc(db, 'profiles', _profile.uid), { unlockedSkins: _profile.unlockedSkins }).catch(() => {});
      }
      _onLevelUp?.(oldLevel, _profile.level);
    }
  } catch (e) {
    console.error('[profile] flush failed', e);
  }
}
