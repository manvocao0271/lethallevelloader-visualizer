// Interior Weights Editor - client-side state, live odds calc, pagination, download.

const state = {
  levels: [],            // [{ name, category }]
  dungeons: [],           // [{ name, category, dynamicTagWeights }]
  injectDynamicWeights: true,
  weightsByDungeonLevel: {}, // { dungeonName: { levelName: weight } }
  interiorNames: [],
  currentIndex: 0,
};

function levelTags(category) {
  return category.startsWith("Vanilla") ? ["Vanilla"] : ["Custom", "Modded"];
}

function setStatus(message) {
  document.getElementById("status").textContent = message;
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
  state.interiorNames = Object.keys(data.weights);
  state.weightsByDungeonLevel = {};
  for (const [interiorName, entries] of Object.entries(data.weights)) {
    state.weightsByDungeonLevel[interiorName] = {};
    for (const entry of entries) {
      state.weightsByDungeonLevel[interiorName][entry.level] = entry.weight;
    }
  }

  populateInteriorSelect();
  renderPage();
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

// Recompute {dungeonName: percentage} for a single level, across ALL interiors -
// same formula as dungeon_odds_tool.py's compute_odds().
function computeOddsForLevel(levelName, category) {
  const tags = levelTags(category);
  const weights = {};

  for (const dungeonName of state.interiorNames) {
    const manual = (state.weightsByDungeonLevel[dungeonName] || {})[levelName] || 0;
    const dynamic = state.injectDynamicWeights
      ? tags.reduce((sum, tag) => sum + dynamicTagWeightFor(dungeonName, tag), 0)
      : 0;
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
      updateOddsColumn();
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
      resetToDefault: document.getElementById("resetToDefault").checked,
      cleanReferences: document.getElementById("cleanReferences").checked,
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

loadData();
