// Interior Weights Editor - client-side state, live odds calc, pagination, download.

const state = {
  levels: [],            // [{ name, category }]
  dungeons: [],           // [{ name, category, dynamicTagWeights }]
  weightsByDungeonLevel: {}, // { dungeonName: { levelName: weight } }
  defaultWeightsByDungeonLevel: {},
  interiorNames: [],
  currentLevelIndex: 0,
  resetToDefaultRequested: false,
  cleanReferencesRequested: false,
  emptyDungeonInjectionsRequested: false,
  blacklist: [], // lowercased interior names and/or dynamic tags
  levelSettingsByLevel: {}, // { levelName: { settingKey: value } }
  defaultLevelSettingsByLevel: {},
  groupIdByInterior: {}, // { interiorName: groupId } - same grouping shown on every moon
  groupColors: {}, // { groupId: colorHex }
  nextGroupId: 1,
  lockedInteriors: {}, // { interiorName: true } - locked rows can't be edited by user or program
  balanceSettings: null, // { lobbySize, tripsPerPlayer, minItemsPerTrip, maxItemsPerTrip, valuePerItem } - shared across all moons, persisted in localStorage
  enemyCatalogue: [], // [{ name, powerLevel, inside, daytime, nighttime }] from enemies_catalogue.csv
};

// Cycled through in order as new groups are created.
const GROUP_COLOR_PALETTE = [
  "#e5484d", "#3fae4a", "#4a90d9", "#e5c100", "#b968f2",
  "#f2994a", "#2dd4bf", "#f472b6", "#8bc34a", "#60a5fa",
  "#9c591d", "#2d4cd4", "#356d00", "#6b7c8f", "#673280",
];

// Must exactly match web_ui.py's LEVEL_SETTING_KEYS strings.
const LEVEL_SETTING_FIELDS = [
  { group: "General", key: "General Settings - Planet Route Price", label: "Planet Route Price", type: "int" },
  { group: "General", key: "General Settings - Day Speed Multiplier", label: "Day Speed Multiplier", type: "float" },
  { group: "General", key: "General Settings - Does Planet Have Time", label: "Does Planet Have Time", type: "bool" },
  { group: "Scrap", key: "Scrap Settings - Minimum Scrap Item Spawns", label: "Minimum Scrap Item Spawns", type: "int" },
  { group: "Scrap", key: "Scrap Settings - Maximum Scrap Item Spawns", label: "Maximum Scrap Item Spawns", type: "int" },
  { group: "Scrap", key: "Scrap Settings - Minimum Total Scrap Value", label: "Minimum Total Scrap Value", type: "int" },
  { group: "Scrap", key: "Scrap Settings - Maximum Total Scrap Value", label: "Maximum Total Scrap Value", type: "int" },
  { group: "Enemy", key: "Enemy Settings - Maximum Inside Enemy Power Count", label: "Maximum Inside Enemy Power Count", type: "int" },
  { group: "Enemy", key: "Enemy Settings - Maximum Outside, Daytime Enemy Power Count", label: "Maximum Outside, Daytime Enemy Power Count", type: "int" },
  { group: "Enemy", key: "Enemy Settings - Maximum Outside, Nighttime Enemy Power Count", label: "Maximum Outside, Nighttime Enemy Power Count", type: "int" },
  { group: "Enemy", key: "Enemy Settings - Inside Enemies Spawning List", label: "Inside Enemies Spawning List", type: "string" },
  { group: "Enemy", key: "Enemy Settings - Outside Daytime Enemies Spawning List", label: "Outside Daytime Enemies Spawning List", type: "string" },
  { group: "Enemy", key: "Enemy Settings - Outside Nighttime Enemies Spawning List", label: "Outside Nighttime Enemies Spawning List", type: "string" },
];

// Must exactly match web_ui.py's DUNGEON_SIZE_SETTING_KEYS strings.
const DUNGEON_SIZE_SETTING_FIELDS = [
  { key: "General Settings - Minimum Dungeon Size Multiplier", label: "Min Size Mult." },
  { key: "General Settings - Maximum Dungeon Size Multiplier", label: "Max Size Mult." },
  { key: "General Settings - Restrict Dungeon Size Scaler", label: "Restrict Size Scaler" },
];

// Colors + CSS class for each enemy list's sideways bar graph.
const ENEMY_BAR_COLORS = {
  "Enemy Settings - Inside Enemies Spawning List": { accent: "#e5c100", track: "#3a3218", cssClass: "enemy-bar-yellow" },
  "Enemy Settings - Outside Daytime Enemies Spawning List": { accent: "#3fae4a", track: "#1c3620", cssClass: "enemy-bar-green" },
  "Enemy Settings - Outside Nighttime Enemies Spawning List": { accent: "#d1453b", track: "#3a1e1c", cssClass: "enemy-bar-red" },
};

// Maps each enemy-list field to the matching boolean column in
// enemies_catalogue.csv that decides whether an enemy belongs on that list.
const ENEMY_FIELD_CATALOGUE_ATTR = {
  "Enemy Settings - Inside Enemies Spawning List": "inside",
  "Enemy Settings - Outside Daytime Enemies Spawning List": "daytime",
  "Enemy Settings - Outside Nighttime Enemies Spawning List": "nighttime",
};

