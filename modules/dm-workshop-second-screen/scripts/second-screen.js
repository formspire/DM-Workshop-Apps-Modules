const MODULE_ID = "dm-workshop-second-screen";
const TOOL_BOX_NAME = "dmw-player-view-box";
const TOOL_SCREEN_NAME = "dmw-player-second-screen";

const PARAM_DISPLAY = "dmwDisplay";
const PARAM_TARGET_USER = "dmwTargetUser";
const PARAM_VIEW_MODE = "dmwViewMode";
const PARAM_LOCK = "dmwLock";
const PARAM_FOLLOW = "dmwFollow";
const PARAM_FOG = "dmwFog";
const PARAM_SMOOTHING = "dmwSmoothing";
const DISPLAY_WINDOW_NAME = "dm-workshop-second-screen-display";
const PREVIEW_ID = "dmw-display-preview";
const SECOND_SCREEN_ID = "dmw-second-screen-panel";
const DISPLAY_STYLE_ID = "dmw-display-suppression";
const STREAM_CHANNEL_PREFIX = "dmw-second-screen";
const SOCKET_NAME = `module.${MODULE_ID}`;
const SOCKET_TYPE_VIEWPORT = "viewport";
const SOCKET_TYPE_VIEWPORT_CLEAR = "viewport-clear";
const STREAM_FRAME_INTERVAL_MS = 67;
const STREAM_JPEG_QUALITY = 0.86;

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

  tokenControls.tools[TOOL_BOX_NAME] = {
    name: TOOL_BOX_NAME,
    title: "Create DM Workshop Player View Box",
    icon: "fa-solid fa-display",
    order: Object.keys(tokenControls.tools).length,
    button: true,
    visible: true,
    onChange: () => openQuickPlayerViewDialog("preview")
  };

  tokenControls.tools[TOOL_SCREEN_NAME] = {
    name: TOOL_SCREEN_NAME,
    title: "Open DM Workshop Second Screen",
    icon: "fa-solid fa-up-right-from-square",
    order: Object.keys(tokenControls.tools).length + 1,
    button: true,
    visible: true,
    onChange: () => openQuickPlayerViewDialog("second-screen")
  };
});

