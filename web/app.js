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
const FALLBACK_VANILLA_WEIGHT_WHEN_ZERO = 100;

const state = {
  levels: [],            // [{ name, category }]
  dungeons: [],           // [{ name, category, dynamicTagWeights }]
  injectDynamicWeights: true,
  injectDynamicWeightsDefault: true,
  weightsByDungeonLevel: {}, // { dungeonName: { levelName: weight } }
  defaultWeightsByDungeonLevel: {},
  interiorNames: [],
  currentIndex: 0,
  currentLevelIndex: 0,
  resetToDefaultRequested: false,
  cleanReferencesRequested: false,
};

function levelTags(category) {
  return category.startsWith("Vanilla") ? ["Vanilla"] : ["Custom", "Modded"];
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
  populateInteriorSelect();
  populateBalanceTable();
  populateLevelSelect();
  renderPage();
  renderLevelPage();
  setStatus("");
}

function populateInteriorSelect() {
  const select = document.getElementById("interiorSelect");
  select.innerHTML = "";
  state.interiorNames.forEach((name, index) => {
    const option = document.createElement("option");
    option.value = index;
    option.textContent = name;
    select.appendChild(option);
  });
}

function dynamicTagWeightFor(dungeonName, tag) {
  const dungeon = state.dungeons.find((d) => d.name === dungeonName);
  return dungeon ? (dungeon.dynamicTagWeights[tag] || 0) : 0;
}

function dynamicComponentFor(dungeonName, tags) {
  return state.injectDynamicWeights
    ? tags.reduce((sum, tag) => sum + dynamicTagWeightFor(dungeonName, tag), 0)
    : 0;
}

