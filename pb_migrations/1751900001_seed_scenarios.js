/// <reference path="../pb_data/types.d.ts" />
// Seeds 7 daily negotiation scenarios. Idempotent: no-op when scenarios already exist.
migrate((app) => {
  const collection = app.findCollectionByNameOrId("scenarios");

  const result = new DynamicModel({ c: 0 });
  app.db().newQuery("SELECT COUNT(*) as c FROM scenarios").one(result);
  if (Number(result.c) > 0) {
    return;
  }

  const scenarios = [
    {
      day_index: 0,
      title: "The Bazaar Rug",
      character_name: "Farid",
      character_persona: "A theatrical rug merchant in a bustling bazaar. Loves haggling as sport, offended by lowballs, softened by compliments about craftsmanship.",
      opening_message: "Ah, friend! You have the eye of a connoisseur. This hand-knotted rug — three years of work! For you, a special price: 400 coins.",
      engine_config: {
        direction: "buy",
        item: "hand-knotted rug",
        currency: "coins",
        opening_price: 400,
        floor_price: 220,
        fair_price: 260,
        patience: 6,
        concession_ladder: [400, 360, 320, 290, 260, 240, 220],
        keywords: {
          flatter: ["beautiful", "craftsmanship", "masterpiece", "artist", "skill", "lovely"],
          insult: ["ripoff", "junk", "ugly", "scam", "cheap trash"],
          walkaway: ["leaving", "walk away", "goodbye", "no deal", "forget it"],
          logic: ["market price", "down the street", "elsewhere", "budget", "other stall"]
        },
        responses: {
          accept: "Sold! You bargain like my grandmother — that is the highest compliment I know.",
          reject_low: "You wound me! That would not cover the wool alone.",
          concede: "Hmm... you drive a hard bargain. Because I like you...",
          walkaway_call: "Wait, wait! Come back — perhaps we can find a middle path.",
          fail: "No, no. We are too far apart, friend. May the wind guide you to lesser rugs."
        }
      },
      scoring_config: { max_score: 100, price_weight: 60, patience_weight: 20, turns_weight: 20 }
    },
    {
      day_index: 1,
      title: "The Used Hatchback",
      character_name: "Denny",
      character_persona: "A fast-talking used-car salesman with a plaid jacket. Responds to concrete flaws in the car, deflects vague complaints.",
      opening_message: "This beauty? One careful owner, barely 90k miles. I can let her go for $6,800 — today only.",
      engine_config: {
        direction: "buy",
        item: "used hatchback",
        currency: "$",
        opening_price: 6800,
        floor_price: 4900,
        fair_price: 5400,
        patience: 6,
        concession_ladder: [6800, 6400, 6000, 5700, 5400, 5100, 4900],
        keywords: {
          flatter: ["great car", "nice ride", "clean", "well kept"],
          insult: ["lemon", "junker", "rust bucket", "scam"],
          walkaway: ["walk away", "leaving", "no deal", "other lot", "goodbye"],
          logic: ["blue book", "mileage", "tires", "brakes", "scratch", "dent", "inspection", "mechanic"]
        },
        responses: {
          accept: "Alright, alright — you got me. Let's sign the papers before I change my mind.",
          reject_low: "Ha! For that money I'll sell you the hubcaps.",
          concede: "Okay, look — I shouldn't do this, but...",
          walkaway_call: "Whoa whoa, hold on! Nobody walks off my lot unhappy.",
          fail: "Sorry pal, can't go that low. Door's that way."
        }
      },
      scoring_config: { max_score: 100, price_weight: 60, patience_weight: 20, turns_weight: 20 }
    },
    {
      day_index: 2,
      title: "The Rent Hike",
      character_name: "Ms. Alvarez",
      character_persona: "A pragmatic landlord raising your rent. Values reliability and long tenancy; annoyed by threats, moved by loyalty and maintenance offers.",
      opening_message: "I'm sorry, but costs are up everywhere. Rent goes to $1,650 next month. That's the market rate now.",
      engine_config: {
        direction: "buy",
        item: "monthly rent",
        currency: "$",
        opening_price: 1650,
        floor_price: 1450,
        fair_price: 1500,
        patience: 5,
        concession_ladder: [1650, 1600, 1550, 1500, 1475, 1450],
        keywords: {
          flatter: ["good tenant", "always on time", "years", "loyal", "take care"],
          insult: ["slumlord", "greedy", "sue", "lawyer"],
          walkaway: ["move out", "leaving", "notice", "find another place"],
          logic: ["vacancy", "market", "repairs", "maintenance", "lease", "sign longer"]
        },
        responses: {
          accept: "Fine. You've been good to this building, and that's worth something. Deal.",
          reject_low: "That's below what I paid in taxes alone. Be serious.",
          concede: "Hmm. An empty unit costs me too... alright, listen.",
          walkaway_call: "Hold on — finding a new tenant is a headache. Let's talk.",
          fail: "Then I'm sorry, the notice stands. Market rate it is."
        }
      },
      scoring_config: { max_score: 100, price_weight: 60, patience_weight: 20, turns_weight: 20 }
    },
    {
      day_index: 3,
      title: "The Raise",
      character_name: "Mr. Bexley",
      character_persona: "Your budget-obsessed boss. Hates vague asks, respects data, achievements, and competing offers. Panics at resignation hints.",
      opening_message: "You wanted to talk compensation? Times are tight, but I can offer a 2% bump. That's $52,000. Best I can do.",
      engine_config: {
        direction: "sell",
        item: "annual salary",
        currency: "$",
        opening_price: 52000,
        floor_price: 60000,
        fair_price: 57000,
        patience: 5,
        concession_ladder: [52000, 54000, 55500, 57000, 58500, 60000],
        keywords: {
          flatter: ["love working here", "great team", "value the company"],
          insult: ["cheap", "exploiting", "insulting", "joke"],
          walkaway: ["resign", "quit", "two weeks", "other offer", "leaving"],
          logic: ["market rate", "shipped", "revenue", "project", "results", "performance", "recruiter"]
        },
        responses: {
          accept: "...Alright. I'll make it work with finance. Don't tell the others.",
          reject_low: "That's way outside the band. HR would laugh me out of the room.",
          concede: "You do have a point about your numbers... let me see.",
          walkaway_call: "Now hold on — replacing you would cost me twice that. Sit down.",
          fail: "I'm sorry, we're done here. The 2% stands."
        }
      },
      scoring_config: { max_score: 100, price_weight: 60, patience_weight: 20, turns_weight: 20 }
    },
    {
      day_index: 4,
      title: "The Vinyl Grail",
      character_name: "Otto",
      character_persona: "A grumpy record-store owner selling a rare pressing. Softens when you show genuine music knowledge, hardens at hype-speak.",
      opening_message: "That one? Original first pressing, near mint. $180, firm. And don't touch the sleeve with those fingers.",
      engine_config: {
        direction: "buy",
        item: "rare first-pressing LP",
        currency: "$",
        opening_price: 180,
        floor_price: 110,
        fair_price: 130,
        patience: 6,
        concession_ladder: [180, 165, 150, 140, 130, 120, 110],
        keywords: {
          flatter: ["collection", "pressing", "matrix", "b-side", "session", "label", "mono"],
          insult: ["overpriced", "discogs is cheaper", "just a record", "rip off"],
          walkaway: ["leaving", "pass", "no deal", "goodbye", "forget it"],
          logic: ["scuff", "sleeve wear", "discogs", "median", "condition", "grade"]
        },
        responses: {
          accept: "Hmph. Fine. At least it's going to someone who'll actually play it.",
          reject_low: "For that you can have the crate of smooth jazz by the door.",
          concede: "You actually know your pressings... alright.",
          walkaway_call: "Hng. Wait. It's been in that bin for two years...",
          fail: "Nope. It'll sell eventually. Close the door behind you."
        }
      },
      scoring_config: { max_score: 100, price_weight: 60, patience_weight: 20, turns_weight: 20 }
    },
    {
      day_index: 5,
      title: "The Alien Souvenir",
      character_name: "Zorblax",
      character_persona: "An alien tourist trying to buy your garden gnome, convinced it is a sacred Earth idol. Overpays wildly at first, offended by dishonesty.",
      opening_message: "EARTHLING. Your lawn deity radiates immense power. I offer 40 galactic credits. Do not attempt deception; my visor detects lies.",
      engine_config: {
        direction: "sell",
        item: "garden gnome",
        currency: "galactic credits",
        opening_price: 40,
        floor_price: 95,
        fair_price: 70,
        patience: 6,
        concession_ladder: [40, 52, 63, 72, 81, 89, 95],
        keywords: {
          flatter: ["mighty", "wise", "great traveler", "honored", "your visor"],
          insult: ["weirdo", "fake", "stupid alien", "probe"],
          walkaway: ["not for sale", "keep it", "no deal", "goodbye"],
          logic: ["rare", "ancient", "handmade", "one of a kind", "ceremonial", "last one"]
        },
        responses: {
          accept: "TRANSACTION COMPLETE. The idol shall be enshrined aboard my vessel. Farewell, shrewd earthling.",
          reject_low: "My visor flashes red. That demand exceeds all galactic reason.",
          concede: "Hmm. My credit reserves are... flexible. I recalculate.",
          walkaway_call: "WAIT. Withdrawing the idol from trade is a hostile act. I shall improve my offer.",
          fail: "Negotiation matrix collapsed. I will find another lawn deity. Engines, engage."
        }
      },
      scoring_config: { max_score: 100, price_weight: 60, patience_weight: 20, turns_weight: 20 }
    },
    {
      day_index: 6,
      title: "The Pirate's Toll",
      character_name: "Captain Marrow",
      character_persona: "A pirate captain demanding a toll to cross her waters. Respects courage and wit, despises groveling, secretly bored and loves entertainment.",
      opening_message: "Avast! These be my waters, sailor. The toll is 100 doubloons — or your boots, and ye swim the rest.",
      engine_config: {
        direction: "buy",
        item: "safe passage",
        currency: "doubloons",
        opening_price: 100,
        floor_price: 45,
        fair_price: 60,
        patience: 5,
        concession_ladder: [100, 88, 75, 65, 55, 45],
        keywords: {
          flatter: ["legend", "feared", "finest captain", "songs about you", "brave"],
          insult: ["coward", "washed up", "navy", "hang"],
          walkaway: ["turn back", "another route", "no deal", "swim"],
          logic: ["small boat", "poor fisherman", "cargo", "storm", "trade", "story", "joke"]
        },
        responses: {
          accept: "HAR! Ye've got salt in yer veins. Pass, sailor — and tell 'em Marrow let ye live.",
          reject_low: "Insult me doubloons again and ye'll be countin' fish instead.",
          concede: "Yarr... ye amuse me, little sailor. Perhaps the toll be negotiable.",
          walkaway_call: "Oi! The other route be full o' rocks and worse pirates. Come back.",
          fail: "Enough! Boots. Off. Start swimmin'."
        }
      },
      scoring_config: { max_score: 100, price_weight: 60, patience_weight: 20, turns_weight: 20 }
    }
  ];

  for (const s of scenarios) {
    const record = new Record(collection);
    record.set("day_index", s.day_index);
    record.set("title", s.title);
    record.set("character_name", s.character_name);
    record.set("character_persona", s.character_persona);
    record.set("opening_message", s.opening_message);
    record.set("engine_config", s.engine_config);
    record.set("scoring_config", s.scoring_config);
    app.save(record);
  }
}, (app) => {
  // down: remove seeded rows
  try {
    app.db().newQuery("DELETE FROM scenarios WHERE day_index BETWEEN 0 AND 6").execute();
  } catch {}
});
