// Interior Weights Editor - client-side state, live odds calc, pagination, download.

// Same defaults as balance_interior_weights.py's CONFIG section - only used
// to prefill the percent inputs; each can be edited before clicking Apply.
const DEFAULT_LEVEL_MODDED_CHANCE_PERCENT = {
  Experimentation: 5, Assurance: 5, Vow: 5,
  March: 10, Adamance: 10, Offense: 10,
  Embrion: 15, Rend: 15, Dine: 15, Titan: 15,
  Artifice: 20,
};
const DEFAULT_VANILLA_LEVEL_MODDED_CHANCE_PERCENT = 0;
const DEFAULT_MODDED_LEVEL_MODDED_CHANCE_PERCENT = 50;

const state = {
  levels: [],            // [{ name, category }]
  dungeons: [],           // [{ name, category, dynamicTagWeights }]
  injectDynamicWeights: true,
  injectDynamicWeightsDefault: true,
  weightsByDungeonLevel: {}, // { dungeonName: { levelName: weight } }
  defaultWeightsByDungeonLevel: {},
  interiorNames: [],
  currentLevelIndex: 0,
  resetToDefaultRequested: false,
  cleanReferencesRequested: false,
  blacklist: [], // lowercased interior names and/or dynamic tags
};

function levelTags(category) {
  return category.startsWith("Vanilla") ? ["Vanilla"] : ["Custom", "Modded"];
}