// Name of the moon whose interior weights act as the "template" copied onto
// every other moon by the Gordion sync button, and the only moon on which
// that button is shown.
const GORDION_LEVEL_NAME = "Gordion";

// --- Moon "Balance" tool --------------------------------------------------
// Turns a shared assumption about how the crew plays (lobby size, how many
// haul trips each player makes, how much they carry per trip, and a flat
// credits-per-item baseline) into a Min/Max Scrap Item Spawns and Min/Max
// Total Scrap Value for whichever moon is currently selected - using that
// moon's own existing Enemy Power (risk) and Route Price (cost) as the
// per-moon inputs, rather than asking you to re-type those too.
//
// Tunable knobs - adjust here if the output feels off for your pack; the
// shape of the formula itself lives in computeBalancedScrapSettings().
const BALANCE_SPAWN_BUFFER_MIN = 1.10; // headroom over worst-case hauling demand
const BALANCE_SPAWN_BUFFER_MAX = 1.35; // headroom over best-case hauling demand
const BALANCE_DANGER_REFERENCE_POWER = 20; // enemy power treated as "medium" danger
const BALANCE_DANGER_VALUE_RANGE_MIN = 0.4; // value bonus at max danger, low end
const BALANCE_DANGER_VALUE_RANGE_MAX = 1.0; // value bonus at max danger, high end
const BALANCE_ROUTE_PRICE_BREAKEVEN = 1.25; // min value must clear cost x this much
const BALANCE_VALUE_SPREAD_RATIO = 1.15; // max value stays >= min value x this
const BALANCE_SETTINGS_STORAGE_KEY = "interiorWeightsEditor.balanceSettings";
const BALANCE_SETTINGS_DEFAULTS = {
  lobbySize: 4,
  tripsPerPlayer: 3,
  minItemsPerTrip: 2,
  maxItemsPerTrip: 4,
  valuePerItem: 60,
};

function loadBalanceSettings() {
  try {
    const raw = localStorage.getItem(BALANCE_SETTINGS_STORAGE_KEY);
    if (raw) return { ...BALANCE_SETTINGS_DEFAULTS, ...JSON.parse(raw) };
  } catch (e) {
    // localStorage unavailable/blocked - fall back to defaults silently.
  }
  return { ...BALANCE_SETTINGS_DEFAULTS };
}

function saveBalanceSettings() {
  try {
    localStorage.setItem(BALANCE_SETTINGS_STORAGE_KEY, JSON.stringify(state.balanceSettings));
  } catch (e) {
    // Ignore - the shared settings just won't persist across reloads.
  }
}

function readBalanceSettingsFromInputs() {
  return {
    lobbySize: parseFloat(document.getElementById("balanceLobbySize").value) || 0,
    tripsPerPlayer: parseFloat(document.getElementById("balanceTripsPerPlayer").value) || 0,
    minItemsPerTrip: parseFloat(document.getElementById("balanceMinItemsPerTrip").value) || 0,
    maxItemsPerTrip: parseFloat(document.getElementById("balanceMaxItemsPerTrip").value) || 0,
    valuePerItem: parseFloat(document.getElementById("balanceValuePerItem").value) || 0,
  };
}

function populateBalanceSettingsInputs() {
  document.getElementById("balanceLobbySize").value = state.balanceSettings.lobbySize;
  document.getElementById("balanceTripsPerPlayer").value = state.balanceSettings.tripsPerPlayer;
  document.getElementById("balanceMinItemsPerTrip").value = state.balanceSettings.minItemsPerTrip;
  document.getElementById("balanceMaxItemsPerTrip").value = state.balanceSettings.maxItemsPerTrip;
  document.getElementById("balanceValuePerItem").value = state.balanceSettings.valuePerItem;
}

// Pure function: crew assumptions + this moon's own enemy power/route price
// in, this moon's 4 scrap settings out. Kept separate from the DOM so the
// formula itself is easy to read/tune in isolation.
function computeBalancedScrapSettings({
  lobbySize,
  tripsPerPlayer,
  minItemsPerTrip,
  maxItemsPerTrip,
  valuePerItem,
  enemyPower,
  routePrice,
}) {
  const totalTrips = lobbySize * tripsPerPlayer;
  const demandMin = totalTrips * minItemsPerTrip;
  const demandMax = totalTrips * maxItemsPerTrip;

  // Count is purely logistics-driven - enemy power never adjusts it.
  const minSpawns = Math.max(1, Math.ceil(demandMin * BALANCE_SPAWN_BUFFER_MIN));
  const maxSpawns = Math.max(minSpawns, Math.ceil(demandMax * BALANCE_SPAWN_BUFFER_MAX));

  // Bounded 0-1 danger curve so a handful of very-high-power modded moons
  // don't send the value multiplier to infinity.
  const danger = enemyPower / (enemyPower + BALANCE_DANGER_REFERENCE_POWER);

  const rawMinValue = minSpawns * valuePerItem * (1 + BALANCE_DANGER_VALUE_RANGE_MIN * danger);
  const rawMaxValue = maxSpawns * valuePerItem * (1 + BALANCE_DANGER_VALUE_RANGE_MAX * danger);

  // A min-roll run should still comfortably clear the cost of flying there.
  const costFloor = Math.ceil(routePrice * BALANCE_ROUTE_PRICE_BREAKEVEN);
  const minValue = Math.max(Math.round(rawMinValue), costFloor);
  // Keeps a real min-max spread even when the cost floor dominates.
  const maxValue = Math.max(Math.round(rawMaxValue), Math.ceil(minValue * BALANCE_VALUE_SPREAD_RATIO));

  return { minSpawns, maxSpawns, minValue, maxValue };
}

