const MOD = "scene-mirror";
const MOD_VERSION = "1.3.9";

/* ================== Settings ================== */
Hooks.once("init", () => {
  game.settings.register(MOD, "targetDir", {
    name: "Target Directory (under Data/)", scope: "world", config: true,
    type: String, default: "mirrored-scenes"
  });
  game.settings.register(MOD, "webpQuality", {
    name: "WebP Quality (0–1)", hint: "Higher = better quality, larger file. 0.85 is a good default.",
    scope: "world", config: true, type: Number, default: 0.85
  });
  game.settings.register(MOD, "lastSrc", { scope: "world", config: false, type: String, default: "" });
});

/* ================== Utility Helpers ================== */
function sceneSrc(scene) {
  return scene?.background?.src || scene?.img || canvas?.scene?.background?.src || canvas?.scene?.img || null;
}

async function convertToWebP(blob, quality) {
  const bmp = await createImageBitmap(blob);
  const C = (typeof OffscreenCanvas !== "undefined")
    ? new OffscreenCanvas(bmp.width, bmp.height)
    : Object.assign(document.createElement("canvas"), { width: bmp.width, height: bmp.height });
  const ctx = C.getContext("2d");
  ctx.drawImage(bmp, 0, 0);
  const q = Math.min(Math.max(quality ?? 0.85, 0), 1);
  if (C.convertToBlob) return await C.convertToBlob({ type: "image/webp", quality: q });
  return await new Promise((resolve, reject) =>
    C.toBlob(b => b ? resolve(b) : reject(new Error("WEBP encode failed")), "image/webp", q)
  );
}

function targetDir() {
  return (game.settings.get(MOD, "targetDir") || "mirrored-scenes").replace(/^\/+|\/+$/g, "");
}

async function ensureDir(dir) {
  try { await FilePicker.createDirectory("data", dir); } catch (_) { /* exists */ }
}

/* ================== Data Extractors (DnD5e) ================== */
function extractHP_dnd5e(actor) {
  const a = actor?.system?.attributes?.hp ?? {};
  const n = v => (v === null || v === undefined ? null : Number.isFinite(+v) ? +v : v);
  const hp = n(a.value ?? a.current);
  const hpMax = n(a.max);
  const tempHP = n(a.temp ?? a.temporary ?? 0);
  const tempMax = n(a.tempmax ?? 0);

  let status = null;
  if (hp != null && hpMax != null && hpMax > 0) {
    const pct = (hp / hpMax) * 100;
    if (pct > 80) status = "Healthy";
    else if (pct > 60) status = "Hurt";
    else if (pct > 30) status = "Injured";
    else if (pct > 10) status = "Bloodied";
    else status = "Critical";
  }
  return { hp, hpMax, tempHP, tempMax, condition: status };
}

function extractAbilities_dnd5e(actor) {
  const A = actor?.system?.abilities || {
    str: {}, dex: {}, con: {}, int: {}, wis: {}, cha: {}
  };
  const keys = ["str","dex","con","int","wis","cha"];
  const out = {};
  for (const k of keys) {
    const a = A[k] || {};
    const score = a.value ?? a.score ?? null;
    const mod = a.mod ?? null;
    const save = a.save ?? (mod != null ? mod : null);
    const proficient = (typeof a.prof === "number" ? a.prof : (a.proficient ? 1 : 0));
    out[k] = { score, mod, save, proficient };
  }
  const profBonus = actor?.system?.attributes?.prof ?? null;
  return { abilities: out, proficiencyBonus: profBonus };
}

function extractAC_dnd5e(actor, abilities) {
  const ac = actor?.system?.attributes?.ac;
  let val = ac?.value ?? ac?.total ?? ac?.base ?? null;
  if (val == null) {
    const dexMod = abilities?.dex?.mod ?? actor?.system?.abilities?.dex?.mod ?? 0;
    val = 10 + (Number.isFinite(+dexMod) ? +dexMod : 0);
  }
  return Number.isFinite(+val) ? +val : val;
}

/* ================== Mirroring ================== */
async function mirrorActiveScene() {
  if (!game.user.isGM) return;
  const scene = game.scenes.active;
  const src = sceneSrc(scene);
  const last = game.settings.get(MOD, "lastSrc");
  if (!src || src === last) return;

  try {
    const abs = new URL(src, window.location.origin).href;
    const r = await fetch(abs, { cache: "no-store" });
    if (!r.ok) throw new Error(`Fetch failed ${r.status}`);
    const webpBlob = await convertToWebP(await r.blob(), game.settings.get(MOD, "webpQuality"));

    const dir = targetDir();
    await ensureDir(dir);

    const file = new File([webpBlob], "current-scene.webp", { type: "image/webp" });
    await FilePicker.upload("data", dir, file, { bucket: null });

    await game.settings.set(MOD, "lastSrc", src);
    console.log(`[${MOD}] mirrored -> Data/${dir}/current-scene.webp`);
  } catch (e) {
    console.error(`[${MOD}] mirror failed`, e);
    ui.notifications?.warn(`Scene Mirror failed: ${e.message}`);
  }
}

