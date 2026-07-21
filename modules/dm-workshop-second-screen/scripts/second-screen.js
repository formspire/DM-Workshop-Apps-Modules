const MODULE_ID = "dm-workshop-second-screen";
const TOOL_NAME = "dmw-second-screen";

const PARAM_DISPLAY = "dmwDisplay";
const PARAM_TARGET_USER = "dmwTargetUser";
const PARAM_VIEW_MODE = "dmwViewMode";
const PARAM_LOCK = "dmwLock";
const PARAM_FOLLOW = "dmwFollow";
const PARAM_FOG = "dmwFog";
const PARAM_SMOOTHING = "dmwSmoothing";
const DISPLAY_WINDOW_NAME = "dm-workshop-second-screen-display";

const startupUrl = new URL(window.location.href);
const displayRequested = startupUrl.searchParams.get(PARAM_DISPLAY) === "1";

if (displayRequested) document.documentElement.classList.add("dmw-display-requested");

const state = {
  active: false,
  targetUserId: null,
  sourceTokenIds: new Set(),
  screens: [],
  options: {
    viewMode: "character",
    lockInteraction: true,
    followToken: true,
    fogMode: "current",
    smoothing: "smooth"
  },
  refreshTimer: null,
  strictRefreshQueued: false,
  followFrame: null,
  followUntil: 0,
  camera: null
};

Hooks.once("init", () => {
  registerClientSetting("lastUserId", String, "");
  registerClientSetting("lastViewMode", String, "character");
  registerClientSetting("lastScreenKey", String, "");
  registerClientSetting("lastSmoothing", String, "smooth");

  game.keybindings.register(MODULE_ID, "exitDisplay", {
    name: "DM Workshop Second Screen: Close Display",
    hint: "Press Shift+Escape from the clean display to close it.",
    editable: [{ key: "Escape", modifiers: ["Shift"] }],
    onDown: () => {
      if (!state.active) return false;
      exitDisplayMode({ closeWindow: true });
      return true;
    }
  });
});

Hooks.on("getSceneControlButtons", controls => {
  if (!game.user?.isGM || displayRequested) return;

  const tokenControls = controls.tokens
    ?? Object.values(controls).find(control => control?.name === "tokens");
  if (!tokenControls?.tools) return;

  tokenControls.tools[TOOL_NAME] = {
    name: TOOL_NAME,
    title: "Open DM Workshop Second Screen",
    icon: "fa-solid fa-display",
    order: Object.keys(tokenControls.tools).length,
    button: true,
    visible: true,
    onChange: () => openLauncherDialog()
  };
});

Hooks.once("ready", async () => {
  game.modules.get(MODULE_ID).api = {
    openLauncherDialog,
    openDisplayWindow,
    enterDisplayMode,
    exitDisplayMode,
    refreshPlayerView
  };

  if (!displayRequested) return;

  await enterDisplayMode({
    targetUserId: startupUrl.searchParams.get(PARAM_TARGET_USER),
    viewMode: startupUrl.searchParams.get(PARAM_VIEW_MODE) || "character",
    lockInteraction: startupUrl.searchParams.get(PARAM_LOCK) !== "0",
    followToken: startupUrl.searchParams.get(PARAM_FOLLOW) !== "0",
    fogMode: startupUrl.searchParams.get(PARAM_FOG) || "current",
    smoothing: startupUrl.searchParams.get(PARAM_SMOOTHING) || "smooth"
  });
});

Hooks.on("canvasReady", () => {
  if (!state.active) return;
  scheduleRefresh({ recenter: true, delay: 120 });
});

Hooks.on("updateToken", (tokenDocument, changes) => {
  if (!state.active) return;

  const moved = "x" in changes || "y" in changes || "elevation" in changes;
  const sourceMoved = state.sourceTokenIds.has(tokenDocument.id) && moved;

  if (sourceMoved) {
    scheduleStrictVisibility();
    if (state.options.followToken) startSmoothFollow(1800);
    return;
  }

  scheduleRefresh({ delay: 55 });
});

for (const hook of [
  "createToken", "deleteToken", "updateWall", "createWall", "deleteWall",
  "updateAmbientLight", "createAmbientLight", "deleteAmbientLight"
]) {
  Hooks.on(hook, () => state.active && scheduleRefresh({ delay: 80 }));
}