function parseBlacklistInput(raw) {
  return raw
    .split(/[,\n]/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

// An interior is blacklisted if the list contains its exact name, or any
// one of the tags it's configured with in its Dynamic Level Tags List.
function isBlacklisted(dungeonName) {
  if (state.blacklist.length === 0) return false;
  const dungeon = state.dungeons.find((d) => d.name === dungeonName);
  const nameLower = dungeonName.toLowerCase();
  return state.blacklist.some((entry) => {
    if (entry === nameLower) return true;
    return dungeon ? Object.keys(dungeon.dynamicTagWeights).some((tag) => tag.toLowerCase() === entry) : false;
  });
}

function setStatus(message) {
  document.getElementById("status").textContent = message;
}

function indexWeights(rawWeights) {
  const result = {};
  for (const [interiorName, entries] of Object.entries(rawWeights)) {
    result[interiorName] = {};
    for (const entry of entries) {
      result[interiorName][entry.level] = entry.weight;
    }
  }
  return result;
}

async function loadData() {
  setStatus("Loading...");
  const res = await fetch("/api/data");
  const data = await res.json();
  if (data.error) {
    setStatus(`Error: ${data.error}`);
    return;
  }

  state.levels = data.levels;
  state.dungeons = data.dungeons;
  state.injectDynamicWeights = data.injectDynamicWeights;
  state.injectDynamicWeightsDefault = data.injectDynamicWeightsDefault;
  state.interiorNames = Object.keys(data.weights);
  state.weightsByDungeonLevel = indexWeights(data.weights);
  state.defaultWeightsByDungeonLevel = indexWeights(data.defaultWeights || {});

  document.getElementById("injectDynamicToggle").checked = state.injectDynamicWeights;
  populateBalanceTable();
  populateLevelSelect();
  renderLevelPage();
  setStatus("");
}

function dynamicTagWeightFor(dungeonName, tag) {
  const dungeon = state.dungeons.find((d) => d.name === dungeonName);
  const raw = dungeon ? (dungeon.dynamicTagWeights[tag] || 0) : 0;
  return clampWeight(raw);
}

// LethalLevelLoader takes the single HIGHEST matching rarity across all of
// a level's tags, not a sum (GetHighestRarityViaMatchingNormalizedStrings
// only ever replaces its running value with a higher one), and the overall
// effective weight (see computeOddsForLevel) is likewise a MAX of the
// manual and dynamic components, never their sum.
function dynamicComponentFor(dungeonName, tags) {
  if (!state.injectDynamicWeights) return 0;
  return tags.reduce((max, tag) => Math.max(max, dynamicTagWeightFor(dungeonName, tag)), 0);
}

// LethalLevelLoader parses every weight with C#'s int.TryParse and clamps
// it to [0, 9999] (ConfigHelper.ConvertToStringWithRarityList) - a decimal
// value silently fails to parse and becomes 0 in-game. Rounding/clamping
// here keeps the live preview honest about what will actually happen once
// a value is written out and read back in by the real game.
function clampWeight(value) {
  return Math.max(0, Math.min(9999, Math.round(value)));
}

// Recompute {dungeonName: percentage} for a single level, across ALL interiors -
// same formula as dungeon_odds_tool.py's compute_odds(): effective weight is
// the MAX of a dungeon's manual weight and its dynamic tag weight for this
// level, never their sum (confirmed from LevelMatchingProperties.
// GetDynamicRarity / MatchingProperties.UpdateRarity).
function computeOddsForLevel(levelName, category) {
  const tags = levelTags(category);
  const weights = {};

  for (const dungeonName of state.interiorNames) {
    if (isBlacklisted(dungeonName)) continue;
    const manualRaw = (state.weightsByDungeonLevel[dungeonName] || {})[levelName] || 0;
    const manual = clampWeight(manualRaw);
    const dynamic = dynamicComponentFor(dungeonName, tags);
    const effective = Math.max(manual, dynamic);
    if (effective > 0) weights[dungeonName] = effective;
  }

  const grandTotal = Object.values(weights).reduce((a, b) => a + b, 0);
  if (grandTotal <= 0) return {};
  const odds = {};
  for (const [name, weight] of Object.entries(weights)) {
    odds[name] = (weight / grandTotal) * 100;
  }
  return odds;
}

function populateBalanceTable() {
  const tbody = document.getElementById("balanceTableBody");
  tbody.innerHTML = "";
  for (const level of state.levels) {
    const row = document.createElement("tr");

    const nameCell = document.createElement("td");
    nameCell.textContent = level.name;
    row.appendChild(nameCell);

    const percentCell = document.createElement("td");
    const input = document.createElement("input");
    input.type = "number";
    input.step = "any";
    input.min = "0";
    input.max = "99";
    const isVanilla = level.category.startsWith("Vanilla");
    const defaultPercent = level.name in DEFAULT_LEVEL_MODDED_CHANCE_PERCENT
      ? DEFAULT_LEVEL_MODDED_CHANCE_PERCENT[level.name]
      : (isVanilla ? DEFAULT_VANILLA_LEVEL_MODDED_CHANCE_PERCENT : DEFAULT_MODDED_LEVEL_MODDED_CHANCE_PERCENT);
    input.value = defaultPercent;
    input.dataset.level = level.name;
    percentCell.appendChild(input);
    row.appendChild(percentCell);

    tbody.appendChild(row);
  }
}

function populateLevelSelect() {
  const select = document.getElementById("levelSelect");
  select.innerHTML = "";
  state.levels.forEach((level, index) => {
    const option = document.createElement("option");
    option.value = index;
    option.textContent = level.name;
    select.appendChild(option);
  });
}

function renderLevelPage() {
  const total = state.levels.length;
  if (total === 0) return;
  state.currentLevelIndex = ((state.currentLevelIndex % total) + total) % total;
  const level = state.levels[state.currentLevelIndex];

  document.getElementById("levelSelect").value = state.currentLevelIndex;
  document.getElementById("levelPageLabel").textContent = `${state.currentLevelIndex + 1} of ${total}`;

  const tbody = document.getElementById("levelWeightsBody");
  tbody.innerHTML = "";

  for (const interiorName of state.interiorNames) {
    const row = document.createElement("tr");
    row.dataset.interior = interiorName;
    row.classList.toggle("blacklisted", isBlacklisted(interiorName));

    const nameCell = document.createElement("td");
    nameCell.textContent = interiorName;
    row.appendChild(nameCell);

    const weightCell = document.createElement("td");
    const input = document.createElement("input");
    input.type = "number";
    input.step = "any";
    input.value = (state.weightsByDungeonLevel[interiorName] || {})[level.name] ?? 0;
    input.addEventListener("input", () => {
      const value = parseFloat(input.value);
      if (!state.weightsByDungeonLevel[interiorName]) state.weightsByDungeonLevel[interiorName] = {};
      state.weightsByDungeonLevel[interiorName][level.name] = Number.isFinite(value) ? value : 0;
      updateLevelOddsColumn();
    });
    weightCell.appendChild(input);
    row.appendChild(weightCell);

    const oddsCell = document.createElement("td");
    oddsCell.className = "level-odds-cell";
    oddsCell.dataset.interior = interiorName;
    row.appendChild(oddsCell);

    tbody.appendChild(row);
  }

  updateLevelOddsColumn();
}

// Grows past 2 decimals when needed so a tiny-but-nonzero odds value (e.g. a
// dungeon with no dynamic tag weight competing against ones that have a large
// one) doesn't get rounded down to a misleading "0.00%".
function formatPercentage(value) {
  if (value <= 0) return "0.00%";
  for (let decimals = 2; decimals <= 6; decimals++) {
    const fixed = value.toFixed(decimals);
    if (parseFloat(fixed) > 0) return `${fixed}%`;
  }
  return `${value.toFixed(6)}%`;
}

function updateLevelOddsColumn() {
  const level = state.levels[state.currentLevelIndex];
  if (!level) return;
  const odds = computeOddsForLevel(level.name, level.category);
  for (const cell of document.querySelectorAll("#levelWeightsBody .level-odds-cell")) {
    const percentage = odds[cell.dataset.interior] || 0;
    cell.textContent = formatPercentage(percentage);
  }
}

function goToLevelPage(delta) {
  state.currentLevelIndex += delta;
  renderLevelPage();
}

// Same math as balance_interior_weights.py's main(), ported to run live in
// the browser against the currently edited weights + toggle state.
// Vanilla level to copy vanilla-dungeon weights from when a level has none
// configured at all (e.g. March has no entry in any of the 3 vanilla dungeon
// sections' Manual Level Names List, so its real vanilla weight is 0 and the
// "target modded %" can never be reflected in the actual odds otherwise).
const VANILLA_WEIGHT_TEMPLATE_LEVEL = "Adamance";

function applyBalance() {
  const vanillaDungeons = state.dungeons.filter((d) => d.category === "Vanilla Dungeon" && !isBlacklisted(d.name)).map((d) => d.name);
  const moddedDungeons = state.dungeons.filter((d) => d.category === "Custom Dungeon" && !isBlacklisted(d.name)).map((d) => d.name);

  const percentInputs = document.querySelectorAll("#balanceTableBody input[type='number']");
  const percentByLevel = {};
  for (const input of percentInputs) {
    const value = parseFloat(input.value);
    percentByLevel[input.dataset.level] = Number.isFinite(value) ? value : 0;
  }

  let clampedAnyWeight = false;

  for (const level of state.levels) {
    const tags = levelTags(level.category);
    let percent = percentByLevel[level.name] ?? 0;
    if (percent >= 100) percent = 99;
    const p = Math.max(percent, 0) / 100;

    // Vanilla dungeons with literally no configured weight for this level
    // (e.g. no Manual Level Names List entry at all) start from a copied
    // template so there's something to scale.
    const manualVanillaTotal = vanillaDungeons.reduce((sum, d) => sum + ((state.weightsByDungeonLevel[d] || {})[level.name] || 0), 0);
    if (manualVanillaTotal <= 0 && level.name !== VANILLA_WEIGHT_TEMPLATE_LEVEL) {
      for (const d of vanillaDungeons) {
        const templateWeight = (state.weightsByDungeonLevel[d] || {})[VANILLA_WEIGHT_TEMPLATE_LEVEL] || 0;
        if (!state.weightsByDungeonLevel[d]) state.weightsByDungeonLevel[d] = {};
        state.weightsByDungeonLevel[d][level.name] = clampWeight(templateWeight);
      }
    }

    if (p <= 0) {
      // LethalLevelLoader always takes MAX(manual, dynamic), so a modded
      // dungeon with its own dynamic tag weight can never be pushed to a
      // true 0% this way - but zeroing the manual weight is the closest
      // this tool can get, and matches dungeons that have no dynamic
      // weight at all.
      for (const d of moddedDungeons) {
        if (!state.weightsByDungeonLevel[d]) state.weightsByDungeonLevel[d] = {};
        state.weightsByDungeonLevel[d][level.name] = 0;
      }
      continue;
    }

    // LethalLevelLoader takes the MAX of a dungeon's manual weight and its
    // dynamic tag weight for this level - never a sum - so the only way to
    // give every modded dungeon the exact same effective weight is to set
    // each one's manual weight to a value at least as high as the largest
    // dynamic tag weight among them. That guarantees the manual weight
    // "wins" the MAX for every modded dungeon, making them all truly equal.
    const moddedDynamicWeights = moddedDungeons.map((d) => dynamicComponentFor(d, tags));
    const moddedFloor = moddedDynamicWeights.length ? Math.max(...moddedDynamicWeights, 1) : 1;
    const perDungeonWeight = clampWeight(moddedFloor);
    if (perDungeonWeight !== moddedFloor) clampedAnyWeight = true;
    const actualModdedEffectiveTotal = perDungeonWeight * moddedDungeons.length;

    // Vanilla dungeons keep their existing relative ratio (or the copied
    // template ratio above), scaled so their total hits whatever's needed
    // to make the modded share equal the requested percentage. Vanilla
    // dungeons in this cfg never carry a dynamic tag weight of their own,
    // so their effective weight is just their (now scaled) manual weight.
    const vanillaManualBeforeScale = vanillaDungeons.reduce((sum, d) => sum + ((state.weightsByDungeonLevel[d] || {})[level.name] || 0), 0);
    const requiredVanillaTotal = (actualModdedEffectiveTotal * (1 - p)) / p;
    const scale = vanillaManualBeforeScale > 0 ? requiredVanillaTotal / vanillaManualBeforeScale : 0;
    for (const d of vanillaDungeons) {
      if (!state.weightsByDungeonLevel[d]) state.weightsByDungeonLevel[d] = {};
      const current = state.weightsByDungeonLevel[d][level.name] || 0;
      const updated = vanillaManualBeforeScale > 0
        ? current * scale
        : (vanillaDungeons.length ? requiredVanillaTotal / vanillaDungeons.length : 0);
      const clamped = clampWeight(updated);
      if (clamped !== Math.round(updated)) clampedAnyWeight = true;
      state.weightsByDungeonLevel[d][level.name] = clamped;
    }

    for (const d of moddedDungeons) {
      if (!state.weightsByDungeonLevel[d]) state.weightsByDungeonLevel[d] = {};
      state.weightsByDungeonLevel[d][level.name] = perDungeonWeight;
    }
  }

  // Blacklisted interiors are always forced to 0, overriding anything else
  // applied above.
  for (const interiorName of state.interiorNames) {
    if (!isBlacklisted(interiorName)) continue;
    if (!state.weightsByDungeonLevel[interiorName]) state.weightsByDungeonLevel[interiorName] = {};
    for (const level of state.levels) {
      state.weightsByDungeonLevel[interiorName][level.name] = 0;
    }
  }

  renderLevelPage();
  setStatus(
    clampedAnyWeight
      ? "Balanced modded weights applied (some weights hit the game's 9999 cap, so their exact target % may not be reachable)."
      : "Balanced modded weights applied."
  );
}

function applyResetToDefault() {
  state.injectDynamicWeights = state.injectDynamicWeightsDefault;
  document.getElementById("injectDynamicToggle").checked = state.injectDynamicWeights;
  for (const interiorName of state.interiorNames) {
    state.weightsByDungeonLevel[interiorName] = { ...(state.defaultWeightsByDungeonLevel[interiorName] || {}) };
  }
  state.resetToDefaultRequested = true;
  renderLevelPage();
  setStatus("Reset weights and dynamic weight toggle to defaults (all other settings will also reset on download).");
}

function applyCleanReferences() {
  state.cleanReferencesRequested = true;
  setStatus("Uninstalled level references will be removed on download.");
}

async function downloadCfg() {
  setStatus("Generating .cfg...");
  const weights = {};
  for (const interiorName of state.interiorNames) {
    const blacklisted = isBlacklisted(interiorName);
    weights[interiorName] = state.levels.map((level) => ({
      level: level.name,
      weight: blacklisted ? 0 : ((state.weightsByDungeonLevel[interiorName] || {})[level.name] ?? 0),
    }));
  }

  const res = await fetch("/api/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      resetToDefault: state.resetToDefaultRequested,
      cleanReferences: state.cleanReferencesRequested,
      injectDynamicWeights: state.injectDynamicWeights,
      weights,
    }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    setStatus(`Error: ${data.error || res.statusText}`);
    return;
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "LethalLevelLoader.custom.cfg";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  setStatus("Downloaded LethalLevelLoader.custom.cfg");
}

document.getElementById("downloadBtn").addEventListener("click", downloadCfg);
document.getElementById("resetBtn").addEventListener("click", applyResetToDefault);
document.getElementById("cleanBtn").addEventListener("click", applyCleanReferences);
document.getElementById("injectDynamicToggle").addEventListener("change", (e) => {
  state.injectDynamicWeights = e.target.checked;
  updateLevelOddsColumn();
});
document.getElementById("toggleBalanceBtn").addEventListener("click", () => {
  const body = document.getElementById("balanceBody");
  body.hidden = !body.hidden;
});
document.getElementById("applyBalanceBtn").addEventListener("click", applyBalance);

document.getElementById("prevLevelBtn").addEventListener("click", () => goToLevelPage(-1));
document.getElementById("nextLevelBtn").addEventListener("click", () => goToLevelPage(1));
document.getElementById("levelSelect").addEventListener("change", (e) => {
  state.currentLevelIndex = parseInt(e.target.value, 10);
  renderLevelPage();
});
document.getElementById("toggleByLevelBtn").addEventListener("click", () => {
  const body = document.getElementById("byLevelBody");
  body.hidden = !body.hidden;
});

document.getElementById("toggleBlacklistBtn").addEventListener("click", () => {
  const body = document.getElementById("blacklistBody");
  body.hidden = !body.hidden;
});
document.getElementById("blacklistInput").addEventListener("input", (e) => {
  state.blacklist = parseBlacklistInput(e.target.value);
  renderLevelPage();
});

loadData();