Hooks.once("ready", async () => {
  game.modules.get(MODULE_ID).api = {
    openLauncherDialog,
    openDisplayPreview,
    openSecondScreen,
    openDisplayWindow,
    enterDisplayMode,
    exitDisplayMode,
    refreshPlayerView
  };

  registerSocketHandlers();

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

async function openQuickPlayerViewDialog(action = "preview") {
  if (!game.user?.isGM) return;

  const users = game.users
    .filter(user => !user.isGM)
    .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));

  if (!users.length) {
    ui.notifications.warn("Create at least one player user so the module knows which character or owned tokens to use.");
    return;
  }

  state.screens = await discoverScreens();

  const defaults = getQuickLaunchOptions();
  const selectedUser = resolveTargetUser(defaults) ?? users[0];
  const userOptions = users.map(user => {
    const character = user.character?.name
      ? ` - ${escapeHtml(user.character.name)}`
      : " - no assigned character";
    const active = user.active ? " - online" : "";
    return `<option value="${user.id}" ${user.id === selectedUser.id ? "selected" : ""}>${escapeHtml(user.name)}${character}${active}</option>`;
  }).join("");

  const lastViewMode = defaults.viewMode;
  const content = `
    <div class="dmw-launcher dmw-launcher--quick">
      <p class="dmw-intro">Choose which Foundry player view this display should mirror. The second screen opens as another Foundry window from this same desktop session.</p>

      <div class="form-group">
        <label for="dmw-quick-user">Player view</label>
        <select id="dmw-quick-user" name="userId">${userOptions}</select>
      </div>

      <div class="form-group">
        <label for="dmw-quick-view-mode">Vision source</label>
        <select id="dmw-quick-view-mode" name="viewMode">
          <option value="character" ${lastViewMode === "character" ? "selected" : ""}>Assigned character token</option>
          <option value="owned" ${lastViewMode === "owned" ? "selected" : ""}>All tokens that player owns</option>
        </select>
      </div>
    </div>`;

  const label = action === "second-screen" ? "Open Second Screen" : "Create Player View Box";
  const icon = action === "second-screen" ? "fa-solid fa-up-right-from-square" : "fa-solid fa-display";

  await foundry.applications.api.DialogV2.input({
    window: { title: "Choose Player View" },
    content,
    ok: {
      label,
      icon,
      callback: (_event, button) => {
        const form = button.form.elements;
        const options = {
          ...defaults,
          targetUserId: form.userId.value,
          viewMode: form.viewMode.value
        };

        void rememberLauncherOptions(options);
        if (action === "second-screen") return openSecondScreen(options);
        return openDisplayPreview(options);
      }
    },
    rejectClose: false,
    modal: true
  });
}

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
      ? ` - ${escapeHtml(user.character.name)}`
      : " - no assigned character";
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

      <p class="notes"><strong>Alpha note:</strong> use Player View Box for a draggable GM control frame, then open Second Screen for the live clean display.</p>
    </div>`;

  await foundry.applications.api.DialogV2.input({
    window: { title: "DM Workshop Second Screen" },
    content,
    ok: {
      label: "Open Table Preview",
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

        void openDisplayPreview(options);
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

async function openDisplayPreview(options = {}) {
  const prepared = prepareDisplayLaunch(options);
  if (!prepared) return null;

  return createDisplayPreview(prepared, options);
}

function openSecondScreen(options = {}) {
  const prepared = prepareDisplayLaunch(options);
  if (!prepared) return null;

  const displayTarget = getDisplayTarget(options);
  const hostWindow = openBlankDisplayWindow(displayTarget, prepared.displayUrl);
  void openDisplayWindow(options, { hostWindow, prepared, ...displayTarget });
  return hostWindow;
}

function createSecondScreenPanel(prepared, options = {}) {
  document.getElementById(SECOND_SCREEN_ID)?.remove();

  const panel = document.createElement("section");
  panel.id = SECOND_SCREEN_ID;
  panel.className = "dmw-second-panel";
  panel.innerHTML = `
    <header class="dmw-second-panel__bar">
      <div class="dmw-second-panel__title">
        <i class="fa-solid fa-up-right-from-square"></i>
        <span>Second Screen</span>
      </div>
      <div class="dmw-second-panel__actions">
        <button type="button" data-action="popout" title="Move this second screen to a separate browser window">
          <i class="fa-solid fa-window-restore"></i>
          <span>Pop Out</span>
        </button>
        <button type="button" data-action="fullscreen" title="Fullscreen this second screen">
          <i class="fa-solid fa-expand"></i>
          <span>Fullscreen</span>
        </button>
        <button type="button" data-action="close" title="Close second screen">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
    </header>
    <div class="dmw-second-panel__stage">
      <canvas class="dmw-second-panel__stream" aria-label="DM Workshop second screen"></canvas>
      <div class="dmw-second-panel__status">Waiting for Player View Box stream...</div>
    </div>`;

  document.body.appendChild(panel);
  makePanelDraggable(panel, ".dmw-second-panel__bar");

  const stream = panel.querySelector(".dmw-second-panel__stream");
  const streamContext = stream.getContext("2d");
  const frameImage = new Image();
  const status = panel.querySelector(".dmw-second-panel__status");
  let lastFrameAt = 0;
  let idleTimer = null;
  let channel = null;

  const setStatus = message => {
    if (status) status.textContent = message;
  };

  if (typeof BroadcastChannel !== "function") {
    setStatus("This browser cannot mirror the player display stream.");
  } else if (!streamContext) {
    setStatus("This browser cannot draw the player display canvas.");
  } else {
    channel = new BroadcastChannel(prepared.channelName);
    channel.addEventListener("message", event => {
      const message = event.data ?? {};
      if (message.type === "frame" && message.src) {
        frameImage.onload = () => {
          const width = Math.max(1, Number(message.width) || frameImage.naturalWidth || frameImage.width);
          const height = Math.max(1, Number(message.height) || frameImage.naturalHeight || frameImage.height);
          if (stream.width !== width) stream.width = width;
          if (stream.height !== height) stream.height = height;
          streamContext.drawImage(frameImage, 0, 0, width, height);
        };
        frameImage.src = message.src;
        lastFrameAt = Date.now();
        panel.classList.add("is-connected");
        panel.classList.remove("is-idle");
      } else if (message.type === "closed") {
        setStatus("The Player View Box was closed.");
        panel.classList.remove("is-connected");
        panel.classList.add("is-idle");
      }
    });
    idleTimer = window.setInterval(() => {
      if (!lastFrameAt || Date.now() - lastFrameAt < 3000) return;
      setStatus("The Player View Box stream paused.");
      panel.classList.remove("is-connected");
      panel.classList.add("is-idle");
    }, 1000);
  }

  const cleanup = () => {
    try { channel?.close(); } catch (_error) { /* Channel may already be closed. */ }
    if (idleTimer) window.clearInterval(idleTimer);
    idleTimer = null;
    panel.remove();
  };
  panel._dmwCleanupSecondPanel = cleanup;

  panel.querySelector('[data-action="fullscreen"]').addEventListener("click", () => {
    void panel.requestFullscreen?.({ navigationUI: "hide" });
  });
  panel.querySelector('[data-action="popout"]').addEventListener("click", () => {
    popOutSecondScreenPanel(panel, prepared, options);
  });
  panel.querySelector('[data-action="close"]').addEventListener("click", () => {
    const ownerWindow = panel.ownerDocument?.defaultView;
    cleanup();
    if (ownerWindow && ownerWindow !== window && !ownerWindow.closed) ownerWindow.close();
  });

  ui.notifications.info("Second Screen panel opened. Use Fullscreen or Pop Out from its header.");
  return panel;
}

function popOutSecondScreenPanel(panel, prepared, options = {}) {
  if (!panel || !panel.isConnected) return null;

  const displayTarget = getDisplayTarget(options);
  const hostWindow = openBlankDisplayWindow(displayTarget, "about:blank");
  if (!hostWindow) {
    ui.notifications.warn("The browser blocked the pop-out window. Use the in-game Second Screen panel or allow popups for Foundry.");
    return null;
  }

  try {
    hostWindow.moveTo(displayTarget.bounds.left, displayTarget.bounds.top);
    hostWindow.resizeTo(displayTarget.bounds.width, displayTarget.bounds.height);
  } catch (_error) {
    // Browser window placement is permission-gated.
  }

  const targetDocument = hostWindow.document;
  targetDocument.open();
  targetDocument.write(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>DM Workshop Second Screen</title>
  <style>
    html, body {
      width: 100%;
      height: 100%;
      margin: 0;
      overflow: hidden;
      background: #000;
      color: #f4efe5;
      font-family: Arial, sans-serif;
    }
    .dmw-second-panel {
      position: fixed !important;
      inset: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      min-width: 0 !important;
      min-height: 0 !important;
      display: grid !important;
      grid-template-rows: auto 1fr !important;
      overflow: hidden !important;
      resize: none !important;
      border: 0 !important;
      border-radius: 0 !important;
      background: #000 !important;
      box-shadow: none !important;
    }
    .dmw-second-panel__bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      min-height: 42px;
      padding: 0.45rem 0.65rem;
      border-bottom: 1px solid rgba(255,255,255,0.12);
      background: #0d0b12;
      color: #f4efe5;
      cursor: default;
      box-sizing: border-box;
    }
    .dmw-second-panel__title,
    .dmw-second-panel__actions {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .dmw-second-panel__title {
      min-width: 0;
      font-weight: 700;
    }
    .dmw-second-panel__title span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .dmw-second-panel__actions button {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      min-height: 30px;
      padding: 0.3rem 0.55rem;
      border: 1px solid rgba(255,255,255,0.18);
      border-radius: 6px;
      background: #1c1d24;
      color: #f4efe5;
      cursor: pointer;
      font: inherit;
    }
    .dmw-second-panel__actions button:hover {
      border-color: #f2a65a;
    }
    .dmw-second-panel__stage {
      position: relative;
      min-height: 0;
      overflow: hidden;
      background: #000;
    }
    .dmw-second-panel__stream {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: contain;
      background: #000;
    }
    .dmw-second-panel__status {
      position: absolute;
      left: 50%;
      top: 50%;
      max-width: min(420px, calc(100% - 32px));
      transform: translate(-50%, -50%);
      padding: 0.75rem 0.9rem;
      border: 1px solid rgba(255,255,255,0.16);
      border-radius: 6px;
      background: rgba(12,10,16,0.88);
      color: #f4efe5;
      text-align: center;
      pointer-events: none;
    }
    .dmw-second-panel.is-connected .dmw-second-panel__status {
      display: none;
    }
    .dmw-second-panel:fullscreen .dmw-second-panel__bar {
      opacity: 0;
      pointer-events: none;
    }
  </style>
</head>
<body></body>
</html>`);
  targetDocument.close();
  targetDocument.title = `DM Workshop Second Screen - ${prepared.targetUser.name}`;

  const adoptedPanel = targetDocument.adoptNode(panel);
  adoptedPanel.classList.add("is-popped-out");
  targetDocument.body.append(adoptedPanel);

  const closePopout = () => adoptedPanel._dmwCleanupSecondPanel?.();
  hostWindow.addEventListener("beforeunload", closePopout, { once: true });
  hostWindow.addEventListener("keydown", event => {
    if (event.shiftKey && event.key === "Escape") hostWindow.close();
  });

  try { hostWindow.focus(); } catch (_error) { /* Browser may deny focus. */ }
  ui.notifications.info("Second Screen moved to a pop-out window.");
  return hostWindow;
}

