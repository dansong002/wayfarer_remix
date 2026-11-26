// The browser version of the app's Python API, used by the phone and web build (mode.js turns it on).
// It answers the same calls as wayfarer/app.py with the same results. Trips stay in this browser's storage on
// this device. Nothing is sent anywhere. Exports become files that the user shares or saves with a tap.
"use strict";

const webApi = (() => {
  const TRIP_KEY = "wayfarer:trip:";
  const SETTINGS_KEY = "wayfarer:settings";
  const SAFE_NAME = /^[^/\\:*?"<>|\x00-\x1f.][^/\\:*?"<>|\x00-\x1f]*\.json$/;
  const A4_WIDTH_PT = 595.28;
  const NO_STORAGE = "This browser blocks storage, so Wayfarer can't save trips here. Turn off private browsing, then open Wayfarer again.";
  let dirty = false;
  let ready = null; // The last export, waiting for the user to share or save it.

  // Storage ---------------------------------------------------------------------------------
  const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const keys = () => { try { return Object.keys(localStorage); } catch { return []; } };
  function storageWorks() {
    try { localStorage.setItem("wayfarer:probe", "1"); localStorage.removeItem("wayfarer:probe"); return true; } catch { return false; }
  }
  function checkName(filename) {
    if (typeof filename !== "string" || !SAFE_NAME.test(filename)) throw new Error(`Not a trip file name: ${filename}`);
    return TRIP_KEY + filename;
  }
  function slugify(title, fallback = "trip") {
    const slug = String(title || "").trim().replace(/[^\p{L}\p{N}\p{M}_-]+/gu, "-").replace(/^[-_]+|[-_]+$/g, "");
    return slug.slice(0, 60).replace(/[-_]+$/, "") || fallback;
  }
  function newName(title) {
    const hex = [...crypto.getRandomValues(new Uint8Array(4))].map(b => b.toString(16).padStart(2, "0")).join("");
    return `${slugify(title)}-${hex}.json`;
  }
  function summary(filename, data) {
    const days = Array.isArray(data.days) ? data.days : [];
    const dates = days.map(d => d && d.date).filter(Boolean).sort();
    const modes = [];
    days.forEach(day => SLOTS.forEach(([slot]) => ((day && day.slots && day.slots[slot]) || []).forEach(e => modes.push((e && e.type) || "note"))));
    return { filename, title: data.title || "Untitled trip", subtitle: data.subtitle || "", days: days.length, first: dates[0] || "", last: dates[dates.length - 1] || "", modes };
  }
  function writeTrip(filename, trip) {
    try { localStorage.setItem(checkName(filename), JSON.stringify(trip)); }
    catch (e) {
      if (e.name === "QuotaExceededError") throw new Error("This device has no room left for Wayfarer's trips. Delete a trip or export it first.");
      throw e;
    }
  }

  // Text and PDF exports, matching wayfarer/export.py -------------------------------------------
  function entryLines(entry) {
    const kind = entry.type || "note";
    const label = TYPE_LABELS[kind] || kind.charAt(0).toUpperCase() + kind.slice(1);
    let note = String(entry.note || "").trim();
    let head;
    if (kind === "note") { head = note || label; note = ""; }
    else {
      const route = [entry.from, entry.to].filter(Boolean).join(" → ");
      head = route ? `${label}: ${route}` : label;
    }
    const extras = [];
    const duration = fmtDuration(entry);
    if (duration) extras.push(duration);
    const night = overnightLabel(entry);
    if (night) extras.push(night);
    if (extras.length) head += ` (${extras.join(", ")})`;
    return [`    ${head}`, ...(note ? [`      ${note}`] : [])];
  }
  function buildText(trip) {
    const days = trip.days || [];
    const lines = [trip.title || "Untitled trip"];
    if (trip.subtitle) lines.push(trip.subtitle);
    lines.push(tripSummary(days));
    if (trip.notes) lines.push("", "Notes", ...String(trip.notes).split(/\r\n|\r|\n/).map(l => `  ${l}`));
    days.forEach((day, i) => {
      const head = [`Day ${i + 1}`];
      const when = fmtFull(day.date);
      if (when) head.push(when);
      if (day.label) head.push(day.label);
      lines.push("", head.length > 1 ? `${head[0]}: ${head.slice(1).join(", ")}` : head[0]);
      SLOTS.forEach(([slot, slotLabel]) => {
        const entries = (day.slots || {})[slot] || [];
        if (entries.length) { lines.push(`  ${slotLabel}`); entries.forEach(e => lines.push(...entryLines(e))); }
      });
    });
    return lines.join("\n") + "\n";
  }
  const fromBase64 = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const latin1 = text => Uint8Array.from(text, c => c.charCodeAt(0));
  function jpegSize(data) {
    if (data[0] !== 0xff || data[1] !== 0xd8) throw new Error("Not a JPEG image");
    let i = 2;
    while (i + 9 < data.length) {
      if (data[i] !== 0xff) throw new Error("Damaged JPEG image");
      const marker = data[i + 1];
      if (marker === 0xff) { i += 1; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return [(data[i + 7] << 8) | data[i + 8], (data[i + 5] << 8) | data[i + 6]];
      }
      i += 2 + ((data[i + 2] << 8) | data[i + 3]);
    }
    throw new Error("Damaged JPEG image");
  }
  // One full-page image per JPEG. Each page is A4 wide and as tall as its image.
  function buildPdf(pages, title = "") {
    if (!pages.length) throw new Error("A PDF needs at least one page");
    const safeTitle = String(title).replace(/[()\\\r\n]/g, " ").replace(/[^\x00-\xff]/g, "?");
    const objects = { 1: [latin1("<< /Type /Catalog /Pages 2 0 R >>")], 3: [latin1(`<< /Title (${safeTitle}) /Producer (Wayfarer) >>`)] };
    const kids = [];
    pages.forEach((jpeg, n) => {
      const pageId = 4 + n * 3, imageId = 5 + n * 3, contentId = 6 + n * 3;
      const [width, height] = jpegSize(jpeg);
      const pageH = (A4_WIDTH_PT * height / width).toFixed(2);
      const content = `q ${A4_WIDTH_PT.toFixed(2)} 0 0 ${pageH} 0 0 cm /Im Do Q`;
      objects[pageId] = [latin1(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4_WIDTH_PT.toFixed(2)} ${pageH}] /Contents ${contentId} 0 R /Resources << /XObject << /Im ${imageId} 0 R >> >> >>`)];
      objects[imageId] = [latin1(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, latin1("\nendstream")];
      objects[contentId] = [latin1(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`)];
      kids.push(`${pageId} 0 R`);
    });
    objects[2] = [latin1(`<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`)];
    const parts = [latin1("%PDF-1.4\n")];
    let size = parts[0].length;
    const push = chunk => { parts.push(chunk); size += chunk.length; };
    const ids = Object.keys(objects).map(Number).sort((a, b) => a - b);
    const offsets = {};
    ids.forEach(id => {
      offsets[id] = size;
      push(latin1(`${id} 0 obj\n`));
      objects[id].forEach(push);
      push(latin1("\nendobj\n"));
    });
    const xref = size;
    const count = ids[ids.length - 1] + 1;
    let tail = `xref\n0 ${count}\n0000000000 65535 f \n`;
    for (let id = 1; id < count; id++) tail += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
    tail += `trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    push(latin1(tail));
    return new Blob(parts, { type: "application/pdf" });
  }

  // Handing a file to the user --------------------------------------------------------------
  // Building an export takes a few seconds. Phones only open the share sheet straight after a tap,
  // so the file waits here and the app asks for one more tap: Share or Save.
  function offer(name, blob) {
    ready = new File([blob], name, { type: blob.type });
    const canShare = Boolean(navigator.canShare && navigator.share && navigator.canShare({ files: [ready] }));
    return { ok: true, ready: true, name, canShare };
  }
  function exportName(trip, ext) { return `${slugify(trip.title, "itinerary")}.${ext}`; }
  function saveFile(file) {
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url; a.download = file.name; a.rel = "noopener";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  return {
    // Settings and state
    get_version: () => (window.WAYFARER_WEB && window.WAYFARER_WEB.version) || "web",
    get_data_problem: () => (storageWorks() ? null : NO_STORAGE),
    set_dirty: value => { dirty = Boolean(value); },
    is_dirty: () => dirty,
    close_window: () => {},
    get_settings: () => { try { return JSON.parse(read(SETTINGS_KEY)) || {}; } catch { return {}; } },
    set_settings: settings => {
      try {
        const current = JSON.parse(read(SETTINGS_KEY) || "{}") || {};
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...current, ...settings }));
        return { ok: true };
      } catch (e) { return { ok: false, error: String(e.message || e) }; }
    },

    // Trips
    list_trips() {
      const trips = keys().filter(k => k.startsWith(TRIP_KEY)).map(k => {
        const filename = k.slice(TRIP_KEY.length);
        try {
          const data = JSON.parse(read(k));
          if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("not a trip");
          return summary(filename, data);
        } catch { return { filename, title: filename, error: true }; }
      });
      return trips.sort((a, b) => String(a.title).toLowerCase().localeCompare(String(b.title).toLowerCase()));
    },
    load_trip(filename) {
      try {
        const text = read(checkName(filename));
        if (text == null) throw new Error("The trip is not on this device");
        const data = JSON.parse(text);
        if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("A trip file must hold one JSON object");
        return { ok: true, trip: data };
      } catch (e) { return { ok: false, error: `This trip can't be opened: ${e.message || e}` }; }
    },
    save_trip(trip, filename = null) {
      try {
        const name = filename || newName(trip.title);
        writeTrip(name, trip);
        return { ok: true, filename: name };
      } catch (e) { return { ok: false, error: `The trip was not saved. ${e.message || e}` }; }
    },
    delete_trip(filename) {
      try { localStorage.removeItem(checkName(filename)); return { ok: true }; }
      catch (e) { return { ok: false, error: `The trip was not deleted: ${e.message || e}` }; }
    },

    // Exports
    build_text: trip => buildText(trip),
    export_text: trip => offer(exportName(trip, "txt"), new Blob([buildText(trip)], { type: "text/plain;charset=utf-8" })),
    export_image: (trip, pngBase64) => offer(exportName(trip, "png"), new Blob([fromBase64(pngBase64)], { type: "image/png" })),
    export_pdf: (trip, pagesBase64) => offer(exportName(trip, "pdf"), buildPdf(pagesBase64.map(fromBase64), trip.title || "")),
    ready_file: () => ready,
    // Call straight from a tap: the share sheet needs it.
    deliver(how) {
      if (!ready) return Promise.resolve({ ok: false, error: "There is no file to save. Export the trip again." });
      const file = ready;
      if (how === "share") {
        return navigator.share({ files: [file], title: file.name })
          .then(() => ({ ok: true, message: "Shared" }))
          .catch(e => (e && e.name === "AbortError" ? { ok: false, cancelled: true } : { ok: false, error: `The file was not shared: ${e.message || e}` }));
      }
      saveFile(file);
      return Promise.resolve({ ok: true, message: `Saved ${file.name}` });
    },

    // Back up and restore all trips on this device
    backup() {
      const trips = keys().filter(k => k.startsWith(TRIP_KEY)).map(k => {
        try { return { filename: k.slice(TRIP_KEY.length), trip: JSON.parse(read(k)) }; } catch { return null; }
      }).filter(Boolean);
      const body = JSON.stringify({ app: "wayfarer", kind: "backup", version: 1, saved: new Date().toISOString(), trips }, null, 2);
      const r = offer(`wayfarer-backup-${toISO(new Date())}.json`, new Blob([body], { type: "application/json" }));
      return { ...r, count: trips.length };
    },
    // Takes a backup file, or one trip file from the desktop app. Never overwrites a different trip.
    restore(text) {
      let data;
      try { data = JSON.parse(text); } catch { return { ok: false, error: "This file isn't a Wayfarer backup or trip." }; }
      let items;
      if (data && data.kind === "backup" && Array.isArray(data.trips)) items = data.trips;
      else if (data && typeof data === "object" && !Array.isArray(data) && ("days" in data || "title" in data)) items = [{ filename: null, trip: data }];
      else return { ok: false, error: "This file isn't a Wayfarer backup or trip." };
      let added = 0, same = 0;
      try {
        items.forEach(item => {
          if (!item || !item.trip || typeof item.trip !== "object" || Array.isArray(item.trip)) return;
          const body = JSON.stringify(item.trip);
          const valid = typeof item.filename === "string" && SAFE_NAME.test(item.filename);
          const existing = valid ? read(TRIP_KEY + item.filename) : null;
          if (existing === body) { same += 1; return; }
          writeTrip(valid && existing == null ? item.filename : newName(item.trip.title), item.trip);
          added += 1;
        });
      } catch (e) { return { ok: false, error: `Some trips were not restored. ${e.message || e}`, added }; }
      return { ok: true, added, same };
    },
  };
})();