function applyBalanceForCurrentMoon() {
  const level = state.levels[state.currentLevelIndex];
  if (!level) return;

  const inputs = readBalanceSettingsFromInputs();
  state.balanceSettings = inputs;
  saveBalanceSettings();

  if (inputs.lobbySize <= 0 || inputs.tripsPerPlayer <= 0 || inputs.maxItemsPerTrip <= 0 || inputs.valuePerItem <= 0) {
    setStatus("Balance needs Lobby Size, Trips Per Player, Max Items Per Trip, and Base Value Per Item to all be greater than 0.");
    return;
  }
  if (inputs.maxItemsPerTrip < inputs.minItemsPerTrip) {
    setStatus("Max Items Per Trip must be \u2265 Min Items Per Trip.");
    return;
  }

  const settings = state.levelSettingsByLevel[level.name] || {};
  const enemyPower =
    (parseFloat(settings["Enemy Settings - Maximum Inside Enemy Power Count"]) || 0) +
    (parseFloat(settings["Enemy Settings - Maximum Outside, Daytime Enemy Power Count"]) || 0) +
    (parseFloat(settings["Enemy Settings - Maximum Outside, Nighttime Enemy Power Count"]) || 0);
  const routePrice = parseFloat(settings["General Settings - Planet Route Price"]) || 0;

  const result = computeBalancedScrapSettings({ ...inputs, enemyPower, routePrice });

  setLevelSetting(level.name, "Scrap Settings - Minimum Scrap Item Spawns", String(result.minSpawns));
  setLevelSetting(level.name, "Scrap Settings - Maximum Scrap Item Spawns", String(result.maxSpawns));
  setLevelSetting(level.name, "Scrap Settings - Minimum Total Scrap Value", String(result.minValue));
  setLevelSetting(level.name, "Scrap Settings - Maximum Total Scrap Value", String(result.maxValue));

  renderLevelSettingsPanel();
  setStatus(
    `Balanced "${level.name}": spawns ${result.minSpawns}-${result.maxSpawns}, value ${result.minValue}-${result.maxValue} ` +
      `(enemy power ${enemyPower}, route price ${routePrice}).`
  );
}

// Paints a slider's fill as a solid-color gradient up to its current value/max ratio.
function paintBarSlider(slider, colors) {
  const pct = (Number(slider.value) / Number(slider.max || 1)) * 100;
  slider.style.background =
    `linear-gradient(to right, ${colors.accent} 0%, ${colors.accent} ${pct}%, ${colors.track} ${pct}%, ${colors.track} 100%)`;
}

// Parses a "Name:Weight,Name2:Weight2" list into [[name, weight], ...],
// preserving order. Mirrors web_ui.py's PAIR_RE (name may contain colons -
// the LAST colon separates the name from the weight) and skips unparsable
// entries (e.g. a literal "Default Values Were Empty" placeholder).
function parseNamedWeightList(raw) {
  const pairs = [];
  for (const chunk of (raw || "").split(",")) {
    const trimmed = chunk.trim();
    const idx = trimmed.lastIndexOf(":");
    if (idx <= 0) continue;
    const name = trimmed.slice(0, idx).trim();
    const weight = parseInt(trimmed.slice(idx + 1).trim(), 10);
    if (!name || !Number.isFinite(weight)) continue;
    pairs.push([name, weight]);
  }
  return pairs;
}

function serializeNamedWeightList(pairs) {
  return pairs.map(([name, weight]) => `${name}:${weight}`).join(",");
}

// Makes sure every enemy from enemies_catalogue.csv whose attribute for a
// given list is true is actually present in that list's raw "Name:Weight"
// string for this moon - anything missing is appended at weight 0 so it's
// visible (and adjustable) instead of silently absent. Existing entries and
// their weights - including for enemies not in the catalogue at all - are
// left exactly as they are.
function backfillEnemyListsForLevel(levelName) {
  if (state.enemyCatalogue.length === 0) return;
  const settings = state.levelSettingsByLevel[levelName];
  if (!settings) return;
  for (const [fieldKey, attr] of Object.entries(ENEMY_FIELD_CATALOGUE_ATTR)) {
    const pairs = parseNamedWeightList(settings[fieldKey] || "");
    const existingNames = new Set(pairs.map(([name]) => name));
    let changed = false;
    for (const enemy of state.enemyCatalogue) {
      if (enemy[attr] && !existingNames.has(enemy.name)) {
        pairs.push([enemy.name, 0]);
        existingNames.add(enemy.name);
        changed = true;
      }
    }
    if (changed) settings[fieldKey] = serializeNamedWeightList(pairs);
  }
}

