import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { db } from './firebase';

export interface UserProfile {
  uid: string;
  xp: number;
  level: number;
  stats: Record<string, number>;
  achievements: Record<string, number>; // id -> highest 0-based tier index unlocked
}

export const LEVEL_THRESHOLDS: number[] = [
  0, 500, 1500, 4000, 9000, 19000, 44000, 94000, 194000, 444000,
  944000, 1944000, 4444000, 9444000, 19444000, 44444000, 94444000,
  194444000, 444444000, 944444000,
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
const SESSION = [1,5,10,25,50,100,250,500,1000,2500];

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

// ── Module state ──────────────────────────────────────────────────────────────

let _profile: UserProfile | null = null;
let _pendingXP = 0;
let _dirty = false;

type LevelUpCb  = (oldLv: number, newLv: number) => void;
type UnlockCb   = (id: string, tier: number, name: string) => void;

let _onLevelUp: LevelUpCb | null = null;
let _onUnlock:  UnlockCb  | null = null;

export function setOnLevelUp(cb: LevelUpCb):   void { _onLevelUp = cb; }
export function setOnAchievementUnlocked(cb: UnlockCb): void { _onUnlock = cb; }

export function getProfile(): UserProfile | null { return _profile; }

// ── Load / create ─────────────────────────────────────────────────────────────

export async function loadProfile(uid: string): Promise<UserProfile> {
  const r = doc(db, 'profiles', uid);
  const snap = await getDoc(r);
  if (snap.exists()) {
    _profile = snap.data() as UserProfile;
    _profile.stats        ??= {};
    _profile.achievements ??= {};
  } else {
    _profile = { uid, xp: 0, level: 1, stats: {}, achievements: {} };
    await setDoc(r, _profile);
  }
  _pendingXP = 0; _dirty = false;
  return _profile;
}

export function clearProfile(): void {
  _profile = null; _pendingXP = 0; _dirty = false;
}

// ── XP ────────────────────────────────────────────────────────────────────────

export function awardXP(amount: number): void {
  if (!_profile) return;
  _pendingXP += amount;
  _dirty = true;
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
}

// ── Flush to Firestore ────────────────────────────────────────────────────────

export async function flushSession(): Promise<void> {
  if (!_profile || !_dirty) return;
  const oldLevel = _profile.level;
  _profile.xp   += _pendingXP;
  _pendingXP     = 0;
  _dirty         = false;
  _profile.level = computeLevel(_profile.xp);
  try {
    await updateDoc(doc(db, 'profiles', _profile.uid), {
      xp: _profile.xp, level: _profile.level,
      stats: _profile.stats, achievements: _profile.achievements,
    });
    if (_profile.level > oldLevel) _onLevelUp?.(oldLevel, _profile.level);
  } catch (e) {
    console.error('[profile] flush failed', e);
  }
}