function createDisplayPreview(prepared, options = {}) {
  const { targetUser, sourceTokens, screen, channelName } = prepared;
  document.getElementById(PREVIEW_ID)?.remove();

  const preview = document.createElement("section");
  preview.id = PREVIEW_ID;
  preview.className = "dmw-preview";
  preview.dataset.channelName = channelName;
  preview.dataset.displayPageUrl = prepared.displayPageUrl;
  preview.innerHTML = `
    <header class="dmw-preview__bar">
      <div class="dmw-preview__title">
        <i class="fa-solid fa-display"></i>
        <span>Player View Box</span>
      </div>
      <div class="dmw-preview__actions">
        <button type="button" data-action="popout" title="Open as a separate window for another monitor">
          <i class="fa-solid fa-up-right-from-square"></i>
          <span>Pop Out</span>
        </button>
        <a class="dmw-preview__button" href="${escapeHtml(prepared.displayUrl)}" target="${DISPLAY_WINDOW_NAME}" title="Open the selected player display in a clean Foundry window">
          <i class="fa-solid fa-link"></i>
          <span>Second Screen</span>
        </a>
        <button type="button" data-action="fullscreen" title="Fullscreen this preview">
          <i class="fa-solid fa-expand"></i>
          <span>Fullscreen</span>
        </button>
        <button type="button" data-action="close" title="Close preview">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
    </header>
    <div class="dmw-preview__stage">
      <img class="dmw-preview__stream" alt="DM Workshop player display">
      <iframe class="dmw-preview__frame" title="Hidden DM Workshop player renderer" allow="fullscreen" allowfullscreen></iframe>
      <div class="dmw-preview__status">Starting player renderer...</div>
    </div>
    <footer class="dmw-preview__hint">Drag this preview inside Foundry, or use Pop Out and move the new window to ${escapeHtml(screen.label)}.</footer>`;

  document.body.appendChild(preview);
  makePreviewDraggable(preview);

  const iframe = preview.querySelector(".dmw-preview__frame");
  const stream = preview.querySelector(".dmw-preview__stream");
  const status = preview.querySelector(".dmw-preview__status");
  const cropElement = preview.querySelector(".dmw-preview__stage");
  const stopStream = startDisplayFramePump({ iframe: null, stream, status, channelName, cropElement });
  const stopViewportSync = startPreviewViewportSync(prepared, cropElement);
  preview._dmwStopStream = stopStream;
  preview._dmwStopViewportSync = stopViewportSync;
  preview.querySelector('[data-action="popout"]').addEventListener("click", () => {
    const displayTarget = getDisplayTarget(options);
    const hostWindow = openBlankDisplayWindow(displayTarget, prepared.displayUrl);
    void openDisplayWindow(options, { hostWindow, prepared, ...displayTarget });
  });
  preview.querySelector('[data-action="fullscreen"]').addEventListener("click", () => {
    void preview.requestFullscreen?.();
  });
  preview.querySelector('[data-action="close"]').addEventListener("click", () => {
    stopStream();
    stopViewportSync();
    sendViewportClear(prepared);
    preview.remove();
  });

  ui.notifications.info(`Previewing ${targetUser.name}'s tabletop view. Use Pop Out to move it to another monitor.`);
  return { preview, sourceTokens };
}

