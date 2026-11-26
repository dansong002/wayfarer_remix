// The app's screens: Trips, Editor and Preview, plus dialogs, drag and drop, and the update check.
"use strict";

const S = {
  screen: "boot", tab: "editor", pane: "route", trip: null, filename: null, dirty: false, selected: null,
  collapsed: new Set(), trips: [], version: "", newer: null, theme: "auto",
  exportOpts: { format: "pdf", style: DEFAULT_POSTER, appearance: "ink" },
};
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
// The web build for phones (see mode.js) runs on webapi.js. The desktop app runs on Python through pywebview.
const WEB = Boolean(window.WAYFARER_WEB);
const api = () => (WEB ? webApi : window.pywebview.api);
const uid = () => Math.random().toString(36).slice(2, 10);
const posterStyle = () => (POSTER_STYLES.some(([k]) => k === S.trip.poster) ? S.trip.poster : DEFAULT_POSTER);

// Themes: Daniel's Style Suite. Automatic picks Calm on a dark device and Quiet Ink on a light one --------
const THEMES = [
  ["calm", "Calm", "Calm + Gem", "Dark and quiet, with one violet accent"],
  ["ink", "Ink", "Quiet Ink", "Black and white with hairlines. Prints best"],
  ["gem", "Gem", "Night Gem", "Dark, rounded, a soft colour per trip"],
  ["signal", "Signal", "Signal", "Warm glow and dot-matrix titles"],
  ["shelf", "Shelf", "Shelf", "Light studio, each trip a bold cover"],
];
const THEME_IDS = THEMES.map(([id]) => id);
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const themeId = () => (THEME_IDS.includes(S.theme) ? S.theme : darkQuery.matches ? "calm" : "ink");
function applyTheme() {
  const root = document.documentElement;
  root.dataset.theme = themeId();
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.content = cssVar(root, "--bg");
  if (S.screen !== "boot") render();
}
darkQuery.addEventListener("change", applyTheme);
function setTheme(id) {
  S.theme = id === "auto" || THEME_IDS.includes(id) ? id : "auto";
  applyTheme();
  Promise.resolve(api().set_settings({ theme: S.theme })).catch(() => null);
}

// Small helpers --------------------------------------------------------------------------
let toastTimer;
function toast(message, undo) {
  const el = $("#toast");
  el.innerHTML = `<span>${esc(message)}</span>${undo ? '<button type="button" data-action="undo">Undo</button>' : ""}`;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), undo ? 6000 : 3000);
}
function setDirty(value = true) {
  S.dirty = value;
  api().set_dirty(value);
  const st = $("#state");
  if (st) st.textContent = value ? "Unsaved changes" : (S.filename ? "Saved" : "");
}
let undoSnapshot = null;
function snapshotForUndo() { undoSnapshot = JSON.stringify(S.trip); }

function dialog(html, cls = "") {
  const previous = document.activeElement;
  $("#overlay").innerHTML = `<div class="dlg ${cls}" role="dialog" aria-modal="true">${html}</div>`;
  const first = $("#overlay [data-default]") || $("#overlay button");
  if (first) first.focus();
  dialog.restore = previous;
}
function closeDialog() {
  $("#overlay").innerHTML = "";
  if (dialog.restore && dialog.restore.isConnected) dialog.restore.focus();
}
let pendingConfirm = null;
function confirmDialog({ title, body, buttons }) {
  return new Promise(resolve => {
    pendingConfirm = resolve;
    dialog(`<h2>${esc(title)}</h2><p>${esc(body)}</p><div class="acts">${buttons.map(b => `<button type="button" class="btn ${b.cls || ""}" data-action="confirm-answer" data-value="${b.value}" ${b.def ? "data-default" : ""}>${esc(b.label)}</button>`).join("")}</div>`);
  });
}

