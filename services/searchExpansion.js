import { normalizeSearchText, searchTokens } from "../lib/searchRelevance.js";

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9.+-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function words(value) {
  return normalize(value).split(" ").filter(Boolean);
}

function stableHash(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

const BANKS = {
  "Aquarium": [
    {
      key: "filtration",
      keywords: ["filter", "canister", "hob", "sponge", "media"],
      bases: [
        "aquarium canister filter",
        "aquarium hob power filter",
        "aquarium sponge filter",
        "aquarium internal filter",
        "aquarium filter media",
      ],
      modifiers: ["quiet", "high flow", "nano tank", "large tank", "replacement media"],
    },
    {
      key: "aeration",
      keywords: ["air", "pump", "aeration", "stone"],
      bases: ["aquarium air pump", "aquarium air stone", "aquarium aeration kit"],
      modifiers: ["quiet", "dual outlet", "battery backup", "large tank"],
    },
    {
      key: "heating",
      keywords: ["heater", "thermostat", "temperature"],
      bases: ["aquarium heater", "aquarium temperature controller", "aquarium thermometer"],
      modifiers: ["digital", "submersible", "100w", "200w", "300w"],
    },
    {
      key: "lighting",
      keywords: ["light", "lighting", "led", "planted"],
      bases: ["aquarium led light", "planted aquarium light", "aquarium full spectrum light"],
      modifiers: ["timer", "24 7", "dimmable", "rgb", "freshwater"],
    },
    {
      key: "co2",
      keywords: ["co2", "regulator", "diffuser"],
      bases: ["aquarium co2 regulator", "aquarium co2 diffuser", "aquarium co2 kit"],
      modifiers: ["dual stage", "solenoid", "inline", "nano"],
    },
    {
      key: "circulation",
      keywords: ["wavemaker", "circulation", "powerhead"],
      bases: ["aquarium wavemaker", "aquarium circulation pump", "aquarium powerhead"],
      modifiers: ["controllable", "dc", "quiet", "magnetic"],
    },
  ],
  "Automotive": [
    {
      key: "timing",
      keywords: ["timing", "ignition", "strobe", "light"],
      bases: [
        "automotive timing light",
        "ignition timing light",
        "inductive timing light",
        "engine timing light",
      ],
      modifiers: ["digital", "advance", "12v", "tachometer"],
    },
    {
      key: "hand-tools",
      keywords: ["crowfoot", "wrench", "socket", "ratchet", "set"],
      bases: [
        "crowfoot wrench set",
        "crow foot wrench set",
        "automotive crowfoot wrench set",
        "flare nut wrench set",
      ],
      modifiers: ["sae", "metric", "3 8 drive", "1 2 drive"],
    },
    {
      key: "diagnostics",
      keywords: ["obd2", "scanner", "diagnostic", "bidirectional", "code"],
      bases: ["obd2 scanner", "bidirectional scan tool", "automotive diagnostic scanner", "obd2 code reader"],
      modifiers: ["abs srs", "live data", "bluetooth", "tpms", "full system"],
    },
    {
      key: "battery",
      keywords: ["battery", "jump", "starter", "charging"],
      bases: ["automotive battery tester", "portable car jump starter", "car battery charger"],
      modifiers: ["12v", "agm", "lifepo4", "2000a", "3000a"],
    },
    {
      key: "electrical",
      keywords: ["multimeter", "electrical", "circuit", "probe"],
      bases: ["automotive multimeter", "automotive circuit tester", "power probe automotive"],
      modifiers: ["digital", "true rms", "12v 24v", "clamp meter"],
    },
    {
      key: "torque",
      keywords: ["torque", "wrench"],
      bases: ["digital torque wrench", "click torque wrench", "electronic torque adapter"],
      modifiers: ["3 8 drive", "1 2 drive", "inch pound", "foot pound"],
    },
    {
      key: "tpms",
      keywords: ["tpms", "relearn"],
      bases: ["tpms relearn tool", "tpms programming tool", "tpms diagnostic tool"],
      modifiers: ["universal", "sensor activation", "obd2"],
    },
    {
      key: "brakes",
      keywords: ["brake", "bleeder", "vacuum"],
      bases: ["brake bleeder kit", "vacuum brake bleeder", "brake fluid pressure bleeder"],
      modifiers: ["one man", "pneumatic", "master cylinder"],
    },
  ],
  "Power Tools": [
    {
      key: "impact",
      keywords: ["impact", "wrench", "driver"],
      bases: ["cordless impact wrench", "brushless impact wrench", "cordless impact driver"],
      modifiers: ["1 2 inch", "3 8 inch", "high torque", "compact", "battery kit"],
    },
    {
      key: "drill",
      keywords: ["drill", "driver"],
      bases: ["brushless drill driver", "cordless hammer drill", "cordless drill kit"],
      modifiers: ["compact", "20v", "18v", "battery kit", "tool only"],
    },
    {
      key: "cutting",
      keywords: ["saw", "circular", "reciprocating", "oscillating"],
      bases: ["cordless circular saw", "cordless reciprocating saw", "oscillating multi tool"],
      modifiers: ["brushless", "compact", "tool only", "battery kit"],
    },
    {
      key: "grinding",
      keywords: ["grinder", "angle"],
      bases: ["cordless angle grinder", "brushless angle grinder"],
      modifiers: ["4 1 2 inch", "5 inch", "tool only", "battery kit"],
    },
    {
      key: "batteries",
      keywords: ["battery", "charger"],
      bases: ["power tool battery", "power tool battery charger", "dual port tool battery charger"],
      modifiers: ["4ah", "5ah", "6ah", "fast charger"],
    },
  ],
  "3D Printing": [
    {
      key: "filament",
      keywords: ["filament", "petg", "pla", "abs", "tpu", "asa"],
      bases: [
        "petg filament 1.75mm",
        "pla filament 1.75mm",
        "abs filament 1.75mm",
        "tpu flexible filament 1.75mm",
        "asa filament 1.75mm",
      ],
      modifiers: ["1kg spool", "2kg bundle", "high speed", "matte", "silk", "multi color", "8 pack 250g"],
    },
    {
      key: "drying",
      keywords: ["dryer", "dry", "storage"],
      bases: ["3d printer filament dryer", "filament dry box", "filament storage vacuum kit"],
      modifiers: ["dual spool", "heated", "humidity sensor", "large spool"],
    },
    {
      key: "build-surface",
      keywords: ["pei", "plate", "bed", "build"],
      bases: ["3d printer pei build plate", "spring steel build plate", "textured pei sheet"],
      modifiers: ["magnetic", "double sided", "235x235", "310x310"],
    },
    {
      key: "hotend",
      keywords: ["hotend", "nozzle", "extruder"],
      bases: ["3d printer hotend", "hardened steel nozzle", "high flow nozzle", "direct drive extruder"],
      modifiers: ["all metal", "high flow", "0.4mm", "0.6mm", "volcano"],
    },
    {
      key: "enclosure",
      keywords: ["enclosure", "tent"],
      bases: ["3d printer enclosure", "fireproof 3d printer enclosure"],
      modifiers: ["large", "vented", "with led", "temperature controlled"],
    },
    {
      key: "resin",
      keywords: ["resin", "wash", "cure"],
      bases: ["resin printer wash cure station", "resin 3d printer wash station", "uv resin curing station"],
      modifiers: ["large", "2 in 1", "dual function"],
    },
  ],
  "PC Accessories": [
    {
      key: "keyboard",
      keywords: ["keyboard", "mechanical", "hotswap", "hot", "swap"],
      bases: ["mechanical keyboard", "hot swap mechanical keyboard", "low profile mechanical keyboard"],
      modifiers: ["75 percent", "65 percent", "wireless", "rgb", "aluminum"],
    },
    {
      key: "mouse",
      keywords: ["mouse", "gaming"],
      bases: ["gaming mouse", "lightweight gaming mouse", "wireless gaming mouse"],
      modifiers: ["ultralight", "high polling rate", "ergonomic", "rechargeable"],
    },
    {
      key: "dock",
      keywords: ["dock", "docking", "hub"],
      bases: ["usb c docking station", "thunderbolt dock", "usb c hub"],
      modifiers: ["dual monitor", "triple monitor", "100w power delivery", "2.5gbe"],
    },
    {
      key: "storage",
      keywords: ["nvme", "ssd", "enclosure"],
      bases: ["nvme ssd enclosure", "usb c nvme enclosure", "m2 ssd enclosure"],
      modifiers: ["10gbps", "20gbps", "thunderbolt", "tool free"],
    },
    {
      key: "networking",
      keywords: ["wifi", "pcie", "ethernet"],
      bases: ["pcie wifi card", "wifi 6e pcie card", "usb ethernet adapter"],
      modifiers: ["bluetooth", "2.5gbe", "wifi 7"],
    },
    {
      key: "desk",
      keywords: ["monitor", "arm", "microphone", "webcam"],
      bases: ["monitor arm", "dual monitor arm", "usb microphone", "usb webcam"],
      modifiers: ["gas spring", "heavy duty", "4k", "boom arm"],
    },
  ],
  "USB-C Charging": [
    {
      key: "gan",
      keywords: ["gan", "charger", "65w", "100w"],
      bases: ["usb c gan charger", "65w usb c gan charger", "100w usb c gan charger", "140w usb c gan charger"],
      modifiers: ["dual port", "3 port", "compact", "pps", "laptop"],
    },
    {
      key: "cable",
      keywords: ["cable", "100w", "240w"],
      bases: ["100w usb c cable", "240w usb c cable", "usb c to usb c cable"],
      modifiers: ["6ft", "10ft", "braided", "e marker", "usb4"],
    },
    {
      key: "power-bank",
      keywords: ["power", "bank", "powerbank"],
      bases: ["usb c power bank", "100w usb c power bank", "140w usb c power bank"],
      modifiers: ["20000mah", "25000mah", "laptop", "built in cable"],
    },
    {
      key: "car",
      keywords: ["car", "charger"],
      bases: ["usb c car charger", "pd car charger", "usb c car charger dual port"],
      modifiers: ["45w", "65w", "100w", "pps"],
    },
    {
      key: "station",
      keywords: ["station", "multiport", "charging"],
      bases: ["multiport usb c charger", "usb c charging station", "desktop usb c charger"],
      modifiers: ["200w", "300w", "6 port", "gan"],
    },
  ],
  "Portable Power": [
    {
      key: "station",
      keywords: ["station", "power"],
      bases: ["portable power station", "lifepo4 portable power station", "solar generator"],
      modifiers: ["300w", "500w", "1000w", "1500w", "2000w", "ups"],
    },
    {
      key: "solar",
      keywords: ["solar", "panel"],
      bases: ["portable solar panel", "foldable solar panel", "solar panel for power station"],
      modifiers: ["100w", "200w", "400w", "waterproof", "mc4"],
    },
    {
      key: "expansion",
      keywords: ["expansion", "battery"],
      bases: ["power station expansion battery", "portable power expansion battery"],
      modifiers: ["lifepo4", "extra battery", "battery pack"],
    },
    {
      key: "charging",
      keywords: ["charging", "charger", "alternator", "dc"],
      bases: ["power station car charger", "alternator charger power station", "dc charging cable power station"],
      modifiers: ["fast charging", "12v", "24v"],
    },
    {
      key: "inverter",
      keywords: ["inverter"],
      bases: ["pure sine wave inverter", "portable power inverter"],
      modifiers: ["1000w", "2000w", "3000w", "12v"],
    },
  ],
};

function familyScore(queryWords, family) {
  const keys = new Set(family.keywords.map(normalize));
  let score = 0;
  for (const word of queryWords) {
    if (keys.has(word)) score += 3;
    if (family.key.includes(word)) score += 1;
  }

  const normalizedBases = family.bases.map(normalize);
  for (const base of normalizedBases) {
    for (const word of queryWords) {
      if (base.includes(word)) score += 0.2;
    }
  }
  return score;
}

function buildFamilyCandidates(family) {
  const candidates = [];
  for (const base of family.bases) {
    candidates.push(base);
    for (const modifier of family.modifiers) {
      candidates.push(`${base} ${modifier}`);
    }
  }
  return candidates;
}

export function generateRelatedSearches({
  query,
  category,
  familyKey = "",
  existingQueries = [],
  limit = 2,
} = {}) {
  const bank = BANKS[String(category || "")] || [];
  if (!bank.length) return [];

  const normalizedExisting = new Set(existingQueries.map(normalize));
  const queryWords = words(query);

  let families = bank.slice();

  if (familyKey) {
    const exact = bank.find(family => family.key === familyKey);
    if (exact) {
      families = [exact, ...bank.filter(family => family.key !== exact.key)];
    }
  } else {
    families.sort((a, b) => {
      const scoreDiff = familyScore(queryWords, b) - familyScore(queryWords, a);
      return scoreDiff || a.key.localeCompare(b.key);
    });
  }

  const ranked = [];
  for (let familyIndex = 0; familyIndex < families.length; familyIndex++) {
    const family = families[familyIndex];
    const candidates = buildFamilyCandidates(family);

    for (const phrase of candidates) {
      const normalizedPhrase = normalize(phrase);
      if (!normalizedPhrase || normalizedExisting.has(normalizedPhrase)) continue;

      const overlap = words(phrase).filter(word => queryWords.includes(word)).length;
      const hash = stableHash(`${normalize(query)}|${family.key}|${normalizedPhrase}`);

      ranked.push({
        query: phrase,
        category,
        familyKey: family.key,
        relationScore: overlap * 1000 - familyIndex * 100 + (hash % 97),
      });
    }
  }

  ranked.sort((a, b) =>
    b.relationScore - a.relationScore ||
    a.query.localeCompare(b.query)
  );

  const selected = [];
  const seen = new Set();
  for (const candidate of ranked) {
    const key = normalize(candidate.query);
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push({
      query: candidate.query,
      category: candidate.category,
      familyKey: candidate.familyKey,
    });
    if (selected.length >= Math.max(1, Number(limit) || 2)) break;
  }

  return selected;
}

export function availableSearchFamilies(category) {
  return (BANKS[String(category || "")] || []).map(family => family.key);
}


function phrasePreservesOriginalIntent(originalQuery, candidateQuery) {
  const required = [...new Set(searchTokens(originalQuery))];
  if (!required.length) return false;
  const candidate = new Set(searchTokens(candidateQuery));
  return required.every(token => candidate.has(token));
}

function precisionFamilyScore(query, categoryName, family) {
  const q = [...new Set(searchTokens(query))];
  if (!q.length) return 0;
  const keywords = new Set((family.keywords || []).flatMap(searchTokens));
  const bases = (family.bases || []).map(value => new Set(searchTokens(value)));

  let matchedKeywords = 0;
  let matchedBases = 0;
  for (const token of q) {
    if (keywords.has(token)) matchedKeywords++;
    if (bases.some(tokens => tokens.has(token))) matchedBases++;
  }

  // Prefer families that recognize more than one part of a multi-term query.
  // This keeps generic words such as "light" from deciding the domain alone.
  const coverage = matchedKeywords / q.length;
  return matchedKeywords * 8 + matchedBases * 2 + coverage * 10;
}

/**
 * Conservative marketplace recall plan for an interactive shopper query.
 *
 * Every generated query retains every meaningful token from the shopper's
 * original request. Discovery is allowed to add context; it is never allowed
 * to delete or substitute the requested concepts. Candidates are still judged
 * against the ORIGINAL query by searchRelevance() before ingestion/publication.
 */
export function generatePrecisionSearchVariants({
  query,
  category = "",
  limit = 6,
} = {}) {
  const original = String(query || "").trim();
  if (!original) return [];

  const cap = Math.min(Math.max(Number(limit || 6), 1), 12);
  const output = [];
  const seen = new Set();
  const add = (value, reason = "recall") => {
    const clean = String(value || "").replace(/\s+/g, " ").trim();
    const key = normalizeSearchText(clean);
    if (!clean || !key || seen.has(key)) return;
    if (!phrasePreservesOriginalIntent(original, clean)) return;
    seen.add(key);
    output.push({ query: clean, reason });
  };

  add(original, "original");

  const requestedCategory = String(category || "").trim();
  if (requestedCategory) {
    add(`${original} ${requestedCategory}`, "selected-category-context");
  }

  const families = [];
  for (const [categoryName, bank] of Object.entries(BANKS)) {
    if (requestedCategory && categoryName !== requestedCategory) continue;
    for (const family of bank) {
      let score = precisionFamilyScore(original, categoryName, family);
      if (requestedCategory && categoryName === requestedCategory) score += 12;
      if (score > 0) families.push({ categoryName, family, score });
    }
  }

  families.sort((a, b) => b.score - a.score || a.categoryName.localeCompare(b.categoryName));

  const qTokenCount = new Set(searchTokens(original)).size;
  for (const { categoryName, family, score } of families.slice(0, 4)) {
    if (!requestedCategory && qTokenCount < 2) continue;
    if (score < 16) continue;

    // Only infer a category for multi-term queries when a family recognizes
    // enough of the request to be meaningful. A lone generic token like
    // "light" should not suddenly become an aquarium or automotive search.
    if (!requestedCategory && qTokenCount >= 2 && score >= 16) {
      add(`${original} ${categoryName}`, "inferred-category-context");
    }

    for (const base of family.bases || []) {
      add(base, `family:${categoryName}:${family.key}`);
      if (output.length >= cap) return output;
    }

    for (const modifier of (family.modifiers || []).slice(0, 3)) {
      add(`${original} ${modifier}`, `modifier:${categoryName}:${family.key}`);
      if (output.length >= cap) return output;
    }
  }

  return output.slice(0, cap);
}