function backfillAllEnemyLists() {
  for (const level of state.levels) backfillEnemyListsForLevel(level.name);
}

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

function groupColorFor(groupId) {
  if (!state.groupColors[groupId]) {
    const usedCount = Object.keys(state.groupColors).length;
    state.groupColors[groupId] = GROUP_COLOR_PALETTE[usedCount % GROUP_COLOR_PALETTE.length];
  }
  return state.groupColors[groupId];
}

function groupMembers(groupId) {
  return state.interiorNames.filter((name) => state.groupIdByInterior[name] === groupId);
}

// Dragging one interior onto another groups them (merging their groups if
// both already belong to one), so a group can grow to 2, 3, 4+ members.
function mergeIntoGroup(sourceName, targetName) {
  if (sourceName === targetName) return;
  const sourceGroup = state.groupIdByInterior[sourceName];
  const targetGroup = state.groupIdByInterior[targetName];

  if (sourceGroup && targetGroup) {
    if (sourceGroup === targetGroup) return;
    for (const name of groupMembers(sourceGroup)) {
      state.groupIdByInterior[name] = targetGroup;
    }
    delete state.groupColors[sourceGroup];
    return;
  }
  if (targetGroup) {
    state.groupIdByInterior[sourceName] = targetGroup;
    return;
  }
  if (sourceGroup) {
    state.groupIdByInterior[targetName] = sourceGroup;
    return;
  }

  const newGroupId = state.nextGroupId++;
  state.groupIdByInterior[sourceName] = newGroupId;
  state.groupIdByInterior[targetName] = newGroupId;
  groupColorFor(newGroupId);
}

function removeFromGroup(name) {
  const groupId = state.groupIdByInterior[name];
  if (!groupId) return;
  delete state.groupIdByInterior[name];
  const remaining = groupMembers(groupId);
  if (remaining.length < 2) {
    // A group of fewer than 2 members isn't a group anymore - dissolve it.
    for (const remainingName of remaining) delete state.groupIdByInterior[remainingName];
    delete state.groupColors[groupId];
  }
}