// Screens --------------------------------------------------------------------------------
function placeVersion() {
  const brand = $(".brand");
  const v = $("#version");
  if (brand) v.style.left = `${brand.getBoundingClientRect().right + 4}px`;
}
const BRAND = "Wayfarer Remix";
function header() {
  if (S.screen === "home") return `<div class="bar home-bar"><div class="left"><span class="brand">${BRAND}</span></div><div class="right"><button class="btn q" data-action="theme">Theme</button></div></div>`;
  const pressed = (tab, pane) => S.tab === tab && (!pane || S.pane === pane);
  return `<div class="bar trip"><div class="left"><button class="btn q back" data-action="go-home" aria-label="Back to trips">← Trips</button><span class="brand">${BRAND}</span></div>
    <div class="seg tabs-d" role="group" aria-label="View"><button data-action="tab" data-value="editor" aria-pressed="${S.tab === "editor"}">Editor</button><button data-action="tab" data-value="preview" aria-pressed="${S.tab === "preview"}">Preview</button></div>
    <div class="right"><span class="state" id="state">${S.dirty ? "Unsaved changes" : (S.filename ? "Saved" : "")}</span><button class="btn" data-action="open-export">Export</button><button class="btn p" data-action="save" title="Ctrl+S">Save</button></div>
    <div class="seg tabs-m" role="group" aria-label="View"><button data-action="tab" data-value="trip" aria-pressed="${pressed("editor", "trip")}">Trip</button><button data-action="tab" data-value="route" aria-pressed="${pressed("editor", "route")}">Route</button><button data-action="tab" data-value="preview" aria-pressed="${pressed("preview")}">Preview</button></div></div>`;
}
function render() {
  const app = $("#app");
  if (S.screen === "boot") return;
  if (S.screen === "home") app.innerHTML = header() + homeView();
  else if (S.tab === "editor") {
    const scroller = $("#main-scroll");
    const top = scroller ? scroller.scrollTop : 0;
    app.innerHTML = header() + editorView();
    const next = $("#main-scroll");
    if (next) next.scrollTop = top;
  } else {
    app.innerHTML = header() + `<div class="scroll"><div class="preview-wrap"><div class="preview-tools"><span>Poster style</span>${posterStyleSeg("preview-style", posterStyle())}</div><div id="poster-slot"></div></div></div>`;
    $("#poster-slot").innerHTML = renderPoster(S.trip, posterStyle(), document.body);
    fitPoster();
  }
  placeVersion();
}
// Posters have a fixed print width. On a narrow screen, scale the preview down to fit.
function fitPoster() {
  const slot = $("#poster-slot");
  const poster = slot && slot.firstElementChild;
  if (!poster) return;
  poster.style.transform = ""; poster.style.margin = ""; slot.style.height = "";
  const scale = Math.min(1, slot.clientWidth / poster.offsetWidth);
  if (scale >= 1) return;
  poster.style.transformOrigin = "top left";
  poster.style.transform = `scale(${scale})`;
  poster.style.margin = "0";
  slot.style.height = `${Math.ceil(poster.offsetHeight * scale)}px`;
}
function posterStyleSeg(action, current) {
  return `<div class="seg" role="group" aria-label="Poster style">${POSTER_STYLES.map(([k, label]) => `<button data-action="${action}" data-value="${k}" aria-pressed="${k === current}">${label}</button>`).join("")}</div>`;
}

// Trips screen ---------------------------------------------------------------------------
function homeView() {
  const root = document.documentElement;
  const colour = cssVar(root, "--t2"), bg = cssVar(root, "--page");
  // Shelf covers carry dark text on bright colours, so their route strip is drawn dark too.
  const shelf = themeId() === "shelf";
  const list = S.trips.map((t, i) => t.error
    ? `<div class="tripcard bad"><div class="open"><h2>${esc(t.filename)}</h2><p>This file can't be read. It may be damaged.</p></div><button class="btn q d del" data-action="delete-trip" data-file="${esc(t.filename)}" data-title="${esc(t.filename)}">Delete</button></div>`
    : `<div class="tripcard" style="--cover:var(--area-${(i % 5) + 1})"><button class="open" data-action="open-trip" data-file="${esc(t.filename)}"><h2>${esc(t.title)}</h2>${t.subtitle ? `<p>${esc(t.subtitle)}</p>` : ""}${routeStrip(t.modes.slice(0, 24), shelf ? "#111111" : colour, shelf ? cssVar(root, `--area-${(i % 5) + 1}`) : bg)}<small>${esc([tripRangeFromSummary(t), `${t.days} day${t.days === 1 ? "" : "s"}`].filter(Boolean).join(" · "))}</small></button><button class="btn q d del" data-action="delete-trip" data-file="${esc(t.filename)}" data-title="${esc(t.title)}">Delete</button></div>`
  ).join("");
  const count = S.trips.length ? `<span class="label home-count">${S.trips.length} trip${S.trips.length === 1 ? "" : "s"}</span>` : "";
  const device = WEB ? `<div class="device"><p>Trips are saved in this browser, on this device only. Back them up before you clear the browser's data or change phones.</p>
    <div class="acts"><button class="btn" data-action="backup">Back up trips</button><button class="btn" data-action="restore">Restore from file</button></div>
    <input type="file" id="restore-file" accept=".json,application/json" multiple hidden></div>` : "";
  return `<div class="scroll"><div class="home">${S.dataProblem ? `<p class="notice" role="alert">${esc(S.dataProblem)}</p>` : ""}<div class="home-top"><div>${count}<h1>Trips</h1></div><button class="btn p" data-action="new-trip">New trip</button></div>
    ${list || (S.loaded ? `<div class="empty">${routeStrip(["plane", "train", "walk", "boat", "car"], colour, bg)}<p>Create a trip to start your first route</p></div>` : "")}${device}</div></div>`;
}
function tripRangeFromSummary(t) {
  if (!t.first) return "";
  return t.first === t.last ? fmtShort(t.first) : `${fmtShort(t.first)} to ${fmtShort(t.last)}`;
}
async function loadTrips() {
  S.trips = await api().list_trips();
  S.loaded = true;
  if (S.screen === "home") render();
}
function goHome() {
  S.screen = "home"; S.trip = null; S.filename = null; S.selected = null;
  setDirty(false);
  render();
  loadTrips();
}
async function leaveTrip() {
  if (!S.dirty) return goHome();
  const answer = await confirmDialog({
    title: "Save changes to this trip?",
    body: "Your changes will be lost if you don't save them.",
    buttons: [{ label: "Don't save", value: "discard", cls: "d" }, { label: "Cancel", value: "cancel" }, { label: "Save", value: "save", cls: "p", def: true }],
  });
  if (answer === "cancel") return;
  if (answer === "save" && !(await saveTrip())) return;
  goHome();
}
// Called from Python when the window's close button is selected with unsaved changes.
window.wayfarerRequestClose = async () => {
  const answer = await confirmDialog({
    title: "Save changes before closing?",
    body: "Your changes will be lost if you don't save them.",
    buttons: [{ label: "Don't save", value: "discard", cls: "d" }, { label: "Cancel", value: "cancel" }, { label: "Save", value: "save", cls: "p", def: true }],
  });
  if (answer === "cancel") return;
  if (answer === "save" && !(await saveTrip())) return;
  api().close_window();
};
function openEditor(trip, filename) {
  S.trip = normaliseTrip(trip); S.filename = filename; S.screen = "trip"; S.tab = "editor"; S.selected = null;
  S.pane = S.trip.days.length ? "route" : "trip";
  S.collapsed.clear();
  setDirty(false);
  render();
}
function normaliseTrip(trip) {
  trip.days = Array.isArray(trip.days) ? trip.days : [];
  trip.days.forEach(day => {
    day.id = day.id || uid();
    day.slots = day.slots || {};
    SLOTS.forEach(([s]) => { day.slots[s] = Array.isArray(day.slots[s]) ? day.slots[s] : []; day.slots[s].forEach(e => { e.id = e.id || uid(); }); });
  });
  return trip;
}

