// Shared constants for the Leonida Trophy Guide: storage keys, labels, and
// the roadmap stages. Nothing here touches the network.
export const EARNED_KEY = 'leonida-trophy-earned-v1';
export const SETTINGS_KEY = 'leonida-trophy-settings-v1';
export const DATA_URL = 'data/trophies.json';
export const TOTAL_TROPHIES = 55;

export const GRADE_ORDER = ['platinum', 'gold', 'silver', 'bronze'];

export const GRADE_LABELS = {
  platinum: 'Platinum',
  gold: 'Gold',
  silver: 'Silver',
  bronze: 'Bronze',
};

export const KIND_LABELS = {
  story: 'Story',
  missable: 'Missable',
  collectibles: 'Collectibles',
  activities: 'Activities',
  side: 'Strangers & contacts',
  completion: '100% completion',
  platinum: 'Platinum',
};

// The platinum path, in the order to play it. Built from the official
// descriptions: story chapters and missions first, then the feats that can
// be missed, then side strands, activities, collectibles, money and combat,
// with 100% completion and the platinum last.
export const ROADMAP_STAGES = [
  { stage: 1, title: 'Stage 1 — Play the story', blurb: 'Chapters 1 to 4 and every named story mission, in order. These 12 trophies come from playing the main missions: Gone Fishing, the four chapters, the final mission, and the named missions Breakfast Run, The Cartel Heist, Child\u2019s Play, Headliners, VCIA Takedown and Operation Savage Glory.' },
  { stage: 2, title: 'Stage 2 — Missables first, before the finale', blurb: 'Four trophies need a partner, a one-time mission window, or choices that may not come back. Do them before the final mission: Hot Together and Retail Therapy need a partner beside you, Catch Me If You Can belongs at VCIA around the VCIA Takedown mission, and Actions Speak Louder counts choices as they come.' },
  { stage: 3, title: 'Stage 3 — Strangers and contacts', blurb: 'The five contact strands (Andy, Kenton, Billy, Randy, Tyrone), the 8 stranger strands for Strangers & Freaks, and Bret\u2019s unique-animal hunt. Follow the map icons and finish each strand in order.' },
  { stage: 4, title: 'Stage 4 — Activities and challenges', blurb: 'The 9 activity types, 250 stunts, the 42 Shooting Range challenges for gold, the 14 Top Fun drone races, 20 race wins, the fishing challenge against Cal, one arcade game, bowling at Kolt & Associates, and 50 Challenges.' },
  { stage: 5, title: 'Stage 5 — Collectibles and exploration', blurb: '18 meditation spots, 3 Collectible Card sets, WAiNK It at 100 locations, 100 vehicles discovered, all 52 areas of Leonida explored, all 8 garage properties bought, and 10 vehicles registered to the Scooter Bros app.' },
  { stage: 6, title: 'Stage 6 — Money, combat and one-off feats', blurb: 'Combat Focus, the Rhino tanks, the jewelry store, 5 bank vaults, the armored truck, one illegal operation per gang, the Ocean Beach cocktail, the showroom smash, the partnership milestone, the second-try trophy, the strange event, the melee drive-by, $250,000 laundered and $100,000 spent.' },
  { stage: 7, title: 'Stage 7 — 100% completion, then the platinum', blurb: 'A Long Road (100% completion) comes last, because nearly every other trophy feeds into it. The moment it pops, the platinum — Vice Got a Price! — follows.' },
];