function registerSocketHandlers() {
  try {
    game.socket?.on?.(SOCKET_NAME, message => {
      void handleSocketMessage(message);
    });
  } catch (_error) {
    ui.notifications?.warn?.("DM Workshop Second Screen could not start live view-box sync.");
  }
}

async function handleSocketMessage(message) {
  if (!message || message.moduleId !== MODULE_ID) return;
  if (message.senderId === game.userId) return;
  if (!state.active || message.targetUserId !== state.targetUserId) return;

  if (message.type === SOCKET_TYPE_VIEWPORT_CLEAR) {
    scheduleRefresh({ recenter: true, delay: 80 });
    return;
  }

  if (message.type !== SOCKET_TYPE_VIEWPORT || !message.viewport) return;
  if (message.sceneId && canvas?.scene?.id && message.sceneId !== canvas.scene.id) return;

  await applySyncedViewport(message.viewport);
}

function startPreviewViewportSync(prepared, cropElement) {
  if (!game.user?.isGM || !cropElement) return () => {};

  let stopped = false;
  let lastSignature = "";
  let lastSentAt = 0;
  let frameId = null;

  const send = force => {
    if (stopped) return;
    const viewport = calculateElementViewport(cropElement);
    if (!viewport) return;

    const signature = [
      Math.round(viewport.x),
      Math.round(viewport.y),
      Math.round(viewport.worldWidth),
      Math.round(viewport.worldHeight)
    ].join(":");
    const now = Date.now();

    if (!force && signature === lastSignature && now - lastSentAt < 750) return;
    lastSignature = signature;
    lastSentAt = now;
    emitSocketMessage({
      type: SOCKET_TYPE_VIEWPORT,
      targetUserId: prepared.targetUser.id,
      sceneId: canvas.scene?.id ?? null,
      viewport
    });
  };

  const tick = () => {
    send(false);
    frameId = window.setTimeout(tick, 85);
  };

  const observer = typeof ResizeObserver === "function"
    ? new ResizeObserver(() => send(true))
    : null;
  observer?.observe(cropElement);

  send(true);
  tick();

  return () => {
    stopped = true;
    if (frameId) window.clearTimeout(frameId);
    observer?.disconnect();
  };
}

function calculateElementViewport(element) {
  if (!canvas?.ready || !element) return null;
  const boardCanvas = findBoardDomCanvas(window, document, canvas.app?.renderer);
  const boardRect = boardCanvas?.getBoundingClientRect?.();
  const elementRect = element.getBoundingClientRect?.();
  const view = currentCanvasView();

  if (!boardRect || !elementRect || !boardRect.width || !boardRect.height || !view.scale) return null;

  const left = Math.max(boardRect.left, elementRect.left);
  const top = Math.max(boardRect.top, elementRect.top);
  const right = Math.min(boardRect.right, elementRect.right);
  const bottom = Math.min(boardRect.bottom, elementRect.bottom);
  if (right <= left || bottom <= top) return null;

  const centerClientX = (left + right) / 2;
  const centerClientY = (top + bottom) / 2;
  const boardCenterX = boardRect.left + boardRect.width / 2;
  const boardCenterY = boardRect.top + boardRect.height / 2;

  return {
    x: view.x + ((centerClientX - boardCenterX) / view.scale),
    y: view.y + ((centerClientY - boardCenterY) / view.scale),
    worldWidth: (right - left) / view.scale,
    worldHeight: (bottom - top) / view.scale
  };
}

async function applySyncedViewport(viewport) {
  if (!canvas?.ready) return;
  stopSmoothFollow();

  const boardCanvas = findBoardDomCanvas(window, document, canvas.app?.renderer);
  const boardRect = boardCanvas?.getBoundingClientRect?.();
  const worldWidth = Number(viewport.worldWidth);
  const worldHeight = Number(viewport.worldHeight);
  const x = Number(viewport.x);
  const y = Number(viewport.y);
  if (!boardRect || !worldWidth || !worldHeight || !Number.isFinite(x) || !Number.isFinite(y)) return;

  const scale = Math.min(boardRect.width / worldWidth, boardRect.height / worldHeight);
  const camera = { x, y, scale };
  state.camera = camera;

  try {
    canvas.pan(camera);
  } catch (_error) {
    await canvas.animatePan?.({ ...camera, duration: 0 });
  }

  applyFogMode();
  applyStrictVisibility();
}

function sendViewportClear(prepared) {
  emitSocketMessage({
    type: SOCKET_TYPE_VIEWPORT_CLEAR,
    targetUserId: prepared.targetUser.id,
    sceneId: canvas.scene?.id ?? null
  });
}

function emitSocketMessage(message) {
  try {
    game.socket?.emit?.(SOCKET_NAME, {
      ...message,
      moduleId: MODULE_ID,
      senderId: game.userId,
      timestamp: Date.now()
    });
  } catch (_error) {
    // The local preview still works if socket sync is unavailable.
  }
}