// Editor ---------------------------------------------------------------------------------
function editorView() {
  const t = S.trip;
  const side = `<aside class="side">
    <label class="f"><span>Trip title</span><input class="in" data-trip="title" value="${esc(t.title)}" placeholder="Portugal coast"></label>
    <label class="f"><span>Subtitle</span><input class="in" data-trip="subtitle" value="${esc(t.subtitle)}" placeholder="Lisbon to Porto"></label>
    <label class="f" style="margin-bottom:0"><span>Trip notes</span><textarea class="in" rows="3" data-trip="notes" placeholder="Reminders and contacts">${esc(t.notes)}</textarea></label>
    <h3 class="label">Days <i id="day-count">${t.days.length}</i></h3><div id="day-index">${dayIndex()}</div>
    <button class="btn" style="width:100%;margin-top:8px" data-action="add-day">Add day</button></aside>`;
  const days = t.days.map(dayView).join("");
  return `<div class="body" data-pane="${S.pane}">${side}<div class="scroll" id="main-scroll"><div class="d1main">${days || `<div class="emptyday"><p>Add the first day to start the route</p></div>`}
    ${t.days.length ? `<button class="btn" style="margin:16px 0 0 40px" data-action="add-day">Add day</button>` : `<div style="text-align:center"><button class="btn p" data-action="add-day">Add day</button></div>`}</div></div></div>`;
}
function dayIndex() {
  return S.trip.days.map((d, i) => `<button class="dayjump" data-action="jump" data-day="${d.id}"><span>${esc(d.label || `Day ${i + 1}`)}</span><em>${esc(fmtShort(d.date))}</em></button>`).join("");
}
function themeColours() {
  const root = document.documentElement;
  return { line: cssVar(root, "--t3"), bg: cssVar(root, "--page") };
}
function dayView(day, i) {
  const c = themeColours();
  const closed = S.collapsed.has(day.id);
  const count = SLOTS.reduce((n, [s]) => n + day.slots[s].length, 0);
  const lastDay = i === S.trip.days.length - 1;
  let h = `<div class="rw dayh" id="day-${day.id}" data-day="${day.id}">
    <div class="rail">${railSvg(firstType(day), c.line, c.bg)}<span class="num">${i + 1}</span></div>
    <div class="title"><div class="daywhen"><span class="weekday" data-weekday="${day.id}">${esc(weekday(day.date))}</span><input type="date" class="in date" aria-label="Date of day ${i + 1}" data-day-field="date" data-day="${day.id}" value="${esc(day.date)}"></div>
    <input class="in lbl" aria-label="Label of day ${i + 1}" data-day-field="label" data-day="${day.id}" value="${esc(day.label)}" placeholder="Day ${i + 1}"></div>
    <div class="tools">
      <span class="icon-btn grip" draggable="true" data-drag-day="${day.id}" title="Drag to move this day">${icon("grip")}</span>
      <button class="icon-btn" data-action="day-up" data-day="${day.id}" title="Move day up" aria-label="Move day ${i + 1} up" ${i === 0 ? "disabled" : ""}>${icon("up")}</button>
      <button class="icon-btn" data-action="day-down" data-day="${day.id}" title="Move day down" aria-label="Move day ${i + 1} down" ${lastDay ? "disabled" : ""}>${icon("down")}</button>
      <button class="icon-btn" data-action="collapse" data-day="${day.id}" title="${closed ? "Expand" : "Collapse"}" aria-label="${closed ? "Expand" : "Collapse"} day ${i + 1}" aria-expanded="${!closed}">${icon(closed ? "right" : "down")}</button>
      <button class="icon-btn" data-action="remove-day" data-day="${day.id}" title="Remove day" aria-label="Remove day ${i + 1}">${icon("trash")}</button>
    </div></div>`;
  if (closed) return h + `<div class="rw collapsed-note"><div class="rail">${railSvg("note", c.line, c.bg)}</div>${count} ${count === 1 ? "entry" : "entries"}</div>`;
  SLOTS.forEach(([slot, label], si) => {
    h += `<div class="rw slot" data-drop-slot="${slot}" data-day="${day.id}"><div class="rail">${railSvg(firstType(day, si), c.line, c.bg)}</div><span>${label}</span><button class="add" data-action="add-entry" data-day="${day.id}" data-slot="${slot}" aria-label="Add entry to ${label} of day ${i + 1}">Add entry</button></div>`;
    day.slots[slot].forEach(e => { h += e.id === S.selected ? entryCard(day, slot, e, c) : entryRow(day, slot, e, c); });
  });
  return h;
}
function entryRow(day, slot, e, c) {
  const t = e.type || "note";
  const title = entryTitle(e);
  const night = overnightLabel(e);
  return `<div class="rw ent" data-entry="${e.id}" data-day="${day.id}" data-slot="${slot}"><div class="rail">${railSvg(t, c.line, c.bg)}<span class="stop"></span></div>
    <div class="box" role="button" tabindex="0" draggable="true" data-action="select-entry" data-entry="${e.id}">${icon(t)}<span class="what ${title ? "" : "empty-text"}">${esc(title || TYPE_LABELS[t])}</span><span class="sub">${t !== "note" && e.note ? esc(e.note) : ""}</span>${night ? `<span class="tag">${esc(night)}</span>` : ""}<span class="dur">${esc(fmtDuration(e))}</span></div></div>`;
}
function entryCard(day, slot, e, c) {
  const t = e.type || "note";
  const isNote = t === "note";
  const f = name => `data-entry-field="${name}" data-entry="${e.id}"`;
  const options = Object.entries(TYPE_LABELS).map(([k, v]) => `<option value="${k}" ${k === t ? "selected" : ""}>${v}</option>`).join("");
  const units = [["mins", "m"], ["hrs", "h"], ["days", "d"]].map(([k, v]) => `<option value="${k}" ${(e.unit || "hrs") === k ? "selected" : ""}>${v}</option>`).join("");
  return `<div class="rw ent sel" data-entry="${e.id}" data-day="${day.id}" data-slot="${slot}"><div class="rail">${railSvg(t, c.line, c.bg)}<span class="stop"></span></div>
    <div class="card"><div class="grid ${isNote ? "note-type" : ""}">
      <label><span>Type</span><select class="in" ${f("type")}>${options}</select></label>
      ${isNote ? `<label><span>Description</span><input class="in" ${f("note")} value="${esc(e.note)}" placeholder="Check in at the hotel"></label>` : `<label><span>From</span><input class="in" ${f("from")} value="${esc(e.from)}"></label><label><span>To</span><input class="in" ${f("to")} value="${esc(e.to)}"></label>`}
      <label><span>Duration</span><span class="dur-pair"><input class="in" ${f("duration")} value="${esc(e.duration)}" aria-label="Duration"><select class="in" ${f("unit")} aria-label="Duration unit">${units}</select></span></label>
      ${isNote ? "" : `<label class="wide"><span>Notes</span><input class="in" ${f("note")} value="${esc(e.note)}"></label>`}
    </div><div class="foot">
      <label><input type="checkbox" ${f("overnight")} ${e.overnight ? "checked" : ""}> Overnight</label>
      ${e.overnight ? `<label>Spans <input class="in nights" ${f("spansNights")} value="${esc(e.spansNights || 1)}" aria-label="Number of nights"> nights</label>` : ""}
      <span class="grow"></span>
      <button class="btn q" data-action="entry-up" data-entry="${e.id}">Move up</button><button class="btn q" data-action="entry-down" data-entry="${e.id}">Move down</button>
      <button class="btn q d" data-action="remove-entry" data-entry="${e.id}">Delete entry</button><button class="btn" data-action="select-entry" data-entry="" data-default-close>Done</button>
    </div></div></div>`;
}
function findEntry(id) {
  for (const day of S.trip.days) for (const [slot] of SLOTS) {
    const index = day.slots[slot].findIndex(e => e.id === id);
    if (index !== -1) return { day, slot, index, entry: day.slots[slot][index] };
  }
  return null;
}
function addDay() {
  const last = S.trip.days[S.trip.days.length - 1];
  const day = { id: uid(), date: last ? addDays(last.date, 1) : "", label: "", slots: { morning: [], afternoon: [], evening: [] } };
  S.trip.days.push(day);
  S.pane = "route";
  setDirty(); render();
  const el = document.getElementById(`day-${day.id}`);
  if (el) { el.scrollIntoView({ block: "center" }); $("[data-day-field=label]", el).focus(); }
}
function moveDay(id, delta) {
  const days = S.trip.days, i = days.findIndex(d => d.id === id), j = i + delta;
  if (i < 0 || j < 0 || j >= days.length) return;
  days.splice(j, 0, days.splice(i, 1)[0]);
  setDirty(); render();
}
function moveEntryTo(id, dayId, slot, beforeId) {
  const src = findEntry(id);
  const day = S.trip.days.find(d => d.id === dayId);
  if (!src || !day || id === beforeId) return;
  src.day.slots[src.slot].splice(src.index, 1);
  const list = day.slots[slot];
  const at = beforeId ? list.findIndex(e => e.id === beforeId) : -1;
  list.splice(at === -1 ? list.length : at, 0, src.entry);
  setDirty(); render();
}
// Move one place through the whole trip's order, crossing slots and days.
function nudgeEntry(id, delta) {
  const order = [];
  S.trip.days.forEach(d => SLOTS.forEach(([s]) => order.push([d, s])));
  const src = findEntry(id);
  if (!src) return;
  const list = src.day.slots[src.slot], target = src.index + delta;
  if (target >= 0 && target < list.length) {
    list.splice(target, 0, list.splice(src.index, 1)[0]);
  } else {
    const at = order.findIndex(([d, s]) => d === src.day && s === src.slot) + delta;
    if (at < 0 || at >= order.length) return;
    list.splice(src.index, 1);
    const [d, s] = order[at];
    if (delta > 0) d.slots[s].unshift(src.entry); else d.slots[s].push(src.entry);
  }
  setDirty(); render();
}

