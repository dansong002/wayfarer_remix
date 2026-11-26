"""Tests for the phone and web build: the build output, and that the browser backend (webapi.js) behaves like the
desktop app's Python code. The browser tests run webapi.js in Node, and are skipped where Node isn't installed."""

import base64
import importlib.util
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from tests.test_export import TRIP, fake_jpeg
from wayfarer.export import build_pdf, build_text

ROOT = Path(__file__).parent.parent
UI = ROOT / "wayfarer" / "ui"
_spec = importlib.util.spec_from_file_location("build_web", ROOT / "web" / "build.py")
build_web = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(build_web)

# Loads the UI's shared helpers and webapi.js with an in-memory localStorage, then runs a script against webApi.
# The script is an async function of (api, args, bytes); its result comes back as JSON.
NODE_HARNESS = r"""
const fs = require("fs"), vm = require("vm");
const store = new Map();
const storage = {
  getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: k => { store.delete(k); },
};
const ctx = {
  console, Blob, atob, btoa, TextDecoder, crypto: globalThis.crypto, Uint8Array, Date, Math, JSON, Promise,
  localStorage: new Proxy(storage, {
    ownKeys: () => [...store.keys()],
    getOwnPropertyDescriptor: (t, k) => (store.has(k) ? { enumerable: true, configurable: true, value: store.get(k) } : undefined),
  }),
  navigator: {}, window: {},
  File: class extends Blob { constructor(parts, name, o) { super(parts, o); this.name = name; } },
};
vm.createContext(ctx);
for (const f of ["routes.js", "webapi.js"]) vm.runInContext(fs.readFileSync(process.argv[1] + "/" + f, "utf8"), ctx, { filename: f });
vm.runInContext("this.webApi = webApi;", ctx);
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const bytes = async blob => Buffer.from(await blob.arrayBuffer()).toString("base64");
vm.runInContext(`(${input.script})`, ctx)(ctx.webApi, input.args, bytes)
  .then(out => process.stdout.write(JSON.stringify(out === undefined ? null : out)))
  .catch(e => { console.error(e); process.exit(1); });
"""

needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="Node is not installed")


def run_web(script: str, args=None):
    result = subprocess.run(
        ["node", "-e", NODE_HARNESS, str(UI)],
        input=json.dumps({"script": script, "args": args}),
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


# Build ---------------------------------------------------------------------------------------


def test_build_switches_to_the_browser_backend(tmp_path):
    out = tmp_path / "site"
    build_web.build(out, "web-abc1234")
    mode = (out / "mode.js").read_text(encoding="utf-8")
    assert "window.WAYFARER_WEB = " in mode
    assert '"version": "web-abc1234"' in mode
    assert (out / ".nojekyll").exists()
    assert not (out / "icon.ico").exists()


def test_service_worker_keeps_every_file_it_needs(tmp_path):
    out = tmp_path / "site"
    cached = build_web.build(out)
    for name in ("./", "index.html", "app.js", "webapi.js", "mode.js", "manifest.webmanifest", "icon-192.png"):
        assert name in cached
    assert all((out / name).is_file() for name in cached if name != "./")
    assert "sw.js" not in cached


def test_desktop_mode_file_keeps_the_python_backend():
    assert "window.WAYFARER_WEB = null;" in (UI / "mode.js").read_text(encoding="utf-8")


def test_manifest_icons_exist():
    manifest = json.loads((UI / "manifest.webmanifest").read_text(encoding="utf-8"))
    assert manifest["display"] == "standalone"
    for icon in manifest["icons"]:
        assert (UI / icon["src"]).is_file()


# The browser backend matches the Python one -----------------------------------------------------

_SAMPLE = (ROOT / "docs" / "app" / "sample.js").read_text(encoding="utf-8")
JAPAN = json.loads(_SAMPLE.split("const SAMPLE_TRIP = ", 1)[1].split(";\nconst SAMPLE_TEXT", 1)[0])


@needs_node
@pytest.mark.parametrize("trip", [TRIP, JAPAN, {"title": "", "days": []}], ids=["portugal", "japan", "empty"])
def test_text_export_matches_python(trip):
    assert run_web("async (api, trip) => api.build_text(trip)", trip) == build_text(trip)


@needs_node
def test_pdf_export_matches_python_byte_for_byte():
    pages = [fake_jpeg(1650, 2333), fake_jpeg(1650, 900)]
    title = "Portugal (coast) é ✈"
    got = run_web(
        "async (api, a, bytes) => { const r = api.export_pdf({ title: a.title }, a.pages);"
        " return { r, pdf: await bytes(api.ready_file()) }; }",
        {"title": title, "pages": [base64.b64encode(p).decode() for p in pages]},
    )
    assert got["r"]["ready"] is True
    assert got["r"]["name"] == "Portugal-coast-é.pdf"
    assert base64.b64decode(got["pdf"]) == build_pdf(pages, title)


@needs_node
def test_trips_save_list_load_and_delete():
    got = run_web(
        """async (api, trip) => {
          const saved = api.save_trip(trip);
          const again = api.save_trip({ ...trip, title: "Renamed" }, saved.filename);
          const list = api.list_trips();
          const loaded = api.load_trip(saved.filename);
          const bad = api.load_trip("../evil.json");
          api.delete_trip(saved.filename);
          return { saved, again, list, loaded, bad, after: api.list_trips() };
        }""",
        TRIP,
    )
    assert got["saved"]["ok"]
    assert got["saved"]["filename"].startswith("Portugal-coast-")
    assert got["again"]["filename"] == got["saved"]["filename"]
    assert got["list"][0]["title"] == "Renamed"
    assert got["list"][0]["days"] == len(TRIP["days"])
    assert got["loaded"]["trip"]["title"] == "Renamed"
    assert got["bad"]["ok"] is False
    assert got["after"] == []


@needs_node
def test_backup_restores_without_overwriting():
    got = run_web(
        """async (api, trip, bytes) => {
          const first = api.save_trip(trip).filename;
          const backup = api.backup();
          const text = new TextDecoder().decode(Uint8Array.from(atob(await bytes(api.ready_file())), c => c.charCodeAt(0)));
          const same = api.restore(text);
          api.save_trip({ ...trip, title: "Changed here" }, first);
          const changed = api.restore(text);
          const single = api.restore(JSON.stringify({ title: "From desktop", days: [] }));
          const junk = api.restore("[1, 2]");
          return { backup, same, changed, single, junk, titles: api.list_trips().map(t => t.title) };
        }""",
        TRIP,
    )
    assert got["backup"]["count"] == 1
    assert got["same"] == {"ok": True, "added": 0, "same": 1}
    assert got["changed"]["added"] == 1
    assert got["single"]["added"] == 1
    assert got["junk"]["ok"] is False
    assert sorted(got["titles"]) == ["Changed here", "From desktop", "Portugal coast"]


@needs_node
def test_settings_are_kept():
    assert run_web("async api => { api.set_settings({ theme: 'signal' }); return api.get_settings(); }") == {"theme": "signal"}