function getQuickLaunchOptions() {
  return {
    targetUserId: game.settings.get(MODULE_ID, "lastUserId") || "",
    viewMode: game.settings.get(MODULE_ID, "lastViewMode") || "character",
    screenKey: game.settings.get(MODULE_ID, "lastScreenKey") || "",
    smoothing: game.settings.get(MODULE_ID, "lastSmoothing") || "smooth",
    fogMode: "current",
    fullscreen: true,
    lockInteraction: true,
    followToken: true
  };
}

function prepareDisplayLaunch(options = {}) {
  const launchOptions = {
    ...options,
    viewMode: options.viewMode || game.settings.get(MODULE_ID, "lastViewMode") || "character"
  };
  const targetUser = resolveTargetUser(launchOptions);
  if (!targetUser) {
    ui.notifications.error("No player user could be found for the second screen.");
    return null;
  }

  const sourceTokens = findSourceTokens(targetUser, launchOptions.viewMode);
  if (!sourceTokens.length) {
    const detail = launchOptions.viewMode === "owned"
      ? `${targetUser.name} does not own any visible tokens on the current scene.`
      : `${targetUser.name} has no visible assigned-character token on the current scene.`;
    ui.notifications.warn(detail);
    return null;
  }

  const { screen, bounds } = getDisplayTarget(launchOptions);
  const displayUrl = buildDisplayUrl(targetUser, launchOptions);
  const channelName = createStreamChannelName(targetUser);
  const displayPageUrl = buildDisplayPageUrl(channelName);
  return { targetUser, sourceTokens, screen, bounds, displayUrl, displayPageUrl, channelName };
}

function resolveTargetUser(options = {}) {
  const users = game.users
    .filter(user => !user.isGM)
    .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  if (!users.length) return null;

  const viewMode = options.viewMode || "character";
  const selected = game.users.get(options.targetUserId);
  if (selected && !selected.isGM && findSourceTokens(selected, viewMode).length) return selected;

  const savedUserId = game.settings.get(MODULE_ID, "lastUserId");
  const saved = game.users.get(savedUserId);
  if (saved && !saved.isGM && findSourceTokens(saved, viewMode).length) return saved;

  return users.find(user => user.active && findSourceTokens(user, viewMode).length)
    ?? users.find(user => findSourceTokens(user, viewMode).length)
    ?? users[0];
}

async function openDisplayWindow(options = {}, displayTarget = {}) {
  const prepared = displayTarget.prepared ?? prepareDisplayLaunch(options);
  if (!prepared) {
    closePreparedWindow(displayTarget.hostWindow);
    return null;
  }

  const { targetUser } = prepared;
  const target = displayTarget.screen ? displayTarget : getDisplayTarget(options);
  const hostWindow = displayTarget.hostWindow;
  const launchPrepared = {
    ...prepared,
    screen: target.screen ?? prepared.screen,
    bounds: target.bounds ?? prepared.bounds
  };

  if (!hostWindow) {
    const desktopHint = isFoundryDesktop()
      ? " Use the direct second-screen URL shown next if Foundry blocks the automatic window."
      : "";
    ui.notifications.warn(`The second-screen window was blocked.${desktopHint}`);
    await showManualOpenDialog(launchPrepared);
    return null;
  }

  return launchFoundryDisplayWindow(hostWindow, options, launchPrepared);
}

function launchFoundryDisplayWindow(hostWindow, launchOptions, prepared) {
  const { targetUser, screen, bounds } = prepared;

  try {
    hostWindow.moveTo(bounds.left, bounds.top);
    hostWindow.resizeTo(bounds.width, bounds.height);
  } catch (_error) {
    // Some browsers restrict window placement even after permission is granted.
  }

  try {
    if (hostWindow.location.href === "about:blank") hostWindow.location.replace(prepared.displayUrl);
  } catch (_error) {
    hostWindow.location.href = prepared.displayUrl;
  }

  try { hostWindow.focus(); } catch (_error) { /* Browser may deny focus. */ }
  ui.notifications.info(`Opening ${targetUser.name}'s clean tabletop view on ${screen.label}.`);
  return hostWindow;
}

function getDisplayTarget(options = {}) {
  const screen = state.screens.find(item => item.key === options.screenKey)
    ?? state.screens.find(item => !item.isPrimary)
    ?? state.screens[0]
    ?? currentScreenFallback();
  const bounds = screenBounds(screen);
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

  return { screen, bounds, features };
}

function openBlankDisplayWindow(displayTarget, url = "about:blank") {
  try {
    return window.open(url, DISPLAY_WINDOW_NAME, displayTarget.features);
  } catch (_error) {
    return null;
  }
}

function buildDisplayUrl(targetUser, options = {}) {
  const gameRoute = foundry.utils.getRoute?.("game") ?? "/game";
  const url = new URL(gameRoute, window.location.origin);
  url.searchParams.set(PARAM_DISPLAY, "1");
  url.searchParams.set(PARAM_TARGET_USER, targetUser.id);
  url.searchParams.set(PARAM_VIEW_MODE, options.viewMode || "character");
  url.searchParams.set(PARAM_LOCK, options.lockInteraction === false ? "0" : "1");
  url.searchParams.set(PARAM_FOLLOW, options.followToken === false ? "0" : "1");
  url.searchParams.set(PARAM_FOG, options.fogMode === "gm" ? "gm" : "current");
  url.searchParams.set(PARAM_SMOOTHING, normalizeSmoothing(options.smoothing));
  return url.toString();
}

