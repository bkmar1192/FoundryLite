const MOD = "scene-mirror";

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

  // Prefer OffscreenCanvas.convertToBlob if available (faster), else fallback to toBlob
  if (C.convertToBlob) {
    return await C.convertToBlob({ type: "image/webp", quality: Math.min(Math.max(quality ?? 0.85, 0), 1) });
  }
  return await new Promise((resolve, reject) => {
    C.toBlob(b => b ? resolve(b) : reject(new Error("WEBP encode failed")), "image/webp", Math.min(Math.max(quality ?? 0.85, 0), 1));
  });
}

async function mirrorActive() {
  if (!game.user.isGM) return;
  const scene = game.scenes.active;
  const src = sceneSrc(scene);
  const last = game.settings.get(MOD, "lastSrc");
  if (!src || src === last) return;

  try {
    const abs = new URL(src, window.location.origin).href;
    const r = await fetch(abs, { cache: "no-store" });
    if (!r.ok) throw new Error(`Fetch failed ${r.status}`);
    const srcBlob = await r.blob();
    const webpBlob = await convertToWebP(srcBlob, game.settings.get(MOD, "webpQuality"));

    const dir = (game.settings.get(MOD, "targetDir") || "mirrored-scenes").replace(/^\/+|\/+$/g, "");
    try { await FilePicker.createDirectory("data", dir); } catch (_) { /* exists */ }

    const file = new File([webpBlob], "current-scene.webp", { type: "image/webp" });
    await FilePicker.upload("data", dir, file, { bucket: null });

    await game.settings.set(MOD, "lastSrc", src);
    console.log(`[${MOD}] mirrored -> Data/${dir}/current-scene.webp`);
  } catch (e) {
    console.error(`[${MOD}] mirror failed`, e);
    ui.notifications?.warn(`Scene Mirror failed: ${e.message}`);
  }
}

Hooks.once("ready", () => {
  mirrorActive();
  Hooks.on("canvasReady", () => mirrorActive());
  Hooks.on("updateScene", (scene, changes) => {
    if (!scene.active) return;
    if (changes.active || changes.img || (changes.background && changes.background.src)) mirrorActive();
  });
});