// Drag and drop --------------------------------------------------------------------------
let drag = null;
function clearDropMarks() { $$(".drop-before,.drop-into").forEach(el => el.classList.remove("drop-before", "drop-into")); }
document.addEventListener("dragstart", e => {
  const dayGrip = e.target.closest && e.target.closest("[data-drag-day]");
  const box = e.target.closest && e.target.closest(".ent .box");
  if (dayGrip) drag = { kind: "day", id: dayGrip.dataset.dragDay };
  else if (box) { drag = { kind: "entry", id: box.dataset.entry }; box.closest(".ent").classList.add("dragging"); }
  else return;
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", "");
});
function dropTarget(e) {
  const t = e.target.closest ? e.target : e.target.parentElement;
  if (!t || !drag) return null;
  if (drag.kind === "day") return t.closest(".dayh");
  return t.closest(".ent") || t.closest(".slot");
}
document.addEventListener("dragover", e => {
  const el = dropTarget(e);
  clearDropMarks();
  if (!el) return;
  e.preventDefault();
  el.classList.add(el.classList.contains("slot") ? "drop-into" : "drop-before");
});
document.addEventListener("drop", e => {
  const el = dropTarget(e);
  clearDropMarks();
  if (!el) return;
  e.preventDefault();
  if (drag.kind === "day") {
    const days = S.trip.days, from = days.findIndex(d => d.id === drag.id);
    const moving = days.splice(from, 1)[0];
    days.splice(days.findIndex(d => d.id === el.dataset.day), 0, moving);
    setDirty(); render();
  } else if (el.classList.contains("slot")) moveEntryTo(drag.id, el.dataset.day, el.dataset.dropSlot, null);
  else moveEntryTo(drag.id, el.dataset.day, el.dataset.slot, el.dataset.entry);
  drag = null;
});
document.addEventListener("dragend", () => { drag = null; clearDropMarks(); $$(".dragging").forEach(el => el.classList.remove("dragging")); });