function buildDisplayPageUrl(channelName) {
  const route = foundry.utils.getRoute?.(`modules/${MODULE_ID}/display.html`)
    ?? `/modules/${MODULE_ID}/display.html`;
  const url = new URL(route, window.location.origin);
  url.searchParams.set("channel", channelName);
  return url.toString();
}

function createStreamChannelName(targetUser) {
  const worldId = game.world?.id ?? game.world?.title ?? "world";
  const randomId = foundry.utils.randomID?.(8) ?? Math.random().toString(36).slice(2, 10);
  return `${STREAM_CHANNEL_PREFIX}-${worldId}-${game.userId}-${targetUser.id}-${Date.now()}-${randomId}`;
}

async function showManualOpenDialog(prepared) {
  const { targetUser, screen, displayUrl } = prepared;
  const desktopHint = isFoundryDesktop()
    ? "<p>If the standalone Foundry desktop app blocks this window, copy the URL below and open it from the same Foundry address after logging in.</p>"
    : "";
  const content = `
    <div class="dmw-warning">
      <p>Your browser blocked the automatic second-screen window.</p>
      <p>Use the button below to open ${escapeHtml(targetUser.name)}'s tabletop view as a clean Foundry window, then move it to ${escapeHtml(screen.label)} if needed.</p>
      ${desktopHint}
      <p><a class="button" target="${DISPLAY_WINDOW_NAME}" href="${escapeHtml(displayUrl)}"><i class="fa-solid fa-up-right-from-square"></i> Open Second Screen</a></p>
      <input type="text" readonly value="${escapeHtml(displayUrl)}" onclick="this.select()">
    </div>`;

  await foundry.applications.api.DialogV2.prompt({
    window: { title: "Open Second Screen Manually" },
    content,
    ok: { label: "Close" },
    rejectClose: false,
    modal: true
  });
}

function isFoundryDesktop() {
  return /\sElectron\//i.test(navigator.userAgent);
}

function closePreparedWindow(hostWindow) {
  if (!hostWindow) return;
  try { hostWindow.close(); } catch (_error) { /* Browser may deny closing it. */ }
}

function makePreviewDraggable(preview) {
  makePanelDraggable(preview, ".dmw-preview__bar");
}

function makePanelDraggable(preview, handleSelector) {
  const handle = preview.querySelector(handleSelector);
  if (!handle) return;
  let drag = null;

  handle.addEventListener("pointerdown", event => {
    if (event.target.closest("button, a")) return;
    const rect = preview.getBoundingClientRect();
    drag = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top
    };
    handle.setPointerCapture(event.pointerId);
    preview.classList.add("is-dragging");
  });

  handle.addEventListener("pointermove", event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const x = Math.max(8, Math.min(window.innerWidth - 180, event.clientX - drag.offsetX));
    const y = Math.max(8, Math.min(window.innerHeight - 90, event.clientY - drag.offsetY));
    preview.style.left = `${x}px`;
    preview.style.top = `${y}px`;
    preview.style.right = "auto";
    preview.style.bottom = "auto";
  });

  handle.addEventListener("pointerup", event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag = null;
    preview.classList.remove("is-dragging");
    try { handle.releasePointerCapture(event.pointerId); } catch (_error) { /* Pointer already released. */ }
  });
}

function startDisplayFramePump({
  iframe = null,
  stream,
  status,
  displayUrl = "",
  channelName = "",
  cropElement = null,
  ownerWindow = window,
  fallbackWindow = window,
  fallbackDocument = document,
  onFrame = null
}) {
  let startTimer = null;
  let frameRequest = null;
  let lastCapturedAt = 0;
  let stopped = false;
  let firstFrame = false;
  let lastError = "";
  let loadedAt = 0;
  let usingFallback = false;
  let channel = null;

  if (channelName && typeof BroadcastChannel === "function") {
    channel = new BroadcastChannel(channelName);
    channel.postMessage({
      type: "meta",
      title: "DM Workshop Table View"
    });
  }

  const setStatus = message => {
    if (status) status.textContent = message;
  };

  const stop = () => {
    stopped = true;
    try { channel?.postMessage({ type: "closed" }); } catch (_error) { /* Display may already be closed. */ }
    try { channel?.close(); } catch (_error) { /* Channel may already be closed. */ }
    if (startTimer) ownerWindow.clearTimeout(startTimer);
    if (frameRequest) cancelFrame(ownerWindow, frameRequest);
    startTimer = null;
    frameRequest = null;
    try { if (iframe) iframe.src = "about:blank"; } catch (_error) { /* Window may already be closed. */ }
  };

  const captureFrame = () => {
    if (stopped) return;

    try {
      let renderedCanvas = null;

      if (iframe) {
        const rendererWindow = iframe.contentWindow;
        const rendererDocument = iframe.contentDocument;
        renderedCanvas = extractBoardCanvas(rendererWindow, rendererDocument, { preferDom: Boolean(cropElement) });
      }

      if (!renderedCanvas) {
        if (!iframe || (loadedAt && Date.now() - loadedAt > 2500)) {
          renderedCanvas = extractBoardCanvas(fallbackWindow, fallbackDocument, { preferDom: Boolean(cropElement) });
          usingFallback = Boolean(renderedCanvas);
          if (!renderedCanvas) setStatus("Active tabletop canvas not found.");
        }
      }

      if (!renderedCanvas) {
        setStatus("Waiting for Foundry canvas...");
        return;
      }

      const outputCanvas = cropElement
        ? cropCanvasToElement(renderedCanvas, cropElement, fallbackDocument)
        : renderedCanvas;
      const frameSrc = outputCanvas.toDataURL("image/jpeg", STREAM_JPEG_QUALITY);
      stream.src = frameSrc;
      try {
        channel?.postMessage({
          type: "frame",
          src: frameSrc,
          width: outputCanvas.width,
          height: outputCanvas.height,
          timestamp: Date.now()
        });
      } catch (_error) {
        channel = null;
      }

      if (!firstFrame) {
        firstFrame = true;
        setStatus(usingFallback ? "Live preview connected to the active tabletop canvas." : "Live player display connected.");
        if (typeof onFrame === "function") onFrame();
      }
    } catch (error) {
      const message = error?.message || String(error);
      if (message !== lastError) {
        lastError = message;
        setStatus(`Display capture blocked: ${message}`);
      }
    }
  };

  const tick = now => {
    if (stopped) return;
    if (!lastCapturedAt || now - lastCapturedAt >= STREAM_FRAME_INTERVAL_MS) {
      lastCapturedAt = now;
      captureFrame();
    }
    frameRequest = requestFrame(ownerWindow, tick);
  };

  const startLiveLoop = delay => {
    if (frameRequest || startTimer) return;
    startTimer = ownerWindow.setTimeout(() => {
      startTimer = null;
      if (!stopped) frameRequest = requestFrame(ownerWindow, tick);
    }, delay);
  };

  if (iframe && displayUrl) {
    iframe.addEventListener("load", () => {
      if (stopped) return;
      loadedAt = Date.now();
      setStatus("Renderer loaded. Waiting for board...");
      startLiveLoop(250);
    });

    setStatus("Loading player renderer...");
    iframe.src = displayUrl;
  } else {
    loadedAt = Date.now();
    setStatus("Connecting to live tabletop canvas...");
    startLiveLoop(50);
  }

  return stop;
}

