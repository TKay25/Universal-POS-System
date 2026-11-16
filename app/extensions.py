"""Shared extension instances.

Kept in their own module so blueprints, models and tests can import them without
creating circular imports through the app factory.
"""

from __future__ import annotations

from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()