// Field edits ----------------------------------------------------------------------------
document.addEventListener("input", e => {
  const el = e.target;
  if (el.dataset.trip) {
    S.trip[el.dataset.trip] = el.value;
    setDirty();
  } else if (el.dataset.dayField) {
    const day = S.trip.days.find(d => d.id === el.dataset.day);
    if (!day) return;
    day[el.dataset.dayField] = el.value;
    setDirty();
    $("#day-index").innerHTML = dayIndex();
    $(`[data-weekday="${day.id}"]`).textContent = weekday(day.date);
  } else if (el.dataset.entryField) {
    const found = findEntry(el.dataset.entry);
    if (!found) return;
    const field = el.dataset.entryField;
    found.entry[field] = el.type === "checkbox" ? el.checked : el.value;
    setDirty();
    if (field === "type" || field === "overnight") {
      render();
      const again = $(`[data-entry-field="${field}"][data-entry="${el.dataset.entry}"]`);
      if (again) again.focus();
    }
  }
});

// Save and export ------------------------------------------------------------------------
async function saveTrip() {
  const r = await api().save_trip(S.trip, S.filename);
  if (!r.ok) { toast(r.error); return false; }
  S.filename = r.filename;
  setDirty(false);
  toast("Trip saved");
  return true;
}
function thumbHtml() {
  const o = S.exportOpts;
  if (o.format === "text") return `<div class="thumb"><p class="hint" style="padding:12px">A plain text itinerary has no poster style.</p></div>`;
  return `<div class="thumb" id="thumb" data-theme="${o.appearance}"><div class="thumb-inner" id="thumb-inner"></div></div>`;
}
function renderExportDialog() {
  const o = S.exportOpts;
  const seg = (name, key, options) => `<div class="opt"><span>${name}</span><div class="seg" role="group" aria-label="${name}">${options.map(([k, l]) => `<button data-action="export-opt" data-opt="${key}" data-value="${k}" aria-pressed="${k === o[key]}">${l}</button>`).join("")}</div></div>`;
  const isText = o.format === "text";
  dialog(`${thumbHtml()}<div><h2>Export trip</h2>
    ${seg("Format", "format", [["pdf", "PDF"], ["image", "Image"], ["text", "Text"]])}
    ${isText ? "" : seg("Poster style", "style", POSTER_STYLES) + seg("Theme", "appearance", THEMES.map(([id, short]) => [id, short]))}
    <p class="hint">${isText ? "A text file." : o.format === "pdf" ? "A4 pages. Long trips continue on more pages." : "One long PNG image."}${isText ? "" : " Ink and Shelf print best: dark themes use a lot of ink."} ${WEB ? "You can share or save it in the next step." : "You choose where to save in the next step."}</p>
    <div class="acts">${isText ? '<button class="btn" data-action="copy-text">Copy</button>' : ""}<button class="btn" data-action="close-dialog">Cancel</button><button class="btn p" data-action="run-export" data-default>Export</button></div></div>`, "export");
  const inner = $("#thumb-inner");
  if (inner) {
    inner.innerHTML = renderPoster(S.trip, o.style, $("#thumb"));
    const width = inner.firstElementChild.offsetWidth || 660;
    const scale = Math.min(1, ($("#thumb").clientWidth - 24) / width);
    inner.style.transform = `scale(${scale})`;
    inner.style.width = `${width}px`;
  }
}
async function runExport() {
  const o = S.exportOpts;
  const btn = $("[data-action=run-export]");
  btn.disabled = true;
  btn.textContent = "Preparing…";
  try {
    let r;
    if (o.format === "text") r = await api().export_text(S.trip);
    else if (o.format === "image") r = await api().export_image(S.trip, await posterToPng(S.trip, o.style, o.appearance));
    else r = await api().export_pdf(S.trip, await posterToPdfPages(S.trip, o.style, o.appearance));
    if (r.cancelled) { btn.disabled = false; btn.textContent = "Export"; return; }
    if (r.ready) { readyDialog(r, "Your export is ready"); return; }
    closeDialog();
    toast(r.ok ? `Saved to ${r.path}` : r.error);
  } catch (err) {
    closeDialog();
    toast(`The export failed: ${err.message || err}`);
  }
}
// Web build: the file is made, and one more tap opens the share sheet or saves it.
function readyDialog(r, title) {
  dialog(`<h2>${esc(title)}</h2><p>${esc(r.name)}</p><div class="ready">
    ${r.canShare ? `<button class="btn p" data-action="deliver" data-value="share" data-default>Share or save to Files</button>` : ""}
    <button class="btn ${r.canShare ? "" : "p"}" data-action="deliver" data-value="save" ${r.canShare ? "" : "data-default"}>Download</button>
    <button class="btn q" data-action="close-dialog">Cancel</button></div>`);
}
async function deliver(el) {
  const r = await api().deliver(el.dataset.value);
  if (r.cancelled) return;
  closeDialog();
  toast(r.ok ? r.message : r.error);
}
function renderThemeDialog() {
  const row = (id, name, desc) => `<button class="theme-row" data-action="set-theme" data-value="${id}" aria-pressed="${S.theme === id}"><span class="swatch" data-theme="${id === "auto" ? themeId() : id}"><i></i></span><span><b>${esc(name)}</b><small>${esc(desc)}</small></span></button>`;
  dialog(`<h2>Theme</h2><p>Posters can use any theme when you export.</p><div class="themes">
    ${row("auto", "Automatic", "Calm when this device is dark, Quiet Ink when it is light")}
    ${THEMES.map(([id, , name, desc]) => row(id, name, desc)).join("")}</div>
    <div class="acts"><button class="btn" data-action="close-dialog" data-default>Done</button></div>`);
}
async function restoreFiles(files) {
  let added = 0, same = 0, failed = 0;
  for (const file of files) {
    const r = api().restore(await file.text());
    if (r.ok) { added += r.added; same += r.same; } else { failed += 1; toast(r.error); }
  }
  if (!failed || added) toast(added ? `${added} trip${added === 1 ? "" : "s"} restored` : same ? "These trips are already on this device" : "No trips found in this file");
  loadTrips();
}
async function copyText() {
  const text = await api().build_text(S.trip);
  try {
    await navigator.clipboard.writeText(text);
    toast("Itinerary copied");
  } catch {
    toast("The clipboard isn't available. Use Export instead.");
  }
}