// Recompute {dungeonName: percentage} for a single level, across ALL interiors -
// same formula as dungeon_odds_tool.py's compute_odds().
function computeOddsForLevel(levelName, category) {
  const tags = levelTags(category);
  const weights = {};

  for (const dungeonName of state.interiorNames) {
    const manual = (state.weightsByDungeonLevel[dungeonName] || {})[levelName] || 0;
    const dynamic = dynamicComponentFor(dungeonName, tags);
    const total = manual + dynamic;
    if (total > 0) weights[dungeonName] = total;
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

// Keeps the by-interior table and the by-level table showing the same value
// for a given (interior, level) pair without a full re-render.
function syncWeightInput(interiorName, levelName, value) {
  if (state.interiorNames[state.currentIndex] === interiorName) {
    const mainInput = document.querySelector(`#weightsBody tr[data-level="${levelName}"] input`);
    if (mainInput && mainInput.value !== value) mainInput.value = value;
  }
  const currentLevel = state.levels[state.currentLevelIndex];
  if (currentLevel && currentLevel.name === levelName) {
    const levelInput = document.querySelector(`#levelWeightsBody tr[data-interior="${interiorName}"] input`);
    if (levelInput && levelInput.value !== value) levelInput.value = value;
  }
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
      syncWeightInput(interiorName, level.name, input.value);
      updateOddsColumn();
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

function updateLevelOddsColumn() {
  const level = state.levels[state.currentLevelIndex];
  if (!level) return;
  const odds = computeOddsForLevel(level.name, level.category);
  for (const cell of document.querySelectorAll("#levelWeightsBody .level-odds-cell")) {
    const percentage = odds[cell.dataset.interior] || 0;
    cell.textContent = `${percentage.toFixed(2)}%`;
  }
}

function goToLevelPage(delta) {
  state.currentLevelIndex += delta;
  renderLevelPage();
}

// Same math as balance_interior_weights.py's main(), ported to run live in
// the browser against the currently edited weights + toggle state.
function applyBalance() {
  const vanillaDungeons = state.dungeons.filter((d) => d.category === "Vanilla Dungeon").map((d) => d.name);
  const moddedDungeons = state.dungeons.filter((d) => d.category === "Custom Dungeon").map((d) => d.name);

  const percentInputs = document.querySelectorAll("#balanceTableBody input[type='number']");
  const percentByLevel = {};
  for (const input of percentInputs) {
    const value = parseFloat(input.value);
    percentByLevel[input.dataset.level] = Number.isFinite(value) ? value : 0;
  }

  for (const level of state.levels) {
    const tags = levelTags(level.category);
    let percent = percentByLevel[level.name] ?? 0;
    if (percent >= 100) percent = 99;
    const p = Math.max(percent, 0) / 100;

    const vanillaEffectiveTotal = vanillaDungeons.reduce((sum, d) => {
      const manual = (state.weightsByDungeonLevel[d] || {})[level.name] || 0;
      return sum + manual + dynamicComponentFor(d, tags);
    }, 0);
    const ratioBase = vanillaEffectiveTotal > 0 ? vanillaEffectiveTotal : FALLBACK_VANILLA_WEIGHT_WHEN_ZERO;
    const targetEffectiveModdedTotal = p > 0 ? (ratioBase * p) / (1 - p) : 0;

    const moddedWeights = {};
    for (const d of moddedDungeons) {
      moddedWeights[d] = (state.weightsByDungeonLevel[d] || {})[level.name] || 0;
    }
    const moddedDynamicTotal = moddedDungeons.reduce((sum, d) => sum + dynamicComponentFor(d, tags), 0);

    let targetManualModdedTotal = targetEffectiveModdedTotal - moddedDynamicTotal;
    if (targetManualModdedTotal < 0) targetManualModdedTotal = 0;

    const currentModdedTotal = Object.values(moddedWeights).reduce((a, b) => a + b, 0);
    const newWeights = {};
    if (currentModdedTotal > 0) {
      const scale = targetManualModdedTotal / currentModdedTotal;
      for (const d of moddedDungeons) newWeights[d] = moddedWeights[d] * scale;
    } else {
      const perDungeon = moddedDungeons.length ? targetManualModdedTotal / moddedDungeons.length : 0;
      for (const d of moddedDungeons) newWeights[d] = perDungeon;
    }

    for (const d of moddedDungeons) {
      if (!state.weightsByDungeonLevel[d]) state.weightsByDungeonLevel[d] = {};
      state.weightsByDungeonLevel[d][level.name] = Math.round(newWeights[d] * 100) / 100;
    }
  }

  renderPage();
  renderLevelPage();
  setStatus("Balanced modded weights applied.");
}

function applyResetToDefault() {
  state.injectDynamicWeights = state.injectDynamicWeightsDefault;
  document.getElementById("injectDynamicToggle").checked = state.injectDynamicWeights;
  for (const interiorName of state.interiorNames) {
    state.weightsByDungeonLevel[interiorName] = { ...(state.defaultWeightsByDungeonLevel[interiorName] || {}) };
  }
  state.resetToDefaultRequested = true;
  renderPage();
  renderLevelPage();
  setStatus("Reset weights and dynamic weight toggle to defaults (all other settings will also reset on download).");
}

function applyCleanReferences() {
  state.cleanReferencesRequested = true;
  setStatus("Uninstalled level references will be removed on download.");
}

function renderPage() {
  const total = state.interiorNames.length;
  if (total === 0) return;
  state.currentIndex = ((state.currentIndex % total) + total) % total;
  const interiorName = state.interiorNames[state.currentIndex];

  document.getElementById("interiorSelect").value = state.currentIndex;
  document.getElementById("pageLabel").textContent = `${state.currentIndex + 1} of ${total}`;

  const tbody = document.getElementById("weightsBody");
  tbody.innerHTML = "";

  for (const level of state.levels) {
    const row = document.createElement("tr");
    row.dataset.level = level.name;

    const nameCell = document.createElement("td");
    nameCell.textContent = level.name;
    row.appendChild(nameCell);

    const weightCell = document.createElement("td");
    const input = document.createElement("input");
    input.type = "number";
    input.step = "any";
    input.value = (state.weightsByDungeonLevel[interiorName] || {})[level.name] ?? 0;
    input.addEventListener("input", () => {
      const value = parseFloat(input.value);
      state.weightsByDungeonLevel[interiorName][level.name] = Number.isFinite(value) ? value : 0;
      syncWeightInput(interiorName, level.name, input.value);
      updateOddsColumn();
      updateLevelOddsColumn();
    });
    weightCell.appendChild(input);
    row.appendChild(weightCell);

    const oddsCell = document.createElement("td");
    oddsCell.className = "odds-cell";
    oddsCell.dataset.level = level.name;
    oddsCell.dataset.category = level.category;
    row.appendChild(oddsCell);

    tbody.appendChild(row);
  }

  updateOddsColumn();
}

function updateOddsColumn() {
  const interiorName = state.interiorNames[state.currentIndex];
  for (const cell of document.querySelectorAll("#weightsBody .odds-cell")) {
    const odds = computeOddsForLevel(cell.dataset.level, cell.dataset.category);
    const percentage = odds[interiorName] || 0;
    cell.textContent = `${percentage.toFixed(2)}%`;
  }
}

function goToPage(delta) {
  state.currentIndex += delta;
  renderPage();
}

async function downloadCfg() {
  setStatus("Generating .cfg...");
  const weights = {};
  for (const interiorName of state.interiorNames) {
    weights[interiorName] = state.levels.map((level) => ({
      level: level.name,
      weight: (state.weightsByDungeonLevel[interiorName] || {})[level.name] ?? 0,
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

document.getElementById("prevBtn").addEventListener("click", () => goToPage(-1));
document.getElementById("nextBtn").addEventListener("click", () => goToPage(1));
document.getElementById("interiorSelect").addEventListener("change", (e) => {
  state.currentIndex = parseInt(e.target.value, 10);
  renderPage();
});
document.getElementById("downloadBtn").addEventListener("click", downloadCfg);
document.getElementById("resetBtn").addEventListener("click", applyResetToDefault);
document.getElementById("cleanBtn").addEventListener("click", applyCleanReferences);
document.getElementById("injectDynamicToggle").addEventListener("change", (e) => {
  state.injectDynamicWeights = e.target.checked;
  updateOddsColumn();
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

loadData();