function requestFrame(ownerWindow, callback) {
  const request = ownerWindow.requestAnimationFrame?.bind(ownerWindow)
    ?? window.requestAnimationFrame.bind(window);
  return request(callback);
}

function cancelFrame(ownerWindow, id) {
  const cancel = ownerWindow.cancelAnimationFrame?.bind(ownerWindow)
    ?? window.cancelAnimationFrame.bind(window);
  cancel(id);
}

function extractBoardCanvas(rendererWindow, rendererDocument, { preferDom = false } = {}) {
  if (!rendererWindow || !rendererDocument) return null;

  const foundryCanvas = rendererWindow.canvas;
  const app = foundryCanvas?.app ?? rendererWindow.game?.canvas?.app;
  const renderer = app?.renderer;
  const stage = foundryCanvas?.stage ?? app?.stage;

  if (preferDom) {
    const domCanvas = findBoardDomCanvas(rendererWindow, rendererDocument, renderer);
    if (domCanvas) return domCanvas;
  }

  try {
    const extract = renderer?.extract ?? renderer?.plugins?.extract;
    if (extract?.canvas && stage) {
      return extract.canvas(stage);
    }
  } catch (_error) {
    // Fall through to the DOM canvas below.
  }

  return findBoardDomCanvas(rendererWindow, rendererDocument, renderer);
}

function findBoardDomCanvas(rendererWindow, rendererDocument, renderer) {
  const foundryCanvas = rendererWindow.canvas;

  for (const candidate of [
    foundryCanvas?.app?.canvas,
    foundryCanvas?.app?.view,
    renderer?.canvas,
    renderer?.view,
    renderer?.gl?.canvas,
    renderer?.context?.view,
    renderer?.context?.canvas
  ]) {
    if (isCanvasLike(candidate)) return candidate;
  }

  const board = rendererDocument.getElementById("board");
  const canvases = [];

  if (isCanvasLike(board)) canvases.push(board);
  if (typeof board?.querySelectorAll === "function") canvases.push(...board.querySelectorAll("canvas"));
  canvases.push(...rendererDocument.querySelectorAll("canvas"));

  return canvases.find(isCanvasLike) ?? null;
}

function cropCanvasToElement(sourceCanvas, cropElement, ownerDocument = document) {
  const canvasRect = sourceCanvas.getBoundingClientRect?.();
  const cropRect = cropElement.getBoundingClientRect?.();

  if (!canvasRect || !cropRect || !canvasRect.width || !canvasRect.height) return sourceCanvas;

  const left = Math.max(canvasRect.left, cropRect.left);
  const top = Math.max(canvasRect.top, cropRect.top);
  const right = Math.min(canvasRect.right, cropRect.right);
  const bottom = Math.min(canvasRect.bottom, cropRect.bottom);

  if (right <= left || bottom <= top) return sourceCanvas;

  const scaleX = sourceCanvas.width / canvasRect.width;
  const scaleY = sourceCanvas.height / canvasRect.height;
  const sourceX = Math.max(0, Math.round((left - canvasRect.left) * scaleX));
  const sourceY = Math.max(0, Math.round((top - canvasRect.top) * scaleY));
  const sourceWidth = Math.max(1, Math.round((right - left) * scaleX));
  const sourceHeight = Math.max(1, Math.round((bottom - top) * scaleY));

  const output = ownerDocument.createElement("canvas");
  output.width = sourceWidth;
  output.height = sourceHeight;
  const context = output.getContext("2d");
  context.drawImage(sourceCanvas, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight);
  return output;
}