// Reorders interiorNames so every group's members sit adjacent to each
// other (at the position of their earliest member), while ungrouped
// interiors keep their original relative order.
function orderedInteriorNames() {
  const emitted = new Set();
  const order = [];
  for (const name of state.interiorNames) {
    if (emitted.has(name)) continue;
    const groupId = state.groupIdByInterior[name];
    const namesToEmit = groupId ? groupMembers(groupId) : [name];
    for (const member of namesToEmit) {
      if (emitted.has(member)) continue;
      order.push(member);
      emitted.add(member);
    }
  }
  return order;
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
  state.interiorNames = Object.keys(data.weights);
  state.weightsByDungeonLevel = indexWeights(data.weights);
  state.defaultWeightsByDungeonLevel = indexWeights(data.defaultWeights || {});
  state.levelSettingsByLevel = {};
  for (const [levelName, settings] of Object.entries(data.levelSettings || {})) {
    state.levelSettingsByLevel[levelName] = { ...settings };
  }
  state.defaultLevelSettingsByLevel = {};
  for (const [levelName, settings] of Object.entries(data.levelSettingsDefaults || {})) {
    state.defaultLevelSettingsByLevel[levelName] = { ...settings };
  }
  state.enemyCatalogue = data.enemyCatalogue || [];
  backfillAllEnemyLists();

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
//
// This dynamic component is always applied - LethalLevelLoader's actual
// dungeon-selection code (DungeonManager.GetValidExtendedDungeonFlows)
// calls GetDynamicRarity() unconditionally for every custom dungeon. The
// cfg's "Inject Dynamic Matching Weights" setting does not gate this in
// the real game (confirmed via source inspection), so this tool ignores
// it too rather than showing odds that don't match `>simulate`.
function dynamicComponentFor(dungeonName, tags) {
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

// Sums this interior's own manual weight across every level ("moon") - the
// same number editable in the Weight column, just added up across all of
// them - not the effective (max-with-dynamic-tag) weight used for odds.
// A blacklisted interior's weight is always effectively 0 on every level
// regardless of whether the row is also locked, so its total is forced to
// 0 too rather than showing a stale sum that no longer applies anywhere.
function computeCumulativeWeight(interiorName) {
  if (isBlacklisted(interiorName)) return 0;
  const perLevel = state.weightsByDungeonLevel[interiorName] || {};
  return state.levels.reduce((sum, lvl) => sum + clampWeight(perLevel[lvl.name] || 0), 0);
}

function computeTotalCumulativeWeight() {
  return state.interiorNames.reduce((sum, name) => sum + computeCumulativeWeight(name), 0);
}

// Percentage depends on the total across every interior, so a single
// weight edit has to refresh every row's cumulative + percentage cells,
// not just the row that changed.
function updateCumulativeWeightCells() {
  const total = computeTotalCumulativeWeight();
  for (const cell of document.querySelectorAll(".cumulative-weight-cell")) {
    cell.textContent = String(computeCumulativeWeight(cell.dataset.interior));
  }
  for (const cell of document.querySelectorAll(".cumulative-percentage-cell")) {
    const value = computeCumulativeWeight(cell.dataset.interior);
    cell.textContent = formatPercentage(total > 0 ? (value / total) * 100 : 0);
  }
}

// Builds one <tr> for the "Interior Weights by Level" table. Shared by both
// the whitelisted tbody and the blacklisted-section tbody below it.
// totalCumulativeWeight is computed once per render pass (not per row) since
// every row's percentage cell needs the same shared total.
function buildInteriorRow(interiorName, level, totalCumulativeWeight) {
  const row = document.createElement("tr");
  row.dataset.interior = interiorName;
  const locked = !!state.lockedInteriors[interiorName];
  const blacklisted = isBlacklisted(interiorName);
  row.classList.toggle("blacklisted", blacklisted);
  row.classList.toggle("locked", locked);

  row.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    row.classList.add("drag-over");
  });
  row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
  row.addEventListener("drop", (e) => {
    e.preventDefault();
    row.classList.remove("drag-over");
    const sourceName = e.dataTransfer.getData("text/plain");
    if (!sourceName || sourceName === interiorName) return;
    mergeIntoGroup(sourceName, interiorName);
    renderLevelPage();
    setStatus(`Grouped "${sourceName}" with "${interiorName}" (same color on every moon).`);
  });

  const lockCell = document.createElement("td");
  const lockBtn = document.createElement("button");
  lockBtn.type = "button";
  lockBtn.className = "lock-btn";
  lockBtn.textContent = locked ? "\u{1F512}" : "\u{1F513}";
  lockBtn.title = locked ? "Unlock this row" : "Lock this row (blocks edits by you or any tool button)";
  lockBtn.addEventListener("click", () => {
    if (state.lockedInteriors[interiorName]) {
      delete state.lockedInteriors[interiorName];
    } else {
      state.lockedInteriors[interiorName] = true;
    }
    renderLevelPage();
  });
  lockCell.appendChild(lockBtn);
  row.appendChild(lockCell);

  const nameCell = document.createElement("td");
  const handle = document.createElement("span");
  handle.className = "drag-handle";
  handle.textContent = "\u22ee\u22ee";
  handle.draggable = true;
  handle.title = "Drag onto another interior's row to group them";
  handle.addEventListener("dragstart", (e) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", interiorName);
    row.classList.add("dragging");
  });
  handle.addEventListener("dragend", () => row.classList.remove("dragging"));
  nameCell.appendChild(handle);

  const nameLabel = document.createElement("span");
  nameLabel.textContent = interiorName;
  nameCell.appendChild(nameLabel);

  const groupId = state.groupIdByInterior[interiorName];
  if (groupId) {
    const color = groupColorFor(groupId);
    nameLabel.style.color = color;
    nameLabel.style.fontWeight = "600";
    nameCell.style.borderLeft = `4px solid ${color}`;
    const ungroupBtn = document.createElement("button");
    ungroupBtn.type = "button";
    ungroupBtn.className = "ungroup-btn";
    ungroupBtn.textContent = "\u00d7";
    ungroupBtn.title = "Remove from group";
    ungroupBtn.addEventListener("click", () => {
      removeFromGroup(interiorName);
      renderLevelPage();
    });
    nameCell.appendChild(ungroupBtn);
  }
  row.appendChild(nameCell);

  const weightCell = document.createElement("td");
  const input = document.createElement("input");
  input.type = "number";
  input.step = "any";
  const rawWeightValue = (state.weightsByDungeonLevel[interiorName] || {})[level.name] ?? 0;
  // A blacklisted interior's weight is always forced to 0 - here, in the
  // odds calc, and on download - and that override holds even if the row
  // is also locked, so editing is disabled either way rather than leaving
  // a stale nonzero value showing.
  input.value = blacklisted ? 0 : rawWeightValue;
  input.disabled = locked || blacklisted;
  if (blacklisted) input.title = "Blacklisted interiors always use a weight of 0.";
  input.addEventListener("input", () => {
    const value = parseFloat(input.value);
    if (!state.weightsByDungeonLevel[interiorName]) state.weightsByDungeonLevel[interiorName] = {};
    state.weightsByDungeonLevel[interiorName][level.name] = Number.isFinite(value) ? value : 0;
    updateLevelOddsColumn();
    updateCumulativeWeightCells();
  });
  weightCell.appendChild(input);
  row.appendChild(weightCell);

  // Dungeon size settings live on the interior itself (not per-level), so
  // these 3 columns edit the same value regardless of which level is shown.
  const dungeon = state.dungeons.find((d) => d.name === interiorName);
  for (const field of DUNGEON_SIZE_SETTING_FIELDS) {
    const sizeCell = document.createElement("td");
    const sizeInput = document.createElement("input");
    sizeInput.type = "number";
    sizeInput.step = "any";
    sizeInput.value = dungeon?.sizeSettings?.[field.key] ?? "";
    sizeInput.disabled = !dungeon || locked;
    sizeInput.addEventListener("input", () => {
      if (!dungeon) return;
      if (!dungeon.sizeSettings) dungeon.sizeSettings = {};
      dungeon.sizeSettings[field.key] = sizeInput.value;
    });
    sizeCell.appendChild(sizeInput);
    row.appendChild(sizeCell);
  }

  const oddsCell = document.createElement("td");
  oddsCell.className = "level-odds-cell";
  oddsCell.dataset.interior = interiorName;
  row.appendChild(oddsCell);

  // Read-only total of this interior's own weight across every moon, not
  // just the one currently shown - never editable from this column.
  const cumulativeCell = document.createElement("td");
  cumulativeCell.className = "cumulative-weight-cell";
  cumulativeCell.dataset.interior = interiorName;
  const cumulativeWeight = computeCumulativeWeight(interiorName);
  cumulativeCell.textContent = String(cumulativeWeight);
  row.appendChild(cumulativeCell);

  // Read-only: this interior's cumulative weight as a share of the total
  // cumulative weight across every interior - also never editable here.
  const cumulativePercentageCell = document.createElement("td");
  cumulativePercentageCell.className = "cumulative-percentage-cell";
  cumulativePercentageCell.dataset.interior = interiorName;
  cumulativePercentageCell.textContent = formatPercentage(
    totalCumulativeWeight > 0 ? (cumulativeWeight / totalCumulativeWeight) * 100 : 0
  );
  row.appendChild(cumulativePercentageCell);

  return row;
}

