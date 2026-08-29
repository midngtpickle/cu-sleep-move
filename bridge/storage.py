"""
WiFi Sleep Monitor — Local SQLite Storage
==========================================
Single storage backend: an on-disk SQLite database, no network, no credentials.

Sessions
--------
A session is one run of the bridge. You start it at bedtime and stop it in the
morning, so the process lifetime *is* the night — there is no need to infer
boundaries from gaps in the data or from a clock rule, and no ambiguity when a
nap or an early night shifts the schedule.

Two things keep that honest:

* **Resume window.** Restarting the bridge shortly after stopping it (a config
  tweak, a crash, closing the wrong terminal) rejoins the session that was just
  running instead of splitting one night in two.
* **Crash repair.** A session left open by a hard kill is closed on next start
  using the timestamp of its last recorded data, not the time of the repair.

Rollups
-------
`vitals_history` carries typed summary columns alongside the raw JSON, so a
night's statistics are a plain SQL `GROUP BY` — fast, always current, and
correct for the session that is still in progress. Nothing is cached, so
nothing can go stale.
"""

import json
import sqlite3
import threading
import time
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional

SCHEMA_VERSION = 2

# A restart within this window rejoins the previous session rather than
# starting a new one. Overridable via config: session_resume_gap_seconds.
DEFAULT_RESUME_GAP_S = 1200.0   # 20 minutes


class BaseStorage(ABC):
    """Interface for vitals persistence."""

    # ── Session lifecycle ──
    @abstractmethod
    def open_session(self, node_id: str, resume_gap_s: float = DEFAULT_RESUME_GAP_S) -> int:
        """Start (or resume) a session for a node. Returns the session id."""

    @abstractmethod
    def close_session(self, session_id: int, ended_at: Optional[float] = None) -> None:
        """Mark a session finished."""

    # ── Writes ──
    @abstractmethod
    def save_live_vitals(self, node_id: str, data: Dict[str, Any]) -> None:
        """Write the current 1 Hz snapshot for real-time monitoring."""

    @abstractmethod
    def save_vitals_batch(self, node_id: str, batch_doc: Dict[str, Any],
                          session_id: Optional[int] = None) -> None:
        """Write a 60 s aggregated minute summary."""

    @abstractmethod
    def save_apnea_event(self, node_id: str, event_doc: Dict[str, Any],
                         session_id: Optional[int] = None) -> None:
        """Write a confirmed apnea episode."""

    @abstractmethod
    def save_sensing_event(self, node_id: str, event_doc: Dict[str, Any],
                           session_id: Optional[int] = None) -> None:
        """Write a discrete sensing event (fall, motion burst, …)."""

    @abstractmethod
    def save_node_metadata(self, node_id: str, meta_doc: Dict[str, Any]) -> None:
        """Merge node status & configuration metadata."""

    # ── Reads ──
    @abstractmethod
    def get_live_vitals(self, node_id: str) -> Optional[Dict[str, Any]]:
        ...

    @abstractmethod
    def get_history(self, node_id: str, limit_count: int = 500) -> List[Dict[str, Any]]:
        ...

    @abstractmethod
    def get_nodes(self) -> List[Dict[str, Any]]:
        ...

    @abstractmethod
    def get_apnea_events(self, node_id: str, limit_count: int = 50) -> List[Dict[str, Any]]:
        ...

    @abstractmethod
    def get_sensing_events(self, node_id: str, limit_count: int = 50) -> List[Dict[str, Any]]:
        ...

    @abstractmethod
    def get_sessions(self, node_id: Optional[str] = None, limit_count: int = 60) -> List[Dict[str, Any]]:
        ...

    @abstractmethod
    def get_session(self, session_id: int) -> Optional[Dict[str, Any]]:
        ...

    @abstractmethod
    def get_session_vitals(self, session_id: int, include_samples: bool = False) -> List[Dict[str, Any]]:
        ...


