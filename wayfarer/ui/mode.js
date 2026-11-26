// Says which build this is. The desktop app keeps this file as it is. The web build for phones replaces it
// with `window.WAYFARER_WEB = { version: "..." };`, which runs the app on webapi.js instead of Python.
"use strict";
window.WAYFARER_WEB = null;