Hooks.on("visibilityRefresh", () => state.active && scheduleStrictVisibility());
Hooks.on("sightRefresh", () => state.active && scheduleStrictVisibility());

async function openLauncherDialog() {
  if (!game.user?.isGM) return;

  const users = game.users
    .filter(user => !user.isGM)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!users.length) {
    ui.notifications.warn("Create at least one player user so the module knows which character or owned tokens to use.");
    return;
  }

  state.screens = await discoverScreens();

  const lastUserId = game.settings.get(MODULE_ID, "lastUserId");
  const selectedId = users.some(user => user.id === lastUserId) ? lastUserId : users[0].id;
  const lastViewMode = game.settings.get(MODULE_ID, "lastViewMode") || "character";
  const lastScreenKey = game.settings.get(MODULE_ID, "lastScreenKey");
  const lastSmoothing = game.settings.get(MODULE_ID, "lastSmoothing") || "smooth";

  const selectedScreenKey = state.screens.some(screen => screen.key === lastScreenKey)
    ? lastScreenKey
    : (state.screens.find(screen => !screen.isPrimary)?.key ?? state.screens[0]?.key ?? "current");

  const userOptions = users.map(user => {
    const character = user.character?.name
      ? ` · ${escapeHtml(user.character.name)}`
      : " · no assigned character";
    return `<option value="${user.id}" ${user.id === selectedId ? "selected" : ""}>${escapeHtml(user.name)}${character}</option>`;
  }).join("");

  const screenOptions = state.screens.map(screen => {
    const selected = screen.key === selectedScreenKey ? "selected" : "";
    return `<option value="${escapeHtml(screen.key)}" ${selected}>${escapeHtml(screen.label)}</option>`;
  }).join("");

  const content = `
    <div class="dmw-launcher">
      <p class="dmw-intro">Choose the tabletop perspective and the monitor where it should appear. No player needs to log in.</p>

      <div class="form-group">
        <label for="dmw-user">Player view</label>
        <select id="dmw-user" name="userId">${userOptions}</select>
      </div>

      <div class="form-group">
        <label for="dmw-view-mode">Vision source</label>
        <select id="dmw-view-mode" name="viewMode">
          <option value="character" ${lastViewMode === "character" ? "selected" : ""}>Assigned character token</option>
          <option value="owned" ${lastViewMode === "owned" ? "selected" : ""}>All tokens that player owns</option>
        </select>
      </div>

      <div class="form-group">
        <label for="dmw-screen">Display monitor</label>
        <select id="dmw-screen" name="screenKey">${screenOptions}</select>
      </div>

      <div class="form-group">
        <label for="dmw-smoothing">Camera follow</label>
        <select id="dmw-smoothing" name="smoothing">
          <option value="smooth" ${lastSmoothing === "smooth" ? "selected" : ""}>Smooth</option>
          <option value="cinematic" ${lastSmoothing === "cinematic" ? "selected" : ""}>Cinematic</option>
          <option value="instant" ${lastSmoothing === "instant" ? "selected" : ""}>Instant</option>
        </select>
      </div>

      <div class="form-group">
        <label for="dmw-fog-mode">Fog display</label>
        <select id="dmw-fog-mode" name="fogMode">
          <option value="current" selected>Current line of sight only</option>
          <option value="gm">Use the GM window's explored fog</option>
        </select>
      </div>

      <label class="checkbox">
        <input type="checkbox" name="fullscreen" checked>
        Fill the selected monitor and request borderless fullscreen
      </label>

      <label class="checkbox">
        <input type="checkbox" name="lockInteraction" checked>
        Lock the tabletop window so nobody moves anything accidentally
      </label>

      <label class="checkbox">
        <input type="checkbox" name="followToken" checked>
        Keep the assigned character token centered
      </label>

      <p class="notes"><strong>Best result:</strong> launch the GM view through the Foundry desktop application. A normal web browser may keep a small amount of browser chrome until fullscreen permission is granted.</p>
    </div>`;

  await foundry.applications.api.DialogV2.input({
    window: { title: "DM Workshop Second Screen" },
    content,
    ok: {
      label: "Open on Selected Monitor",
      icon: "fa-solid fa-display",
      callback: (_event, button) => {
        const form = button.form.elements;
        const options = {
          targetUserId: form.userId.value,
          viewMode: form.viewMode.value,
          screenKey: form.screenKey.value,
          smoothing: form.smoothing.value,
          fogMode: form.fogMode.value,
          fullscreen: form.fullscreen.checked,
          lockInteraction: form.lockInteraction.checked,
          followToken: form.followToken.checked
        };

        // Call during the actual button gesture so popup and fullscreen permissions have the best chance to succeed.
        void openDisplayWindow(options);
        void rememberLauncherOptions(options);
        return options;
      }
    },
    rejectClose: false,
    modal: true
  });
}