// Update check ---------------------------------------------------------------------------
function paintVersion() {
  const v = $("#version");
  v.textContent = S.version;
  v.setAttribute("aria-label", `Version ${S.version}`);
  v.title = S.newer ? `${S.newer} is available. Click for details.` : "Check for updates";
  v.classList.toggle("newer", Boolean(S.newer));
  placeVersion();
}
async function checkForUpdates() {
  const v = $("#version");
  v.disabled = true;
  v.textContent = "checking…";
  placeVersion();
  let r;
  try { r = await api().check_for_updates(); }
  catch (err) { r = { status: "error", headline: "Check for updates", detail: String(err.message || err) }; }
  v.disabled = false;
  if (r.status === "newer") S.newer = r.latest;
  paintVersion();
  const offerPage = r.status === "newer" || r.status === "development";
  dialog(`<h2 id="update-title">Check for updates</h2>${r.status === "error" ? "" : `<p style="color:var(--t1)">${esc(r.headline)}</p>`}<p>${esc(r.detail)}</p>
    ${offerPage && r.notes ? `<details><summary>Release notes</summary><pre>${esc(r.notes)}</pre></details>` : ""}
    <div class="acts"><button class="btn" data-action="close-dialog" ${offerPage ? "" : "data-default"}>Close</button>${offerPage ? `<button class="btn p" data-action="open-release" data-url="${esc(r.url)}" data-default>Open release page</button>` : ""}</div>`);
}