function renderLevelPage() {
  const total = state.levels.length;
  if (total === 0) return;
  state.currentLevelIndex = ((state.currentLevelIndex % total) + total) % total;
  const level = state.levels[state.currentLevelIndex];

  document.getElementById("levelSelect").value = state.currentLevelIndex;
  document.getElementById("levelPageLabel").textContent = `${state.currentLevelIndex + 1} of ${total}`;

  const tbody = document.getElementById("levelWeightsBody");
  const blacklistedTbody = document.getElementById("blacklistedWeightsBody");
  tbody.innerHTML = "";
  blacklistedTbody.innerHTML = "";

  // Cumulative-weight percentages are relative to the total across every
  // interior, so this is computed once per render pass and shared by every
  // row rather than recomputed per row.
  const totalCumulativeWeight = computeTotalCumulativeWeight();

  // The Gordion sync button only makes sense while viewing Gordion itself
  // (it always reads Gordion's weights regardless of the current page, but
  // showing it elsewhere invites clicking it out of context).
  const gordionSyncBar = document.getElementById("gordionSyncBar");
  if (gordionSyncBar) gordionSyncBar.hidden = level.name !== GORDION_LEVEL_NAME;

  // Blacklisted interiors are pulled out of the normal ordering entirely and
  // rendered into their own tbody below, rather than interspersed among the
  // whitelisted rows.
  const blacklistedNames = [];
  for (const interiorName of orderedInteriorNames()) {
    const row = buildInteriorRow(interiorName, level, totalCumulativeWeight);
    if (isBlacklisted(interiorName)) {
      blacklistedNames.push(interiorName);
      blacklistedTbody.appendChild(row);
    } else {
      tbody.appendChild(row);
    }
  }

  // Only show the blacklisted section (and its divider label) once
  // something is actually blacklisted.
  if (blacklistedNames.length > 0) {
    const divider = document.createElement("tr");
    divider.className = "section-divider";
    const dividerCell = document.createElement("td");
    dividerCell.colSpan = 9;
    dividerCell.textContent = `Blacklisted (${blacklistedNames.length}) \u2014 weight forced to 0`;
    divider.appendChild(dividerCell);
    blacklistedTbody.insertBefore(divider, blacklistedTbody.firstChild);
    blacklistedTbody.hidden = false;
  } else {
    blacklistedTbody.hidden = true;
  }

  updateLevelOddsColumn();
  renderLevelSettingsPanel();
}

function setLevelSetting(levelName, key, value) {
  if (!state.levelSettingsByLevel[levelName]) state.levelSettingsByLevel[levelName] = {};
  state.levelSettingsByLevel[levelName][key] = value;
}

function renderLevelSettingsPanel() {
  const level = state.levels[state.currentLevelIndex];
  const container = document.getElementById("levelSettingsFields");
  if (!level || !container) return;
  container.innerHTML = "";
  const settings = state.levelSettingsByLevel[level.name] || {};

  let currentGroup = null;
  let groupDiv = null;
  for (const field of LEVEL_SETTING_FIELDS) {
    if (field.group !== currentGroup) {
      currentGroup = field.group;
      groupDiv = document.createElement("div");
      groupDiv.className = "level-settings-group";
      const heading = document.createElement("h4");
      heading.textContent = currentGroup;
      groupDiv.appendChild(heading);
      container.appendChild(groupDiv);
    }

    const row = document.createElement("div");
    row.className = "level-settings-row";

    const label = document.createElement("label");
    label.textContent = field.label;
    row.appendChild(label);

    const rawValue = settings[field.key] ?? "";
    let input;
    if (field.type === "bool") {
      input = document.createElement("input");
      input.type = "checkbox";
      input.checked = String(rawValue).toLowerCase() === "true";
      input.addEventListener("change", () => {
        setLevelSetting(level.name, field.key, input.checked ? "true" : "false");
      });
    } else if (field.type === "string") {
      input = document.createElement("textarea");
      input.rows = 2;
      input.value = rawValue;
      input.addEventListener("input", () => {
        setLevelSetting(level.name, field.key, input.value);
      });
    } else {
      input = document.createElement("input");
      input.type = "number";
      if (field.type === "float") input.step = "any";
      input.value = rawValue;
      input.addEventListener("input", () => {
        setLevelSetting(level.name, field.key, input.value);
      });
    }

    row.appendChild(input);
    groupDiv.appendChild(row);

    // Enemy spawn lists also get a sideways, slidable bar graph of weights
    // beneath the raw textarea - editing either one keeps the other in sync.
    const barColors = ENEMY_BAR_COLORS[field.key];
    if (barColors) {
      const barsContainer = document.createElement("div");
      barsContainer.className = "enemy-bars";
      groupDiv.appendChild(barsContainer);
      input.addEventListener("input", () => renderEnemyBars(barsContainer, barColors, level.name, field.key, input));
      renderEnemyBars(barsContainer, barColors, level.name, field.key, input);
    }
  }
}