function isCanvasLike(candidate) {
  return Boolean(
    candidate
    && typeof candidate.toDataURL === "function"
    && Number(candidate.width) > 0
    && Number(candidate.height) > 0
  );
}

function installDisplayShell(hostWindow, options) {
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
    #dmw-stream { position: fixed; inset: 0; width: 100%; height: 100%; object-fit: contain; background: #000; }
    #dmw-frame { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; background: #000; opacity: 0; pointer-events: none; }
    #dmw-shell-overlay { position: fixed; inset: 0; z-index: 10; display: grid; place-items: center; background: #08070d; color: #f4efe5; }
    #dmw-shell-card { width: min(520px, calc(100vw - 40px)); padding: 24px; border: 1px solid #64536f; border-radius: 12px; background: #17121d; text-align: center; box-shadow: 0 18px 60px rgba(0,0,0,.55); }
    #dmw-shell-card h1 { margin: 0 0 8px; font-size: 22px; }
    #dmw-shell-card p { margin: 8px 0; line-height: 1.45; color: #d8cfe0; }
    #dmw-fullscreen-button { display: none; margin: 16px auto 0; padding: 11px 18px; border: 1px solid #f2a65a; border-radius: 7px; background: #2c1d34; color: #fff; font-weight: 700; cursor: pointer; }
  </style>
</head>
<body>
  <img id="dmw-stream" alt="DM Workshop player display">
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

  const stream = doc.getElementById("dmw-stream");
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

  const stopStream = startDisplayFramePump({
    iframe: null,
    stream,
    status,
    ownerWindow: hostWindow,
    fallbackWindow: window,
    fallbackDocument: document,
    onFrame: () => {
      overlay.style.opacity = "0";
      overlay.style.pointerEvents = "none";
      overlay.style.transition = "opacity 220ms ease";
      hostWindow.setTimeout(() => overlay.remove(), 240);
    }
  });
  hostWindow.addEventListener("beforeunload", stopStream, { once: true });

  if (options.fullscreen) void requestFullscreen();
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
  document.documentElement.dataset.dmwDisplay = "active";
  document.body?.classList.add("dmw-secondary-screen");
  document.body?.setAttribute("data-dmw-display", "active");
  document.body?.classList.toggle("dmw-display-locked", state.options.lockInteraction);
  document.title = `Table View · ${targetUser.name}`;

  applyDisplayChromeSuppression();
  closeOpenApplications();

  if (canvas?.ready) await refreshPlayerView({ recenter: true });
}

function exitDisplayMode({ closeWindow = false } = {}) {
  state.active = false;
  clearTimeout(state.refreshTimer);
  stopSmoothFollow();
  delete document.documentElement.dataset.dmwDisplay;
  document.body?.removeAttribute("data-dmw-display");

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

function applyDisplayChromeSuppression() {
  if (!document.getElementById(DISPLAY_STYLE_ID)) {
    const style = document.createElement("style");
    style.id = DISPLAY_STYLE_ID;
    style.textContent = `
      html[data-dmw-display="active"],
      html[data-dmw-display="active"] body {
        overflow: hidden !important;
        background: #000 !important;
      }

      html[data-dmw-display="active"] #interface > :not(#board),
      html[data-dmw-display="active"] #ui-left,
      html[data-dmw-display="active"] #ui-middle,
      html[data-dmw-display="active"] #ui-right,
      html[data-dmw-display="active"] #ui-top,
      html[data-dmw-display="active"] #ui-bottom,
      html[data-dmw-display="active"] #navigation,
      html[data-dmw-display="active"] #controls,
      html[data-dmw-display="active"] #players,
      html[data-dmw-display="active"] #sidebar,
      html[data-dmw-display="active"] #hotbar,
      html[data-dmw-display="active"] #pause,
      html[data-dmw-display="active"] #logo,
      html[data-dmw-display="active"] #fps,
      html[data-dmw-display="active"] #notifications,
      html[data-dmw-display="active"] #tooltip,
      html[data-dmw-display="active"] .application,
      html[data-dmw-display="active"] .window-app,
      html[data-dmw-display="active"] .app,
      html[data-dmw-display="active"] aside,
      html[data-dmw-display="active"] nav {
        display: none !important;
        visibility: hidden !important;
        pointer-events: none !important;
      }

      html[data-dmw-display="active"] #board {
        position: fixed !important;
        inset: 0 !important;
        width: 100vw !important;
        height: 100vh !important;
        margin: 0 !important;
        pointer-events: auto !important;
      }

      body.dmw-display-locked #board,
      body.dmw-display-locked canvas {
        pointer-events: none !important;
        cursor: none !important;
      }`;
    document.head.appendChild(style);
  }

  const hiddenSelectors = [
    "#ui-left", "#ui-middle", "#ui-right", "#ui-top", "#ui-bottom",
    "#navigation", "#controls", "#players", "#sidebar", "#hotbar",
    "#pause", "#logo", "#fps", "#notifications", "#tooltip",
    ".application", ".window-app", ".app"
  ];

  for (const selector of hiddenSelectors) {
    for (const element of document.querySelectorAll(selector)) {
      if (element.id === "board") continue;
      element.setAttribute("aria-hidden", "true");
    }
  }
}

async function showDisplayError(message) {
  document.documentElement.classList.remove("dmw-display-requested", "dmw-secondary-screen");
  delete document.documentElement.dataset.dmwDisplay;
  document.body?.classList.remove("dmw-secondary-screen", "dmw-display-locked");
  document.body?.removeAttribute("data-dmw-display");

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