/* ================== JSON Build/Write ================== */
function getRelevantCombat() {
  const viewed = ui.combat?.viewed;
  if (viewed) return viewed;
  return game.combats.find(c => c?.started === true) || null;
}

function buildCombatPayload(c) {
  if (!c || !c.started) {
    return {
      version: MOD_VERSION,
      status: { active: false },
      updatedAt: new Date().toISOString(),
      turns: []
    };
  }

  const srcList = Array.isArray(c.turns) && c.turns.length ? c.turns : (c.combatants?.contents || []);
  const list = srcList.filter(t => t?.id).map((t, idx) => {
    const hp = extractHP_dnd5e(t.actor);
    const abil = extractAbilities_dnd5e(t.actor);
    const ac = extractAC_dnd5e(t.actor, abil.abilities);
    return {
      id: t.id,
      name: t.token?.name || t.actor?.name || t.name,
      initiative: t.initiative ?? null,
      img: t.token?.texture?.src || t.actor?.img || null,
      actorId: t.actor?.id ?? null,
      tokenId: t.token?.id ?? null,
      isNPC: !!t.actor && !t.actor.hasPlayerOwner,
      active: false,
      order: idx,
      hp: hp.hp,
      hpMax: hp.hpMax,
      tempHP: hp.tempHP,
      tempMax: hp.tempMax,
      condition: hp.condition,
      ac: ac,
      abilities: abil.abilities,
      proficiencyBonus: abil.proficiencyBonus
    };
  });

  const i = Number.isInteger(c.turn) ? c.turn : -1;
  if (i >= 0 && i < list.length) list[i].active = true;

  return {
    version: MOD_VERSION,
    status: { active: true },
    scene: c.scene?.name ?? game.scenes?.get(c.sceneId)?.name ?? null,
    round: c.round ?? 0,
    turn: c.turn ?? 0,
    combatId: c.id,
    updatedAt: new Date().toISOString(),
    turns: list
  };
}

async function writeCombatJSON(payload) {
  if (!game.user.isGM) return;
  const dir = targetDir();
  await ensureDir(dir);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const file = new File([blob], "combat.json", { type: "application/json" });
  await FilePicker.upload("data", dir, file, { bucket: null });
  console.log(`[${MOD}] wrote combat.json (active=${payload.status.active})`);
}

/* debounce to avoid double-writes from multiple hooks */
let _syncTimer = null;
function scheduleSync() {
  if (_syncTimer) clearTimeout(_syncTimer);
  _syncTimer = setTimeout(async () => {
    _syncTimer = null;
    try { await writeCombatJSON(buildCombatPayload(getRelevantCombat())); }
    catch (e) { console.warn(`[${MOD}] sync failed`, e); }
  }, 120);
}

/* ================== Hooks ================== */
Hooks.once("ready", () => {
  mirrorActiveScene();
  scheduleSync(); // inactive unless started

  // Scene updates
  Hooks.on("canvasReady", () => mirrorActiveScene());
  Hooks.on("updateScene", (scene, changes) => {
    if (!scene.active) return;
    if (changes.active || changes.img || (changes.background && changes.background.src)) mirrorActiveScene();
  });

  // Combat lifecycle + turn/round changes
  Hooks.on("createCombat", () => scheduleSync());
  Hooks.on("deleteCombat", () => scheduleSync());
  Hooks.on("updateCombat", (combat, changes) => {
    if (typeof changes.started !== "undefined" ||
        typeof changes.turn !== "undefined" ||
        typeof changes.round !== "undefined") {
      scheduleSync();
    } else if (combat.started) {
      scheduleSync();
    }
  });
  Hooks.on("combatTurn", () => scheduleSync());   // extra robustness
  Hooks.on("combatRound", () => scheduleSync());  // extra robustness

  // Roster and initiative edits
  Hooks.on("createCombatant", () => scheduleSync());
  Hooks.on("updateCombatant", () => scheduleSync());
  Hooks.on("deleteCombatant", () => scheduleSync());

  // When GM switches the viewed combat in the tracker
  Hooks.on("renderCombatTracker", () => scheduleSync());
});