async function rememberLauncherOptions(options) {
  await Promise.all([
    game.settings.set(MODULE_ID, "lastUserId", options.targetUserId),
    game.settings.set(MODULE_ID, "lastViewMode", options.viewMode),
    game.settings.set(MODULE_ID, "lastScreenKey", options.screenKey),
    game.settings.set(MODULE_ID, "lastSmoothing", options.smoothing)
  ]);
}

async function openDisplayWindow(options = {}) {
  const targetUser = game.users.get(options.targetUserId);
  if (!targetUser) {
    ui.notifications.error("The selected player user could not be found.");
    return null;
  }

  const sourceTokens = findSourceTokens(targetUser, options.viewMode || "character");
  if (!sourceTokens.length) {
    const detail = options.viewMode === "owned"
      ? `${targetUser.name} does not own any visible tokens on the current scene.`
      : `${targetUser.name} has no visible assigned-character token on the current scene.`;
    ui.notifications.warn(detail);
    return null;
  }

  const screen = state.screens.find(item => item.key === options.screenKey)
    ?? state.screens.find(item => !item.isPrimary)
    ?? state.screens[0]
    ?? currentScreenFallback();
  const bounds = screenBounds(screen);

  const url = new URL(window.location.href);
  url.searchParams.set(PARAM_DISPLAY, "1");
  url.searchParams.set(PARAM_TARGET_USER, targetUser.id);
  url.searchParams.set(PARAM_VIEW_MODE, options.viewMode || "character");
  url.searchParams.set(PARAM_LOCK, options.lockInteraction === false ? "0" : "1");
  url.searchParams.set(PARAM_FOLLOW, options.followToken === false ? "0" : "1");
  url.searchParams.set(PARAM_FOG, options.fogMode === "gm" ? "gm" : "current");
  url.searchParams.set(PARAM_SMOOTHING, normalizeSmoothing(options.smoothing));

  const features = [
    "popup=yes",
    `left=${Math.round(bounds.left)}`,
    `top=${Math.round(bounds.top)}`,
    `width=${Math.round(bounds.width)}`,
    `height=${Math.round(bounds.height)}`,
    "resizable=yes",
    "scrollbars=no",
    "menubar=no",
    "toolbar=no",
    "location=no",
    "status=no",
    "frame=no",
    "fullscreen=yes",
    "autoHideMenuBar=yes",
    "backgroundColor=#000000"
  ].join(",");

  // A blank host window lets us place the Foundry player view inside a clean shell.
  // Electron understands several extra feature flags above; browsers safely ignore them.
  const hostWindow = window.open("about:blank", DISPLAY_WINDOW_NAME, features);

  if (!hostWindow) {
    ui.notifications.warn("The second-screen window was blocked. Allow popups for your Foundry address and try again.");
    return null;
  }

  try {
    hostWindow.moveTo(bounds.left, bounds.top);
    hostWindow.resizeTo(bounds.width, bounds.height);
  } catch (_error) {
    // Some browsers restrict window placement even after permission is granted.
  }

  installDisplayShell(hostWindow, url.toString(), {
    fullscreen: options.fullscreen !== false,
    bounds,
    targetUserName: targetUser.name,
    screenLabel: screen.label
  });

  try { hostWindow.focus(); } catch (_error) { /* Browser may deny focus. */ }
  ui.notifications.info(`Opening ${targetUser.name}'s tabletop view on ${screen.label}.`);
  return hostWindow;
}