// Renders one slider row per "Name:Weight" entry in the textarea's current
// value. Dragging a slider updates its weight, repaints the bar's fill, and
// writes the serialized list back into both the textarea and app state.
function renderEnemyBars(container, barColors, levelName, fieldKey, textareaEl) {
  const pairs = parseNamedWeightList(textareaEl.value);
  container.innerHTML = "";
  if (pairs.length === 0) return;

  const maxWeight = Math.round(Math.max(100, ...pairs.map(([, weight]) => weight)) * 1.2);

  pairs.forEach(([name, weight], index) => {
    const row = document.createElement("div");
    row.className = "enemy-bar-row";

    const label = document.createElement("span");
    label.className = "enemy-bar-label";
    label.textContent = name;
    const catalogueEntry = state.enemyCatalogue.find((e) => e.name === name);
    if (catalogueEntry) label.title = `Power Level: ${catalogueEntry.powerLevel}`;
    row.appendChild(label);

    const slider = document.createElement("input");
    slider.type = "range";
    slider.className = `enemy-bar-slider ${barColors.cssClass}`;
    slider.min = "0";
    slider.max = String(maxWeight);
    slider.value = String(weight);
    row.appendChild(slider);

    const valueLabel = document.createElement("span");
    valueLabel.className = "enemy-bar-value";
    valueLabel.textContent = String(weight);
    row.appendChild(valueLabel);

    const paintSlider = () => paintBarSlider(slider, barColors);
    paintSlider();

    slider.addEventListener("input", () => {
      pairs[index][1] = parseInt(slider.value, 10);
      valueLabel.textContent = slider.value;
      paintSlider();
      const serialized = serializeNamedWeightList(pairs);
      textareaEl.value = serialized;
      setLevelSetting(levelName, fieldKey, serialized);
    });

    container.appendChild(row);
  });
}

function resetLevelSettingsToDefault() {
  const level = state.levels[state.currentLevelIndex];
  if (!level) return;
  state.levelSettingsByLevel[level.name] = { ...(state.defaultLevelSettingsByLevel[level.name] || {}) };
  backfillEnemyListsForLevel(level.name);
  renderLevelSettingsPanel();
  setStatus(`Reset "${level.name}"'s moon settings to their .cfg defaults.`);
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
  for (const cell of document.querySelectorAll("#levelWeightsTable .level-odds-cell")) {
    const percentage = odds[cell.dataset.interior] || 0;
    cell.textContent = formatPercentage(percentage);
    // Cross out interiors with a true 0% chance for this level (whether
    // blacklisted or just genuinely unreachable).
    cell.closest("tr").classList.toggle("zero-odds", percentage <= 0);
  }
}

function goToLevelPage(delta) {
  state.currentLevelIndex += delta;
  renderLevelPage();
}

function applyResetToDefault() {
  for (const interiorName of state.interiorNames) {
    if (state.lockedInteriors[interiorName]) continue;
    state.weightsByDungeonLevel[interiorName] = { ...(state.defaultWeightsByDungeonLevel[interiorName] || {}) };
  }
  for (const level of state.levels) {
    state.levelSettingsByLevel[level.name] = { ...(state.defaultLevelSettingsByLevel[level.name] || {}) };
  }
  backfillAllEnemyLists();
  for (const dungeon of state.dungeons) {
    if (state.lockedInteriors[dungeon.name]) continue;
    dungeon.sizeSettings = { ...(dungeon.sizeSettingsDefaults || {}) };
  }
  state.resetToDefaultRequested = true;
  renderLevelPage();
  setStatus("Reset weights to defaults (all other settings will also reset on download).");
}

function applyCleanReferences() {
  state.cleanReferencesRequested = true;
  setStatus("Uninstalled level references will be removed on download.");
}

