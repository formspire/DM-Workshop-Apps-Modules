# DM Workshop: Second Screen

**ALPHA RELEASE**

DM Workshop: Second Screen is a Foundry VTT module for in-person tabletop games. It opens a dedicated second display that follows a selected player's view, giving the table a cleaner player-facing screen while the GM keeps their normal controls private.

## Screenshots

Screenshots will be added during alpha testing.

- Launcher dialog placeholder
- Player display placeholder
- Multi-monitor setup placeholder

## ALPHA RELEASE WARNING

This module is currently in active alpha development.

Expect bugs.

Features may change.

Not all functionality is complete.

Please report issues through GitHub:

https://github.com/formspire/DM-Workshop-Apps-Modules/issues

Current known limitations include:

- Browser popup limitations
- Fullscreen behavior varies
- Multi-monitor support still improving
- Camera follow still being refined
- Compatibility testing is ongoing

## Features

- Opens a dedicated player-facing display window.
- Selects a player view based on an assigned character token or owned tokens.
- Supports monitor selection where browser or desktop permissions allow it.
- Requests fullscreen for cleaner in-person table displays.
- Provides smooth, cinematic, and instant camera-follow modes.
- Hides GM-facing Foundry UI from the second display.
- Keeps the module intentionally lightweight for alpha testing.

## Installation

Install the module using Foundry VTT's Manifest URL option.

Manifest URL:

```text
https://github.com/formspire/DM-Workshop-Apps-Modules/releases/download/v0.3.0-alpha.1/module.json
```

1. Open Foundry VTT.
2. Choose **Add-on Modules**.
3. Click **Install Module**.
4. Paste the Manifest URL.
5. Click **Install**.
6. Enable the module inside your world.

## Use

1. Enter the world as a GM.
2. Select Token Controls on the left.
3. Click the monitor button.
4. Choose the player vision profile.
5. Choose the destination monitor.
6. Choose Smooth, Cinematic, or Instant camera follow.
7. Click **Open on Selected Monitor**.

The browser may ask for permission to manage windows across multiple displays. Granting that permission allows the module to identify and position the display on another screen automatically.

Press `Shift+Escape` from the clean display to close it.

## Important Browser Note

Foundry is built with browser technology. A module running in Chrome, Edge, or Firefox cannot create a completely independent native application window. For the closest dedicated-display experience, run the GM view through the Foundry desktop application. In a normal browser, the module requests fullscreen and uses a minimal popup shell, but the browser controls the final window framing and permission prompts.

## Support DM Workshop

If you enjoy this project and would like to support future development:

Ko-fi

https://ko-fi.com/dmworkshop

-------------------------------------

DM Workshop

Where imagination meets initiative.

Website

https://www.dm-workshop.com

GitHub

https://github.com/formspire/DM-Workshop-Apps-Modules

-------------------------------------
