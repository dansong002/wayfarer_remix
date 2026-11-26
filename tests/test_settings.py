"""Tests for saved settings: only known settings and values are kept, and a damaged file gives the defaults."""

import json

from wayfarer.app import Api


def test_settings_start_empty(tmp_path):
    assert Api(root=tmp_path).get_settings() == {}


def test_theme_is_saved_and_read_back(tmp_path):
    api = Api(root=tmp_path)
    assert api.set_settings({"theme": "shelf"}) == {"ok": True}
    assert Api(root=tmp_path).get_settings() == {"theme": "shelf"}


def test_unknown_settings_and_values_are_ignored(tmp_path):
    api = Api(root=tmp_path)
    api.set_settings({"theme": "neon", "evil": "x"})
    assert api.get_settings() == {}
    api.set_settings({"theme": "ink"})
    api.set_settings({"theme": 3})
    assert api.get_settings() == {"theme": "ink"}


def test_settings_must_be_an_object(tmp_path):
    assert Api(root=tmp_path).set_settings(["theme"])["ok"] is False


def test_damaged_settings_file_gives_defaults(tmp_path):
    (tmp_path / "settings.json").write_text("{not json", encoding="utf-8")
    assert Api(root=tmp_path).get_settings() == {}
    (tmp_path / "settings.json").write_text(json.dumps(["calm"]), encoding="utf-8")
    assert Api(root=tmp_path).get_settings() == {}