// Copies each interior's current weight on Gordion onto every OTHER moon,
// overwriting whatever that interior's weight already was there. Locked
// interiors are skipped entirely (their weights on every moon, Gordion
// included, are left exactly as they are) - same convention as Reset to
// Default and Quick Balance.
function applyGordionWeightsToAllMoons() {
  const gordionLevel = state.levels.find((l) => l.name === GORDION_LEVEL_NAME);
  if (!gordionLevel) {
    setStatus(`Could not find a "${GORDION_LEVEL_NAME}" moon among the loaded levels.`);
    return;
  }

  let updatedInteriors = 0;
  let skippedLocked = 0;
  for (const interiorName of state.interiorNames) {
    if (state.lockedInteriors[interiorName]) {
      skippedLocked++;
      continue;
    }
    const gordionWeight = (state.weightsByDungeonLevel[interiorName] || {})[gordionLevel.name] ?? 0;
    if (!state.weightsByDungeonLevel[interiorName]) state.weightsByDungeonLevel[interiorName] = {};
    for (const level of state.levels) {
      if (level.name === gordionLevel.name) continue; // Gordion itself is the source, not a target.
      state.weightsByDungeonLevel[interiorName][level.name] = gordionWeight;
    }
    updatedInteriors++;
  }

  renderLevelPage();
  setStatus(
    skippedLocked > 0
      ? `Applied Gordion's weights to every other moon for ${updatedInteriors} unlocked interior(s) (${skippedLocked} locked interior(s) left untouched).`
      : `Applied Gordion's weights to every other moon for ${updatedInteriors} interior(s).`
  );
}

// Fills the given weight into every unlocked interior for the currently
// shown moon only - locked rows are skipped entirely.
function applyQuickBalance() {
  const level = state.levels[state.currentLevelIndex];
  if (!level) return;
  const raw = parseInt(document.getElementById("quickBalanceValue").value, 10);
  const value = Number.isFinite(raw) ? raw : 0;
  let skippedLocked = false;
  for (const interiorName of state.interiorNames) {
    if (state.lockedInteriors[interiorName]) {
      skippedLocked = true;
      continue;
    }
    if (!state.weightsByDungeonLevel[interiorName]) state.weightsByDungeonLevel[interiorName] = {};
    state.weightsByDungeonLevel[interiorName][level.name] = value;
  }
  renderLevelPage();
  setStatus(
    skippedLocked
      ? `Set weight to ${value} for all unlocked interiors on "${level.name}" (locked rows left untouched).`
      : `Set weight to ${value} for all interiors on "${level.name}".`
  );
}

// Zeroes every dungeon's "Dynamic Level Tags List" weight so odds are
// driven purely by each dungeon's manual per-level weight - useful for
// spotting dungeons with a 0 manual weight that still show nonzero odds
// only because of this dynamic tag component.
function applyEmptyDungeonInjections() {
  for (const dungeon of state.dungeons) {
    dungeon.dynamicTagWeights = {};
  }
  state.emptyDungeonInjectionsRequested = true;
  updateLevelOddsColumn();
  setStatus("Cleared dynamic level tag weights (live and on download).");
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

  const dungeonSizeSettings = {};
  for (const dungeon of state.dungeons) {
    if (dungeon.sizeSettings) dungeonSizeSettings[dungeon.name] = dungeon.sizeSettings;
  }

  const res = await fetch("/api/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      resetToDefault: state.resetToDefaultRequested,
      cleanReferences: state.cleanReferencesRequested,
      emptyDungeonInjections: state.emptyDungeonInjectionsRequested,
      weights,
      levelSettings: state.levelSettingsByLevel,
      dungeonSizeSettings,
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
document.getElementById("emptyDungeonInjectionsBtn").addEventListener("click", applyEmptyDungeonInjections);
document.getElementById("quickBalanceBtn").addEventListener("click", applyQuickBalance);
document.getElementById("applyGordionWeightsBtn").addEventListener("click", applyGordionWeightsToAllMoons);

document.getElementById("prevLevelBtn").addEventListener("click", () => goToLevelPage(-1));
document.getElementById("nextLevelBtn").addEventListener("click", () => goToLevelPage(1));
document.getElementById("levelSelect").addEventListener("change", (e) => {
  state.currentLevelIndex = parseInt(e.target.value, 10);
  renderLevelPage();
});

// Left/Right arrow keys page between moons, same as the Prev/Next buttons -
// skipped while focus is in a text field, textarea, or dropdown so typing a
// number or editing the blacklist textarea isn't hijacked.
document.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const target = e.target;
  const tag = target && target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (target && target.isContentEditable)) return;
  e.preventDefault();
  goToLevelPage(e.key === "ArrowLeft" ? -1 : 1);
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

document.getElementById("toggleLevelSettingsBtn").addEventListener("click", () => {
  const body = document.getElementById("levelSettingsBody");
  body.hidden = !body.hidden;
});
document.getElementById("resetLevelSettingsBtn").addEventListener("click", resetLevelSettingsToDefault);

document.getElementById("balanceBtn").addEventListener("click", applyBalanceForCurrentMoon);
for (const id of [
  "balanceLobbySize",
  "balanceTripsPerPlayer",
  "balanceMinItemsPerTrip",
  "balanceMaxItemsPerTrip",
  "balanceValuePerItem",
]) {
  document.getElementById(id).addEventListener("change", () => {
    state.balanceSettings = readBalanceSettingsFromInputs();
    saveBalanceSettings();
  });
}

state.balanceSettings = loadBalanceSettings();
populateBalanceSettingsInputs();

loadData();