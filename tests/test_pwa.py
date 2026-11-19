"""Installable-app plumbing: manifest, service worker and offline shell."""

from __future__ import annotations

import struct
from pathlib import Path

STATIC = Path(__file__).resolve().parents[1] / "app" / "static"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def png_size(path: Path) -> tuple[int, int]:
    data = path.read_bytes()[:24]
    assert data[:8] == PNG_SIGNATURE, f"{path.name} is not a PNG"
    return struct.unpack(">II", data[16:24])


def test_manifest_declares_an_installable_app(client):
    response = client.get("/manifest.webmanifest")
    assert response.status_code == 200
    assert response.mimetype == "application/manifest+json"

    manifest = response.get_json()
    assert manifest["name"] and manifest["short_name"]
    assert manifest["start_url"] == "/"
    assert manifest["scope"] == "/"
    assert manifest["display"] == "standalone"
    assert manifest["theme_color"] and manifest["background_color"]

    purposes = {icon["purpose"] for icon in manifest["icons"]}
    assert {"any", "maskable"} <= purposes
    assert {"192x192", "512x512"} <= {icon["sizes"] for icon in manifest["icons"]}


def test_manifest_icons_are_shipped_at_the_declared_size(client):
    manifest = client.get("/manifest.webmanifest").get_json()
    assert manifest["icons"]
    for icon in manifest["icons"]:
        path = STATIC / icon["src"].replace("/static/", "", 1)
        width, height = png_size(path)
        assert f"{width}x{height}" == icon["sizes"], icon["src"]


def test_service_worker_is_served_from_the_root_with_a_short_cache(client):
    response = client.get("/sw.js")
    assert response.status_code == 200
    assert response.mimetype in {"text/javascript", "application/javascript"}
    assert response.headers["Service-Worker-Allowed"] == "/"
    assert response.headers["Cache-Control"] == "no-cache"


def test_service_worker_never_caches_api_traffic(client):
    body = client.get("/sw.js").get_data(as_text=True)
    assert '"/api/"' in body
    assert "fetch" in body


def test_offline_shell_is_served(client):
    response = client.get("/offline")
    assert response.status_code == 200
    assert response.mimetype == "text/html"
    assert b"You are offline" in response.data


def test_shell_links_the_manifest_and_apple_icon(client):
    html = client.get("/").get_data(as_text=True)
    assert 'rel="manifest" href="/manifest.webmanifest"' in html
    assert 'name="theme-color"' in html
    assert 'rel="apple-touch-icon" sizes="180x180" href="/static/icons/apple-touch-icon.png"' in html
    assert 'name="apple-mobile-web-app-capable"' in html
