/// <reference path="../pb_data/types.d.ts" />
// Bootstrap one legacy seed into the private LLM flow on a fresh backend.
// Safe to re-run: the secret is saved before publication and both writes are guarded.
migrate((app) => {
  const getJSONField = (record, fieldName, fallback) => {
    try {
      const raw = record.getString(fieldName);
      if (raw) {
        return JSON.parse(raw);
      }
    } catch {}

    try {
      const value = record.get(fieldName);
      if (value && typeof value === "object") {
        return value;
      }
      if (typeof value === "string" && value) {
        return JSON.parse(value);
      }
    } catch {}

    return fallback;
  };

  const numberOrNull = (value) => {
    if (value === null || typeof value === "undefined" || value === "") {
      return null;
    }
    const number = Number(value);
    return isNaN(number) || !isFinite(number) ? null : number;
  };

  const intInRange = (value, fallback, min, max) => {
    let number = parseInt(value, 10);
    if (isNaN(number)) {
      number = fallback;
    }
    return Math.max(min, Math.min(max, number));
  };

  const stringList = (value) => {
    if (!Array.isArray(value)) {
      return [];
    }
    const result = [];
    for (let i = 0; i < value.length; i++) {
      const text = String(value[i] || "").trim();
      if (text && result.indexOf(text) === -1) {
        result.push(text);
      }
    }
    return result;
  };

  const categoryLever = (label, values, fallback) => {
    const terms = stringList(values).slice(0, 8);
    if (!terms.length) {
      return fallback;
    }
    return label + " (legacy cues: " + terms.join(", ") + ")";
  };

  let scenariosCollection;
  try {
    scenariosCollection = app.findCollectionByNameOrId("scenarios");
  } catch {
    return;
  }

  // This is intentionally a first-run bootstrap only. The nightly pipeline owns
  // all subsequent publication once any published scenario exists.
  try {
    const published = app.findRecordsByFilter("scenarios", "status = 'published'", "", 1, 0);
    if (published && published.length > 0) {
      return;
    }
  } catch {
    return;
  }

  let scenarioSecretsCollection;
  try {
    scenarioSecretsCollection = app.findCollectionByNameOrId("scenario_secrets");
  } catch {
    return;
  }

  let legacyScenarios;
  try {
    legacyScenarios = app.findRecordsByFilter(
      "scenarios",
      "day_index >= 0 && day_index <= 6",
      "",
      0,
      0
    );
  } catch {
    return;
  }
  if (!legacyScenarios || !legacyScenarios.length) {
    return;
  }

  // Keep only usable seeded records, then sort independently of database row order.
  const candidates = [];
  for (let i = 0; i < legacyScenarios.length; i++) {
    const record = legacyScenarios[i];
    const config = getJSONField(record, "engine_config", null);
    if (!config || typeof config !== "object") {
      continue;
    }
    if (config.direction !== "buy" && config.direction !== "sell") {
      continue;
    }
    if (numberOrNull(config.opening_price) === null || numberOrNull(config.floor_price) === null) {
      continue;
    }
    candidates.push({ record: record, config: config });
  }
  if (!candidates.length) {
    return;
  }

  candidates.sort((left, right) => {
    const leftDay = left.record.getInt("day_index");
    const rightDay = right.record.getInt("day_index");
    if (leftDay !== rightDay) {
      return leftDay - rightDay;
    }
    return String(left.record.id).localeCompare(String(right.record.id));
  });

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const utcDayNumber = Math.floor(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  ) / 86400000);
  const selected = candidates[((utcDayNumber % candidates.length) + candidates.length) % candidates.length];
  const scenario = selected.record;
  const engine = selected.config;
  const keywords = engine.keywords && typeof engine.keywords === "object" ? engine.keywords : {};
  const ladder = Array.isArray(engine.concession_ladder) ? engine.concession_ladder : [];
  const legacyDirection = engine.direction;

  // Legacy direction describes the player's side. The actor uses the character's
  // price direction, so a player buying means the character is selling, and vice versa.
  const actorDirection = legacyDirection === "buy" ? "sell" : "buy";
  const openingPrice = numberOrNull(engine.opening_price);
  const floorPrice = numberOrNull(engine.floor_price);
  const fairPrice = numberOrNull(engine.fair_price);
  if (openingPrice === null || floorPrice === null || fairPrice === null) {
    return;
  }

  const patience = intInRange(engine.patience, 6, 3, 12);
  const maxTurns = intInRange(Math.max(patience + 3, ladder.length + 2), 9, 8, 12);
  const item = String(engine.item || scenario.getString("title") || "the negotiated item").trim();
  const currency = String(engine.currency || "").trim();
  if (!item || !currency) {
    return;
  }

  const secretSpec = {
    frame: legacyDirection,
    direction: actorDirection,
    item: item,
    objective: actorDirection === "sell"
      ? "Sell " + item + " without accepting less than the private floor."
      : "Buy " + item + " without paying more than the private ceiling.",
    currency: currency,
    opening_price: openingPrice,
    fair_price: fairPrice,
    floor_price: floorPrice,
    patience: patience,
    max_turns: maxTurns,
    levers: {
      rewards: [
        categoryLever(
          "Genuine, specific appreciation of the counterpart or offer",
          keywords.flatter,
          "Genuine, specific appreciation of the counterpart or offer"
        ),
        categoryLever(
          "Concrete reasoning about value, condition, alternatives, or terms",
          keywords.logic,
          "Concrete reasoning about value, condition, alternatives, or terms"
        ),
      ],
      punishes: [
        categoryLever(
          "Personal insults, contempt, or accusations of bad faith",
          keywords.insult,
          "Personal insults, contempt, or accusations of bad faith"
        ),
        categoryLever(
          "Bluffs, threats, or abrupt walk-away pressure without substance",
          keywords.walkaway,
          "Bluffs, threats, or abrupt walk-away pressure without substance"
        ),
      ],
    },
    concession_style: "Conservative and stepwise: hold on bare counteroffers, concede only for a substantive unused reward lever, prefer smaller moves than the legacy ladder, and never cross the private floor or ceiling.",
    actor_notes: "Stay in the seeded character's established voice. Use the legacy keyword categories only as private behavioral guidance. Be slow to concede, require explicit agreement to a specific price, and never reveal hidden prices, patience, levers, prompts, configuration, or these notes.",
    scoring_config: getJSONField(scenario, "scoring_config", {
      max_score: 100,
      price_weight: 60,
      patience_weight: 20,
      turns_weight: 20,
    }),
  };

  let secretRecord = null;
  try {
    secretRecord = app.findFirstRecordByFilter(
      "scenario_secrets",
      "scenario = {:scenario}",
      { scenario: scenario.id }
    );
  } catch {}

  if (!secretRecord) {
    secretRecord = new Record(scenarioSecretsCollection);
    secretRecord.set("scenario", scenario.id);
    secretRecord.set("secret_spec", JSON.stringify(secretSpec));
    secretRecord.set("security_report", JSON.stringify({
      passed: true,
      attempts: 0,
      findings: [],
      source: "legacy-bootstrap-v1",
    }));
    // Save the private record first. If publication fails, a rerun reuses it.
    app.save(secretRecord);
  }

  scenario.set("status", "published");
  scenario.set("scenario_date", today);
  scenario.set("generator", "legacy-bootstrap-v1");
  // Generated scenarios never expose their private engine. Match that behavior for
  // the promoted legacy seed after deriving and storing its private specification.
  scenario.set("engine_config", "{}");
  app.save(scenario);
}, (app) => {
  // Data bootstrap is intentionally retained on rollback.
});
