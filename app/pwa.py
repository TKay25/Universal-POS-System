"""Progressive web app plumbing: manifest, service worker and offline shell.

The service worker and manifest are served from the site root rather than
``/static`` so the worker's default scope is the whole application. Tenant data
(``/api/*``) is never involved here; it is cached in the browser only by the app.
"""

from __future__ import annotations

from flask import Flask, make_response, render_template, send_from_directory


def init_pwa(app: Flask) -> None:
    @app.get("/manifest.webmanifest")
    def pwa_manifest():
        response = send_from_directory(
            app.static_folder, "manifest.webmanifest", mimetype="application/manifest+json"
        )
        response.headers["Cache-Control"] = "public, max-age=3600"
        return response

    @app.get("/sw.js")
    def pwa_service_worker():
        response = send_from_directory(app.static_folder, "sw.js", mimetype="text/javascript")
        # The file lives under /static, but installing from here keeps scope "/".
        response.headers["Service-Worker-Allowed"] = "/"
        # A cached worker would pin clients to an old release until it expires.
        response.headers["Cache-Control"] = "no-cache"
        return response

    @app.get("/offline")
    def pwa_offline():
        return make_response(render_template("offline.html"))