// Clicks and keys ------------------------------------------------------------------------
const ACTIONS = {
  "go-home": leaveTrip,
  "new-trip": () => openEditor({ title: "", subtitle: "", notes: "", days: [] }, null),
  "open-trip": async el => {
    const r = await api().load_trip(el.dataset.file);
    if (r.ok) openEditor(r.trip, el.dataset.file); else toast(r.error);
  },
  "delete-trip": async el => {
    const answer = await confirmDialog({
      title: `Delete ${el.dataset.title}?`,
      body: "This permanently deletes the trip file. You can't undo this.",
      buttons: [{ label: "Cancel", value: "cancel", def: true }, { label: "Delete", value: "delete", cls: "d" }],
    });
    if (answer !== "delete") return;
    const r = await api().delete_trip(el.dataset.file);
    if (!r.ok) toast(r.error);
    loadTrips();
  },
  "confirm-answer": el => { const resolve = pendingConfirm; pendingConfirm = null; closeDialog(); if (resolve) resolve(el.dataset.value); },
  "close-dialog": closeDialog,
  tab: el => {
    const v = el.dataset.value;
    if (v === "trip" || v === "route") { S.tab = "editor"; S.pane = v; } else S.tab = v;
    render();
  },
  save: saveTrip,
  "add-day": addDay,
  jump: el => {
    if (S.pane !== "route") { S.pane = "route"; render(); }
    const t = document.getElementById(`day-${el.dataset.day}`);
    if (t) t.scrollIntoView({ block: "start" });
  },
  theme: renderThemeDialog,
  "set-theme": el => { setTheme(el.dataset.value); renderThemeDialog(); },
  deliver,
  backup: () => readyDialog(api().backup(), "Your backup is ready"),
  restore: () => $("#restore-file").click(),
  "day-up": el => moveDay(el.dataset.day, -1),
  "day-down": el => moveDay(el.dataset.day, 1),
  collapse: el => { const id = el.dataset.day; if (S.collapsed.has(id)) S.collapsed.delete(id); else S.collapsed.add(id); render(); },
  "remove-day": el => {
    snapshotForUndo();
    S.trip.days = S.trip.days.filter(d => d.id !== el.dataset.day);
    setDirty(); render();
    toast("Day removed", true);
  },
  "add-entry": el => {
    const day = S.trip.days.find(d => d.id === el.dataset.day);
    const entry = { id: uid(), type: "note", from: "", to: "", duration: "", unit: "hrs", note: "" };
    day.slots[el.dataset.slot].push(entry);
    S.selected = entry.id;
    S.collapsed.delete(day.id);
    setDirty(); render();
    const select = $(`[data-entry-field=type][data-entry="${entry.id}"]`);
    if (select) select.focus();
  },
  "select-entry": el => { S.selected = el.dataset.entry || null; render(); const first = S.selected && $(`.ent.sel [data-entry-field]`); if (first) first.focus(); },
  "remove-entry": el => {
    const found = findEntry(el.dataset.entry);
    if (!found) return;
    snapshotForUndo();
    found.day.slots[found.slot].splice(found.index, 1);
    S.selected = null;
    setDirty(); render();
    toast("Entry deleted", true);
  },
  "entry-up": el => nudgeEntry(el.dataset.entry, -1),
  "entry-down": el => nudgeEntry(el.dataset.entry, 1),
  undo: () => {
    if (!undoSnapshot) return;
    S.trip = JSON.parse(undoSnapshot);
    undoSnapshot = null;
    $("#toast").classList.remove("show");
    setDirty(); render();
  },
  "preview-style": el => { S.trip.poster = el.dataset.value; setDirty(); render(); },
  "open-export": () => {
    S.exportOpts.style = posterStyle();
    S.exportOpts.appearance = themeId();
    renderExportDialog();
  },
  "export-opt": el => { S.exportOpts[el.dataset.opt] = el.dataset.value; renderExportDialog(); },
  "run-export": runExport,
  "copy-text": copyText,
  "open-release": el => { api().open_release_page(el.dataset.url); closeDialog(); },
};
document.addEventListener("click", e => {
  if (e.target.closest("#version")) { checkForUpdates(); return; }
  const el = e.target.closest("[data-action]");
  if (!el || el.disabled) return;
  const run = ACTIONS[el.dataset.action];
  if (run) run(el);
});
document.addEventListener("keydown", e => {
  // Entry rows are plain elements so they can be dragged on every web engine; keep them working as buttons.
  if ((e.key === "Enter" || e.key === " ") && e.target.matches && e.target.matches('.box[role="button"]')) { e.preventDefault(); e.target.click(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && S.screen === "trip") { e.preventDefault(); saveTrip(); return; }
  if (e.key === "Tab" && $("#overlay").children.length) {
    // Keep keyboard focus inside an open dialog.
    const items = $$("#overlay button:not(:disabled),#overlay summary");
    const first = items[0], last = items[items.length - 1];
    if (!items.includes(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    return;
  }
  if (e.key !== "Escape") return;
  if ($("#overlay").children.length) {
    const cancel = $('#overlay [data-value=cancel],#overlay [data-action=close-dialog]');
    if (cancel) cancel.click();
  } else if (S.selected) { S.selected = null; render(); }
});
document.addEventListener("change", e => {
  if (e.target.id === "restore-file" && e.target.files.length) { restoreFiles([...e.target.files]); e.target.value = ""; }
});
window.addEventListener("resize", () => { placeVersion(); if (S.screen === "trip" && S.tab === "preview") fitPoster(); });

// Start ----------------------------------------------------------------------------------
// If the link to Python never arrives or start-up fails, show a message instead of a blank window.
const START_TIMEOUT_MS = 8000;
let started = false;
function showStartFailure() {
  if (started) return;
  document.documentElement.dataset.theme = themeId();
  $("#app").innerHTML = `<div class="scroll"><div class="home"><p class="notice" role="alert">Wayfarer could not start. ${WEB ? "Close it and open it again." : "Close the window and open Wayfarer again."} If this message comes back, report it at github.com/dansong002/wayfarer_remix/issues.</p></div></div>`;
}
// Web build only: work offline, ask the browser to keep the trips, and protect unsaved changes.
function startWeb() {
  $("#version").hidden = true;
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) navigator.serviceWorker.register("sw.js").catch(() => null);
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => null);
  window.addEventListener("beforeunload", e => { if (S.dirty) { e.preventDefault(); e.returnValue = ""; } });
  // A phone can close an app in the background without warning, so save when Wayfarer leaves the screen.
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && S.dirty && S.trip) saveTrip(); });
}
async function boot() {
  try {
    if (WEB) startWeb();
    const settings = (await api().get_settings()) || {};
    S.theme = settings.theme || "auto";
    S.version = await api().get_version();
    S.dataProblem = await api().get_data_problem();
    paintVersion();
    S.screen = "home";
    applyTheme();
    await loadTrips();
    started = true;
    document.fonts.ready.then(placeVersion);
  } catch (err) {
    console.error(err);
    showStartFailure();
  }
}
setTimeout(showStartFailure, START_TIMEOUT_MS);
if (WEB || (window.pywebview && window.pywebview.api)) boot();
else window.addEventListener("pywebviewready", boot, { once: true });