function installDisplayShell(hostWindow, displayUrl, options) {
  const doc = hostWindow.document;
  doc.open();
  doc.write(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>DM Workshop Table View</title>
  <style>
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #000; }
    body { font-family: Arial, sans-serif; }
    #dmw-frame { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; background: #000; }
    #dmw-shell-overlay { position: fixed; inset: 0; z-index: 10; display: grid; place-items: center; background: #08070d; color: #f4efe5; }
    #dmw-shell-card { width: min(520px, calc(100vw - 40px)); padding: 24px; border: 1px solid #64536f; border-radius: 12px; background: #17121d; text-align: center; box-shadow: 0 18px 60px rgba(0,0,0,.55); }
    #dmw-shell-card h1 { margin: 0 0 8px; font-size: 22px; }
    #dmw-shell-card p { margin: 8px 0; line-height: 1.45; color: #d8cfe0; }
    #dmw-fullscreen-button { display: none; margin: 16px auto 0; padding: 11px 18px; border: 1px solid #f2a65a; border-radius: 7px; background: #2c1d34; color: #fff; font-weight: 700; cursor: pointer; }
  </style>
</head>
<body>
  <iframe id="dmw-frame" allow="fullscreen" allowfullscreen></iframe>
  <div id="dmw-shell-overlay">
    <div id="dmw-shell-card">
      <h1>DM Workshop Table View</h1>
      <p>Loading ${escapeHtml(options.targetUserName)} on ${escapeHtml(options.screenLabel)}…</p>
      <p id="dmw-shell-status">Preparing the clean player canvas.</p>
      <button id="dmw-fullscreen-button" type="button">Enter Fullscreen</button>
    </div>
  </div>
</body>
</html>`);
  doc.close();

  const iframe = doc.getElementById("dmw-frame");
  const overlay = doc.getElementById("dmw-shell-overlay");
  const status = doc.getElementById("dmw-shell-status");
  const fullscreenButton = doc.getElementById("dmw-fullscreen-button");

  const requestFullscreen = async () => {
    try {
      if (!hostWindow.document.fullscreenElement) {
        await hostWindow.document.documentElement.requestFullscreen({ navigationUI: "hide" });
      }
      fullscreenButton.style.display = "none";
      status.textContent = "Fullscreen active. Loading the player canvas.";
      return true;
    } catch (_error) {
      fullscreenButton.style.display = "inline-block";
      status.textContent = "Your browser needs one click to grant fullscreen. The Foundry desktop app usually opens borderless automatically.";
      return false;
    }
  };

  fullscreenButton.addEventListener("click", requestFullscreen);
  hostWindow.addEventListener("keydown", event => {
    if (event.shiftKey && event.key === "Escape") hostWindow.close();
  });

  iframe.addEventListener("load", () => {
    window.setTimeout(() => {
      overlay.style.opacity = "0";
      overlay.style.pointerEvents = "none";
      overlay.style.transition = "opacity 220ms ease";
      window.setTimeout(() => overlay.remove(), 240);
    }, 300);
  }, { once: true });

  if (options.fullscreen) void requestFullscreen();
  iframe.src = displayUrl;
}

async function enterDisplayMode(options = {}) {
  const targetUser = game.users.get(options.targetUserId);
  if (!targetUser) {
    document.documentElement.classList.remove("dmw-display-requested");
    await showDisplayError("The player selected for this display no longer exists.");
    return;
  }

  state.active = true;
  state.targetUserId = targetUser.id;
  state.options = {
    viewMode: options.viewMode === "owned" ? "owned" : "character",
    lockInteraction: options.lockInteraction !== false,
    followToken: options.followToken !== false,
    fogMode: options.fogMode === "gm" ? "gm" : "current",
    smoothing: normalizeSmoothing(options.smoothing)
  };

  document.documentElement.classList.remove("dmw-display-requested");
  document.documentElement.classList.add("dmw-secondary-screen");
  document.body?.classList.add("dmw-secondary-screen");
  document.body?.classList.toggle("dmw-display-locked", state.options.lockInteraction);
  document.title = `Table View · ${targetUser.name}`;

  closeOpenApplications();

  if (canvas?.ready) await refreshPlayerView({ recenter: true });
}

function exitDisplayMode({ closeWindow = false } = {}) {
  state.active = false;
  clearTimeout(state.refreshTimer);
  stopSmoothFollow();

  if (closeWindow) {
    if (window.parent && window.parent !== window) {
      try { window.parent.close(); } catch (_error) { /* Same-origin shell should be closable. */ }
      return;
    }
    if (window.opener) {
      window.close();
      return;
    }
  }

  const url = new URL(window.location.href);
  for (const key of [
    PARAM_DISPLAY, PARAM_TARGET_USER, PARAM_VIEW_MODE, PARAM_LOCK,
    PARAM_FOLLOW, PARAM_FOG, PARAM_SMOOTHING
  ]) {
    url.searchParams.delete(key);
  }
  window.location.href = url.toString();
}

async function refreshPlayerView({ recenter = false } = {}) {
  if (!state.active || !canvas?.ready) return;

  const targetUser = game.users.get(state.targetUserId);
  if (!targetUser) return;

  const sourceTokens = findSourceTokens(targetUser, state.options.viewMode);
  state.sourceTokenIds = new Set(sourceTokens.map(token => token.document.id));

  if (!sourceTokens.length) {
    await showDisplayError(`${targetUser.name} has no usable token on this scene.`);
    return;
  }

  try {
    canvas.tokens?.releaseAll?.();
  } catch (_error) {
    for (const token of canvas.tokens?.controlled ?? []) token.release();
  }

  sourceTokens.forEach((token, index) => {
    try {
      token.control({ releaseOthers: index === 0, pan: false });
    } catch (_error) {
      token.control({ releaseOthers: index === 0 });
    }
  });

  try {
    canvas.perception?.update?.({ initializeVision: true, refreshVision: true });
  } catch (_error) {
    canvas.visibility?.initializeSources?.();
    canvas.visibility?.refreshVisibility?.();
  }

  await nextFrame();
  await nextFrame();

  applyFogMode();
  try { canvas.visibility?.restrictVisibility?.(); } catch (_error) { /* Cosmetic safety pass below. */ }
  applyStrictVisibility();

  if (recenter) centerImmediately(sourceTokens[0]);
  else if (state.options.followToken) startSmoothFollow(1000);
}

function findSourceTokens(targetUser, viewMode = "character") {
  if (!targetUser || !canvas?.ready || !canvas.tokens) return [];

  const tokens = canvas.tokens.placeables.filter(token => !token.document.hidden && token.actor);

  if (viewMode === "owned") {
    return tokens.filter(token => {
      try {
        return token.actor.testUserPermission(targetUser, "OWNER")
          || token.document.testUserPermission(targetUser, "OWNER");
      } catch (_error) {
        return false;
      }
    });
  }

  const actorId = targetUser.character?.id;
  if (!actorId) return [];
  return tokens.filter(token => token.actor?.id === actorId);
}

function applyFogMode() {
  const showExploredFog = state.options.fogMode === "gm";
  const exploredObjects = [
    canvas.visibility?.explored,
    canvas.fog?.sprite,
    canvas.visibility?.layers?.explored
  ].filter(Boolean);

  for (const object of exploredObjects) {
    try {
      object.visible = showExploredFog;
      object.renderable = showExploredFog;
    } catch (_error) { /* Version-specific display object. */ }
  }
}

function applyStrictVisibility() {
  if (!state.active || !canvas?.ready) return;

  const sourceIds = state.sourceTokenIds;
  const targetUser = game.users.get(state.targetUserId);

  for (const token of canvas.tokens?.placeables ?? []) {
    const isSource = sourceIds.has(token.document.id);
    const hidden = Boolean(token.document.hidden);
    let inSight = false;

    if (!hidden) {
      try {
        const points = token.document.getVisibilityTestPoints?.()
          ?? token.getVisibilityTestPoints?.()
          ?? [token.center ?? token.getCenterPoint?.()];
        inSight = canvas.visibility?.testVisibility?.(points, { object: token, tolerance: 2 }) ?? false;
      } catch (_error) {
        inSight = false;
      }
    }

    const show = isSource || (!hidden && inSight);
    setDisplayObjectVisible(token, show);

    for (const decoration of [token.border, token.nameplate, token.bars, token.tooltip, token.target]) {
      if (!decoration) continue;
      try {
        decoration.visible = false;
        decoration.renderable = false;
      } catch (_error) { /* Optional token decoration. */ }
    }

    if (show && token.effects) {
      try {
        token.effects.visible = true;
        token.effects.renderable = true;
      } catch (_error) { /* Optional effects container. */ }
    }
  }

  for (const layerName of ["tiles", "drawings", "notes", "templates", "regions"]) {
    const layer = canvas[layerName];
    for (const placeable of layer?.placeables ?? []) {
      if (placeable.document?.hidden) setDisplayObjectVisible(placeable, false);
    }
  }

  for (const object of [
    canvas.controls?.doors,
    canvas.controls?.ruler,
    canvas.interface?.doors,
    canvas.interface?.ruler
  ]) {
    if (!object) continue;
    try {
      object.visible = false;
      object.renderable = false;
    } catch (_error) { /* Version-specific interface object. */ }
  }

  if (targetUser) document.body?.setAttribute("data-dmw-player-view", targetUser.id);
}

function setDisplayObjectVisible(object, visible) {
  if (!object) return;
  try { object.visible = visible; } catch (_error) { /* PIXI object may expose only renderable. */ }
  try { object.renderable = visible; } catch (_error) { /* Optional property. */ }
  if (object.mesh) {
    try { object.mesh.visible = visible; } catch (_error) { /* Optional mesh. */ }
    try { object.mesh.renderable = visible; } catch (_error) { /* Optional mesh. */ }
  }
}

function scheduleRefresh({ recenter = false, delay = 60 } = {}) {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = window.setTimeout(() => refreshPlayerView({ recenter }), delay);
}

function scheduleStrictVisibility() {
  if (state.strictRefreshQueued) return;
  state.strictRefreshQueued = true;
  requestAnimationFrame(() => {
    state.strictRefreshQueued = false;
    applyFogMode();
    applyStrictVisibility();
  });
}

function centerImmediately(token) {
  if (!token || !canvas?.ready) return;
  const center = tokenCenter(token);
  const scale = currentCanvasView().scale;
  state.camera = { x: center.x, y: center.y, scale };
  canvas.pan(state.camera);
}

function startSmoothFollow(duration = 1400) {
  if (!state.active || !state.options.followToken || !canvas?.ready) return;
  state.followUntil = Math.max(state.followUntil, performance.now() + duration);
  if (state.followFrame) return;

  if (!state.camera) state.camera = currentCanvasView();
  let previous = performance.now();

  const step = now => {
    state.followFrame = null;
    if (!state.active || !state.options.followToken || !canvas?.ready) return;

    const token = primarySourceToken();
    if (!token) return;

    const target = tokenCenter(token);
    const view = state.camera ?? currentCanvasView();
    const dt = Math.min(50, Math.max(1, now - previous));
    previous = now;

    const smoothingMs = smoothingDuration(state.options.smoothing);
    const alpha = smoothingMs <= 0 ? 1 : 1 - Math.exp(-dt / smoothingMs);
    const nextX = view.x + (target.x - view.x) * alpha;
    const nextY = view.y + (target.y - view.y) * alpha;
    const distance = Math.hypot(target.x - nextX, target.y - nextY);

    state.camera = {
      x: distance < 0.2 ? target.x : nextX,
      y: distance < 0.2 ? target.y : nextY,
      scale: currentCanvasView().scale
    };

    canvas.pan(state.camera);

    const shouldContinue = now < state.followUntil || distance > 0.35;

    if (shouldContinue) state.followFrame = requestAnimationFrame(step);
  };

  state.followFrame = requestAnimationFrame(step);
}

function stopSmoothFollow() {
  if (state.followFrame) cancelAnimationFrame(state.followFrame);
  state.followFrame = null;
  state.followUntil = 0;
}

function primarySourceToken() {
  const id = state.sourceTokenIds.values().next().value;
  return id ? canvas.tokens?.get?.(id) ?? canvas.tokens?.placeables?.find(token => token.id === id) : null;
}

function tokenCenter(token) {
  return token.center ?? token.getCenterPoint?.() ?? {
    x: token.document.x + ((token.document.width ?? 1) * (canvas.grid?.size ?? 0) / 2),
    y: token.document.y + ((token.document.height ?? 1) * (canvas.grid?.size ?? 0) / 2)
  };
}

function currentCanvasView() {
  const view = canvas.scene?._viewPosition ?? {};
  return {
    x: Number.isFinite(view.x) ? view.x : (canvas.stage?.pivot?.x ?? 0),
    y: Number.isFinite(view.y) ? view.y : (canvas.stage?.pivot?.y ?? 0),
    scale: Number.isFinite(view.scale) ? view.scale : (canvas.stage?.scale?.x ?? 1)
  };
}

function normalizeSmoothing(value) {
  return ["smooth", "cinematic", "instant"].includes(value) ? value : "smooth";
}

function smoothingDuration(value) {
  if (value === "cinematic") return 320;
  if (value === "instant") return 0;
  return 165;
}

async function discoverScreens() {
  try {
    if (typeof window.getScreenDetails === "function") {
      const details = await window.getScreenDetails();
      const screens = Array.from(details.screens ?? []).map((screen, index) => normalizeScreen(screen, index));
      if (screens.length) return screens;
    }
  } catch (_error) {
    ui.notifications.info("Monitor permission was not granted, so only the current display can be selected.");
  }

  return [currentScreenFallback()];
}

function normalizeScreen(screen, index) {
  const width = screen.width ?? screen.availWidth ?? window.screen.width;
  const height = screen.height ?? screen.availHeight ?? window.screen.height;
  const left = screen.left ?? screen.availLeft ?? 0;
  const top = screen.top ?? screen.availTop ?? 0;
  const isPrimary = Boolean(screen.isPrimary);
  const rawLabel = String(screen.label ?? "").trim();
  const label = `${rawLabel || `Screen ${index + 1}`} · ${width}×${height}${isPrimary ? " · Primary" : ""}`;

  return {
    key: `${left}:${top}:${width}:${height}`,
    label,
    left,
    top,
    width,
    height,
    availLeft: screen.availLeft ?? left,
    availTop: screen.availTop ?? top,
    availWidth: screen.availWidth ?? width,
    availHeight: screen.availHeight ?? height,
    isPrimary
  };
}

function currentScreenFallback() {
  const screen = window.screen;
  const left = screen.availLeft ?? screen.left ?? 0;
  const top = screen.availTop ?? screen.top ?? 0;
  const width = screen.availWidth ?? screen.width;
  const height = screen.availHeight ?? screen.height;
  return {
    key: `${left}:${top}:${width}:${height}`,
    label: `Current screen · ${screen.width}×${screen.height}`,
    left: screen.left ?? left,
    top: screen.top ?? top,
    width: screen.width,
    height: screen.height,
    availLeft: left,
    availTop: top,
    availWidth: width,
    availHeight: height,
    isPrimary: true
  };
}

function screenBounds(screen) {
  return {
    left: Number(screen.left ?? screen.availLeft ?? 0),
    top: Number(screen.top ?? screen.availTop ?? 0),
    width: Math.max(640, Number(screen.width ?? screen.availWidth ?? 1280)),
    height: Math.max(480, Number(screen.height ?? screen.availHeight ?? 720))
  };
}

function closeOpenApplications() {
  for (const app of foundry.applications.instances?.values?.() ?? []) {
    if (!app?.rendered) continue;
    try { app.close(); } catch (_error) { /* Cosmetic cleanup only. */ }
  }

  for (const app of Object.values(ui.windows ?? {})) {
    try { app.close(); } catch (_error) { /* Cosmetic cleanup only. */ }
  }
}

async function showDisplayError(message) {
  document.documentElement.classList.remove("dmw-display-requested", "dmw-secondary-screen");
  document.body?.classList.remove("dmw-secondary-screen", "dmw-display-locked");

  await foundry.applications.api.DialogV2.prompt({
    window: { title: "Second Screen Could Not Start" },
    content: `<div class="dmw-warning"><p>${escapeHtml(message)}</p><p>Assign that user a character token on the active scene, or reopen the display using “All tokens that player owns.”</p></div>`,
    ok: { label: "Close Window" },
    rejectClose: false,
    modal: true
  });

  if (window.parent && window.parent !== window) {
    try { window.parent.close(); } catch (_error) { /* Same-origin shell. */ }
  } else if (window.opener) {
    window.close();
  }
}

function registerClientSetting(key, type, defaultValue) {
  game.settings.register(MODULE_ID, key, {
    scope: "client",
    config: false,
    type,
    default: defaultValue
  });
}

function nextFrame() {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = String(value ?? "");
  return div.innerHTML;
}