class SQLiteStorage(BaseStorage):
    """Local SQLite database, safe for the bridge thread and HTTP threads."""

    def __init__(self, db_path: str = "vitals.db"):
        self.db_path = db_path
        # Serialises read-modify-write sequences; SQLite handles the rest.
        self._write_lock = threading.Lock()
        self._init_db()

    def _get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=10.0)
        conn.row_factory = sqlite3.Row
        # WAL lets the HTTP threads read while the bridge thread writes.
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    # ── Schema ────────────────────────────────────────────────

    def _init_db(self) -> None:
        # Order matters. CREATE TABLE IF NOT EXISTS is a no-op against a
        # pre-existing v1 table, so the new columns only appear once the
        # migration has run — and the indexes reference those columns.
        with self._get_connection() as conn:
            version = conn.execute("PRAGMA user_version").fetchone()[0]
            self._create_tables(conn)
            if version < 2:
                self._migrate_to_v2(conn, version)
            self._create_indexes(conn)
            conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
            conn.commit()

    def _create_tables(self, conn: sqlite3.Connection) -> None:
        c = conn.cursor()

        c.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                node_id     TEXT NOT NULL,
                started_at  REAL NOT NULL,
                ended_at    REAL,
                status      TEXT NOT NULL DEFAULT 'active'
            )
        """)

        c.execute("""
            CREATE TABLE IF NOT EXISTS live_vitals (
                node_id    TEXT PRIMARY KEY,
                data_json  TEXT NOT NULL,
                updated_at REAL NOT NULL
            )
        """)

        # Typed summary columns mirror the JSON so rollups are pure SQL.
        # data_json still holds the full document, raw samples included.
        c.execute("""
            CREATE TABLE IF NOT EXISTS vitals_history (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                node_id       TEXT NOT NULL,
                session_id    INTEGER,
                timestamp     INTEGER NOT NULL,
                created_at    REAL NOT NULL,
                sample_count  INTEGER,
                br_min        REAL,
                br_max        REAL,
                br_avg        REAL,
                hr_min        REAL,
                hr_max        REAL,
                hr_avg        REAL,
                conf_avg      REAL,
                apnea_samples INTEGER DEFAULT 0,
                data_json     TEXT NOT NULL
            )
        """)

        c.execute("""
            CREATE TABLE IF NOT EXISTS apnea_events (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                node_id    TEXT NOT NULL,
                session_id INTEGER,
                start_time REAL NOT NULL,
                duration   REAL,
                min_br     REAL,
                data_json  TEXT NOT NULL
            )
        """)

        c.execute("""
            CREATE TABLE IF NOT EXISTS sensing_events (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                node_id    TEXT NOT NULL,
                session_id INTEGER,
                timestamp  REAL NOT NULL,
                type       TEXT,
                data_json  TEXT NOT NULL
            )
        """)

        c.execute("""
            CREATE TABLE IF NOT EXISTS nodes (
                node_id    TEXT PRIMARY KEY,
                data_json  TEXT NOT NULL,
                updated_at REAL NOT NULL
            )
        """)

    def _create_indexes(self, conn: sqlite3.Connection) -> None:
        """Built after migration, since they reference v2 columns."""
        c = conn.cursor()
        c.execute("CREATE INDEX IF NOT EXISTS idx_sessions_node "
                  "ON sessions(node_id, started_at DESC)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_vitals_history_node_ts "
                  "ON vitals_history(node_id, timestamp DESC)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_vitals_history_session "
                  "ON vitals_history(session_id, timestamp ASC)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_apnea_node_time "
                  "ON apnea_events(node_id, start_time DESC)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_apnea_session "
                  "ON apnea_events(session_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_sensing_node_time "
                  "ON sensing_events(node_id, timestamp DESC)")

    def _migrate_to_v2(self, conn: sqlite3.Connection, from_version: int) -> None:
        """Bring a v1 database (no sessions, JSON-only stats) up to v2.

        v1 rows predate sessions entirely, so their boundaries have to be
        inferred once, here, by gap detection. Everything recorded from now on
        gets its session id at write time instead of being guessed at.
        """
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(vitals_history)")}
        added = []
        for name, decl in (
            ("session_id", "INTEGER"), ("sample_count", "INTEGER"),
            ("br_min", "REAL"), ("br_max", "REAL"), ("br_avg", "REAL"),
            ("hr_min", "REAL"), ("hr_max", "REAL"), ("hr_avg", "REAL"),
            ("conf_avg", "REAL"), ("apnea_samples", "INTEGER"),
        ):
            if name not in cols:
                conn.execute(f"ALTER TABLE vitals_history ADD COLUMN {name} {decl}")
                added.append(name)

        for table, extra in (("apnea_events", (("session_id", "INTEGER"),
                                               ("duration", "REAL"),
                                               ("min_br", "REAL"))),
                             ("sensing_events", (("session_id", "INTEGER"),
                                                 ("type", "TEXT")))):
            existing = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
            for name, decl in extra:
                if name not in existing:
                    conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")

        rows = conn.execute(
            "SELECT id, node_id, timestamp, data_json FROM vitals_history "
            "ORDER BY node_id ASC, timestamp ASC"
        ).fetchall()
        if not rows:
            return

        print(f"[storage] Migrating {len(rows)} legacy rows to schema v2 "
              f"(from v{from_version}) — inferring past session boundaries…")

        # Backfill the typed columns from the stored JSON.
        for r in rows:
            try:
                doc = json.loads(r["data_json"])
            except (ValueError, TypeError):
                continue
            br, hr = doc.get("breathing_rate") or {}, doc.get("heart_rate") or {}
            conn.execute(
                "UPDATE vitals_history SET sample_count=?, br_min=?, br_max=?, br_avg=?, "
                "hr_min=?, hr_max=?, hr_avg=?, conf_avg=?, apnea_samples=? WHERE id=?",
                (doc.get("sample_count"), br.get("min"), br.get("max"), br.get("avg"),
                 hr.get("min"), hr.get("max"), hr.get("avg"),
                 doc.get("confidence_avg"), doc.get("apnea_sample_count") or 0, r["id"])
            )

        # Group historical rows into sessions wherever the recording stopped.
        sessions_made = 0
        current_node = None
        current_id = None
        prev_ts = None

        for r in rows:
            ts = r["timestamp"]
            new_session = (
                r["node_id"] != current_node
                or prev_ts is None
                or (ts - prev_ts) > DEFAULT_RESUME_GAP_S
            )
            if new_session:
                cur = conn.execute(
                    "INSERT INTO sessions (node_id, started_at, ended_at, status) "
                    "VALUES (?, ?, ?, 'completed')", (r["node_id"], ts, ts)
                )
                current_id = cur.lastrowid
                current_node = r["node_id"]
                sessions_made += 1

            conn.execute("UPDATE vitals_history SET session_id=? WHERE id=?", (current_id, r["id"]))
            conn.execute("UPDATE sessions SET ended_at=? WHERE id=?", (ts, current_id))
            prev_ts = ts

        # Attach historical apnea events to whichever session was running.
        conn.execute("""
            UPDATE apnea_events SET session_id = (
                SELECT s.id FROM sessions s
                WHERE s.node_id = apnea_events.node_id
                  AND apnea_events.start_time BETWEEN s.started_at - 120 AND s.ended_at + 120
                ORDER BY s.started_at DESC LIMIT 1
            ) WHERE session_id IS NULL
        """)
        conn.execute("""
            UPDATE sensing_events SET session_id = (
                SELECT s.id FROM sessions s
                WHERE s.node_id = sensing_events.node_id
                  AND sensing_events.timestamp BETWEEN s.started_at - 120 AND s.ended_at + 120
                ORDER BY s.started_at DESC LIMIT 1
            ) WHERE session_id IS NULL
        """)
        print(f"[storage] Migration complete — {sessions_made} past sessions reconstructed.")

    # ── Session lifecycle ─────────────────────────────────────

    def open_session(self, node_id: str, resume_gap_s: float = DEFAULT_RESUME_GAP_S) -> int:
        """Start a session, or resume the previous one if it ended recently.

        Resuming matters because stopping and restarting the bridge mid-night
        (a config change, a crash, the wrong window closed) should not chop one
        night's sleep into two half-nights in the report.
        """
        now = time.time()
        with self._write_lock, self._get_connection() as conn:
            self._repair_dangling(conn, node_id, now)

            prev = conn.execute(
                "SELECT id, ended_at FROM sessions WHERE node_id = ? AND status = 'completed' "
                "ORDER BY started_at DESC LIMIT 1", (node_id,)
            ).fetchone()

            if prev and prev["ended_at"] and (now - prev["ended_at"]) <= resume_gap_s:
                conn.execute(
                    "UPDATE sessions SET status='active', ended_at=NULL WHERE id=?",
                    (prev["id"],)
                )
                conn.commit()
                return int(prev["id"])

            cur = conn.execute(
                "INSERT INTO sessions (node_id, started_at, status) VALUES (?, ?, 'active')",
                (node_id, now)
            )
            conn.commit()
            return int(cur.lastrowid)

    def _repair_dangling(self, conn: sqlite3.Connection, node_id: str, now: float) -> None:
        """Close sessions a previous run left open.

        The end time comes from the last data the session actually recorded, so
        a bridge that was killed at 07:00 and restarted at 22:00 does not report
        a fifteen-hour night.
        """
        for row in conn.execute(
            "SELECT id, started_at FROM sessions WHERE node_id = ? AND status = 'active'",
            (node_id,)
        ).fetchall():
            last = conn.execute(
                "SELECT MAX(timestamp) AS t FROM vitals_history WHERE session_id = ?",
                (row["id"],)
            ).fetchone()["t"]
            conn.execute(
                "UPDATE sessions SET status='completed', ended_at=? WHERE id=?",
                (last if last is not None else row["started_at"], row["id"])
            )

    def close_session(self, session_id: int, ended_at: Optional[float] = None) -> None:
        with self._write_lock, self._get_connection() as conn:
            conn.execute(
                "UPDATE sessions SET status='completed', ended_at=? WHERE id=?",
                (ended_at if ended_at is not None else time.time(), session_id)
            )
            conn.commit()

    # ── Writes ──

    def save_live_vitals(self, node_id: str, data: Dict[str, Any]) -> None:
        with self._get_connection() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO live_vitals (node_id, data_json, updated_at) "
                "VALUES (?, ?, ?)",
                (node_id, json.dumps(data), time.time())
            )

    def save_vitals_batch(self, node_id: str, batch_doc: Dict[str, Any],
                          session_id: Optional[int] = None) -> None:
        br = batch_doc.get("breathing_rate") or {}
        hr = batch_doc.get("heart_rate") or {}
        with self._get_connection() as conn:
            conn.execute(
                "INSERT INTO vitals_history (node_id, session_id, timestamp, created_at, "
                "sample_count, br_min, br_max, br_avg, hr_min, hr_max, hr_avg, "
                "conf_avg, apnea_samples, data_json) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (node_id, session_id, batch_doc.get("timestamp", int(time.time())), time.time(),
                 batch_doc.get("sample_count"),
                 br.get("min"), br.get("max"), br.get("avg"),
                 hr.get("min"), hr.get("max"), hr.get("avg"),
                 batch_doc.get("confidence_avg"), batch_doc.get("apnea_sample_count") or 0,
                 json.dumps(batch_doc))
            )

    def save_apnea_event(self, node_id: str, event_doc: Dict[str, Any],
                         session_id: Optional[int] = None) -> None:
        with self._get_connection() as conn:
            conn.execute(
                "INSERT INTO apnea_events (node_id, session_id, start_time, duration, min_br, data_json) "
                "VALUES (?,?,?,?,?,?)",
                (node_id, session_id, event_doc.get("start_time", time.time()),
                 event_doc.get("duration"), event_doc.get("min_br"), json.dumps(event_doc))
            )

    def save_sensing_event(self, node_id: str, event_doc: Dict[str, Any],
                           session_id: Optional[int] = None) -> None:
        ts = event_doc.get("timestamp", event_doc.get("created_at", time.time()))
        with self._get_connection() as conn:
            conn.execute(
                "INSERT INTO sensing_events (node_id, session_id, timestamp, type, data_json) "
                "VALUES (?,?,?,?,?)",
                (node_id, session_id, ts, event_doc.get("type"), json.dumps(event_doc))
            )

    def save_node_metadata(self, node_id: str, meta_doc: Dict[str, Any]) -> None:
        """Merge into the existing row. A plain replace would drop the fields
        written when the session opened (started_at, date, …)."""
        with self._write_lock, self._get_connection() as conn:
            row = conn.execute(
                "SELECT data_json FROM nodes WHERE node_id = ?", (node_id,)
            ).fetchone()
            merged = json.loads(row["data_json"]) if row else {}
            merged.update(meta_doc)
            conn.execute(
                "INSERT OR REPLACE INTO nodes (node_id, data_json, updated_at) VALUES (?, ?, ?)",
                (node_id, json.dumps(merged), time.time())
            )

    # ── Reads ──

    def get_live_vitals(self, node_id: str) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            row = conn.execute(
                "SELECT data_json FROM live_vitals WHERE node_id = ?", (node_id,)
            ).fetchone()
            return json.loads(row["data_json"]) if row else None

    def get_history(self, node_id: str, limit_count: int = 500) -> List[Dict[str, Any]]:
        """Most recent `limit_count` minute batches, returned oldest first."""
        with self._get_connection() as conn:
            rows = conn.execute(
                "SELECT data_json FROM vitals_history WHERE node_id = ? "
                "ORDER BY timestamp DESC LIMIT ?",
                (node_id, limit_count)
            ).fetchall()
            return [json.loads(r["data_json"]) for r in reversed(rows)]

    def get_nodes(self) -> List[Dict[str, Any]]:
        """Registered nodes. `id` is included so the UI can key off it."""
        with self._get_connection() as conn:
            rows = conn.execute(
                "SELECT node_id, data_json FROM nodes ORDER BY node_id ASC"
            ).fetchall()
            return [{"id": r["node_id"], **json.loads(r["data_json"])} for r in rows]

    def get_apnea_events(self, node_id: str, limit_count: int = 50) -> List[Dict[str, Any]]:
        with self._get_connection() as conn:
            rows = conn.execute(
                "SELECT data_json FROM apnea_events WHERE node_id = ? "
                "ORDER BY start_time DESC LIMIT ?",
                (node_id, limit_count)
            ).fetchall()
            return [json.loads(r["data_json"]) for r in rows]

    def get_sensing_events(self, node_id: str, limit_count: int = 50) -> List[Dict[str, Any]]:
        """Discrete events (falls, bursts, idle, drift), newest first.

        The row id is exposed so clients can tell a genuinely new event from
        one they have already seen — two events can share a timestamp.
        """
        with self._get_connection() as conn:
            rows = conn.execute(
                "SELECT id, data_json FROM sensing_events WHERE node_id = ? "
                "ORDER BY timestamp DESC, id DESC LIMIT ?",
                (node_id, limit_count)
            ).fetchall()
            return [{"id": r["id"], **json.loads(r["data_json"])} for r in rows]

    # ── Session rollups ──

    # Computed live rather than cached, so the in-progress session reports
    # correctly and no stored summary can drift from the rows beneath it.
    _ROLLUP_SQL = """
        SELECT
            s.id, s.node_id, s.started_at, s.ended_at, s.status,
            COUNT(v.id)      AS minutes,
            MIN(v.timestamp) AS first_ts,
            MAX(v.timestamp) AS last_ts,
            MIN(v.br_min)    AS br_min,
            MAX(v.br_max)    AS br_max,
            AVG(v.br_avg)    AS br_avg,
            MIN(v.hr_min)    AS hr_min,
            MAX(v.hr_max)    AS hr_max,
            AVG(v.hr_avg)    AS hr_avg,
            AVG(v.conf_avg)  AS conf_avg,
            SUM(v.apnea_samples) AS apnea_samples,
            (SELECT COUNT(*) FROM apnea_events a WHERE a.session_id = s.id) AS apnea_events
        FROM sessions s
        LEFT JOIN vitals_history v ON v.session_id = s.id
    """

    @staticmethod
    def _rollup_row(r: sqlite3.Row) -> Dict[str, Any]:
        rnd = lambda v, n=2: round(v, n) if isinstance(v, (int, float)) else None
        minutes = r["minutes"] or 0
        # Prefer the span of recorded data; fall back to the session clock for
        # a session that has not written its first minute batch yet.
        start = r["first_ts"] if r["first_ts"] is not None else r["started_at"]
        end = r["last_ts"] if r["last_ts"] is not None else r["ended_at"]
        return {
            "id": r["id"],
            "nodeId": r["node_id"],
            "status": r["status"],
            "startedAt": r["started_at"],
            "endedAt": r["ended_at"],
            "startTime": start,
            "endTime": end,
            "minutes": minutes,
            "breathingRate": {"min": rnd(r["br_min"], 1), "max": rnd(r["br_max"], 1), "avg": rnd(r["br_avg"], 1)},
            "heartRate":     {"min": rnd(r["hr_min"], 1), "max": rnd(r["hr_max"], 1), "avg": rnd(r["hr_avg"], 1)},
            "confidenceAvg": rnd(r["conf_avg"], 3),
            "apneaSamples":  r["apnea_samples"] or 0,
            "apneaEvents":   r["apnea_events"] or 0,
        }

    def get_sessions(self, node_id: Optional[str] = None,
                     limit_count: int = 60) -> List[Dict[str, Any]]:
        """Sessions newest first, each with its statistics rolled up in SQL."""
        where = "WHERE s.node_id = ?" if node_id else ""
        params: tuple = (node_id, limit_count) if node_id else (limit_count,)
        with self._get_connection() as conn:
            rows = conn.execute(
                f"{self._ROLLUP_SQL} {where} GROUP BY s.id "
                f"ORDER BY s.started_at DESC LIMIT ?", params
            ).fetchall()
            return [self._rollup_row(r) for r in rows]

    def get_session(self, session_id: int) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            row = conn.execute(
                f"{self._ROLLUP_SQL} WHERE s.id = ? GROUP BY s.id", (session_id,)
            ).fetchone()
            return self._rollup_row(row) if row and row["id"] is not None else None

    def get_session_vitals(self, session_id: int,
                           include_samples: bool = False) -> List[Dict[str, Any]]:
        """One session's minute batches, oldest first.

        Raw per-second samples are excluded unless asked for: they are ~20x the
        payload and nothing in the UI reads them.
        """
        with self._get_connection() as conn:
            rows = conn.execute(
                "SELECT data_json FROM vitals_history WHERE session_id = ? "
                "ORDER BY timestamp ASC", (session_id,)
            ).fetchall()

        out = []
        for r in rows:
            doc = json.loads(r["data_json"])
            if not include_samples:
                doc.pop("samples", None)
            out.append(doc)
        return out
