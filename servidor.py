from contextlib import closing
import argparse
import calendar
from datetime import datetime, timezone, timedelta
import getpass
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import time
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ROOMS = [p * 100 + n for p, count in enumerate((3, 5, 5, 11), 1) for n in range(1, count + 1)]
DB = ROOT / "recepcion.sqlite3"


def attach_history(db):
    db.execute("ATTACH DATABASE ? AS archive", (str(DB.with_name("historial-respaldo.sqlite3")),))


def initialize(db):
    db.executescript("""
        CREATE TABLE IF NOT EXISTS users(name TEXT PRIMARY KEY, salt BLOB, digest BLOB);
        CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, name TEXT, expires REAL);
        CREATE TABLE IF NOT EXISTS stays(id INTEGER PRIMARY KEY, room INTEGER, start INTEGER,
            end INTEGER, hours INTEGER, operator TEXT);
        CREATE INDEX IF NOT EXISTS schedule ON stays(room,start,end);
        CREATE TRIGGER IF NOT EXISTS protect_stay_delete BEFORE DELETE ON stays
        BEGIN SELECT RAISE(ABORT, 'El historial es permanente'); END;
        CREATE TRIGGER IF NOT EXISTS protect_stay_update BEFORE UPDATE ON stays
        BEGIN SELECT RAISE(ABORT, 'El historial es permanente'); END;
        CREATE TABLE IF NOT EXISTS failures(ip TEXT, stamp REAL);
    """)
    attach_history(db)
    with db:
        db.execute("BEGIN IMMEDIATE")
        db.execute("""CREATE TABLE IF NOT EXISTS archive.stays(id INTEGER PRIMARY KEY,
            room INTEGER, start INTEGER, end INTEGER, hours INTEGER, operator TEXT)""")
        if db.execute("""SELECT 1 FROM main.stays s JOIN archive.stays a USING(id)
                WHERE (s.room,s.start,s.end,s.hours,s.operator) IS NOT
                      (a.room,a.start,a.end,a.hours,a.operator) LIMIT 1""").fetchone():
            raise RuntimeError("Conflicto entre el historial y su respaldo. Revisa ambas bases.")
        db.execute("INSERT OR IGNORE INTO archive.stays SELECT * FROM main.stays")
        db.execute("INSERT OR IGNORE INTO main.stays SELECT * FROM archive.stays")
        for schema in ("main", "archive"):
            db.execute(f"""CREATE TABLE IF NOT EXISTS {schema}.withdrawals(
                stay_id INTEGER PRIMARY KEY, withdrawn_at INTEGER NOT NULL,
                withdrawn_by TEXT NOT NULL, reason TEXT NOT NULL)""")
            for action in ("DELETE", "UPDATE"):
                db.execute(f"""CREATE TRIGGER IF NOT EXISTS {schema}.protect_withdrawal_{action}
                    BEFORE {action} ON withdrawals BEGIN
                    SELECT RAISE(ABORT, 'El historial es permanente'); END""")
        db.execute("INSERT OR IGNORE INTO main.withdrawals SELECT * FROM archive.withdrawals")
        db.execute("INSERT OR IGNORE INTO archive.withdrawals SELECT * FROM main.withdrawals")
        for schema in ("main", "archive"):
            db.execute(f"""CREATE TABLE IF NOT EXISTS {schema}.completions(
                stay_id INTEGER PRIMARY KEY, completed_at INTEGER NOT NULL, completed_by TEXT NOT NULL)""")
        db.execute("INSERT OR IGNORE INTO main.completions SELECT * FROM archive.completions")
        db.execute("INSERT OR IGNORE INTO archive.completions SELECT * FROM main.completions")
        for schema in ("main", "archive"):
            db.execute(f"""CREATE TABLE IF NOT EXISTS {schema}.stay_details(
                stay_id INTEGER PRIMARY KEY, details TEXT NOT NULL)""")
        db.execute("INSERT OR IGNORE INTO main.stay_details SELECT * FROM archive.stay_details")
        db.execute("INSERT OR IGNORE INTO archive.stay_details SELECT * FROM main.stay_details")
        for schema in ("main", "archive"):
            db.execute(f"""CREATE TABLE IF NOT EXISTS {schema}.schedule_edits(
                id INTEGER PRIMARY KEY, stay_id INTEGER, start INTEGER, end INTEGER,
                changed_at INTEGER, operator TEXT, reason TEXT)""")
        db.execute("INSERT OR IGNORE INTO main.schedule_edits SELECT * FROM archive.schedule_edits")
        db.execute("INSERT OR IGNORE INTO archive.schedule_edits SELECT * FROM main.schedule_edits")
        db.execute("""CREATE VIEW IF NOT EXISTS effective_stays AS
            SELECT s.id,s.room,COALESCE(e.start,s.start) AS start,COALESCE(e.end,s.end) AS end,
            CASE WHEN e.id IS NULL THEN s.hours ELSE NULL END AS hours,s.operator
            FROM stays s LEFT JOIN schedule_edits e ON e.id=(
                SELECT MAX(id) FROM schedule_edits WHERE stay_id=s.id)""")



def digest(password, salt):
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 400000)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / "web"), **kwargs)

    def result(self, status, obj, cookie=None):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/state":
            self.api({})
        elif self.path.startswith("/api/"):
            self.result(404, {})
        else:
            super().do_GET()

    def do_POST(self):
        try:
            size = int(self.headers.get("Content-Length", 0))
            if not 0 < size <= 4096 or self.headers.get_content_type() != "application/json":
                raise ValueError()
            payload = json.loads(self.rfile.read(size))
            if not isinstance(payload, dict):
                raise ValueError()
            self.api(payload)
        except (ValueError, TypeError, KeyError):
            self.result(400, {"error": "Revisa los datos ingresados."})

    def api(self, data):
        with closing(sqlite3.connect(DB, timeout=10)) as db, db:
            db.row_factory = sqlite3.Row
            now = int(time.time())
            cookie = SimpleCookie()
            cookie.load(self.headers.get("Cookie", ""))
            token = cookie["sid"].value if "sid" in cookie else ""
            key = hashlib.sha256(token.encode()).hexdigest()
            if self.command == "POST" and self.path == "/api/login":
                ip = self.client_address[0]
                db.execute("DELETE FROM failures WHERE stamp<?", (now - 300,))
                user = db.execute("SELECT * FROM users WHERE name=?", (data["name"],)).fetchone()
                attempt = digest(data["password"], user["salt"] if user else bytes(16))
                if not user or not hmac.compare_digest(user["digest"], attempt):
                    if db.execute("SELECT count(*) FROM failures WHERE ip=?", (ip,)).fetchone()[0] >= 12:
                        return self.result(429, {"error": "Espera cinco minutos para volver a intentar."})
                    db.execute("INSERT INTO failures VALUES(?,?)", (ip, now))
                    db.commit()
                    return self.result(401, {"error": "Usuario o contraseña incorrectos."})
                db.execute("DELETE FROM failures WHERE ip=?", (ip,))
                token = secrets.token_urlsafe(32)
                db.execute("DELETE FROM sessions WHERE expires<=?", (now,))
                db.execute("INSERT INTO sessions VALUES(?,?,?)", (hashlib.sha256(token.encode()).hexdigest(), user["name"], now + 43200))
                db.commit()
                flags = "; Secure" if os.getenv("COOKIE_SECURE") == "1" else ""
                return self.result(200, {}, f"sid={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200{flags}")
            user = db.execute("SELECT name FROM sessions WHERE token=? AND expires>?", (key, now)).fetchone()
            if not user:
                return self.result(401, {"error": "Inicia sesión."})
            if self.path == "/api/state" and self.command == "GET":
                records = [dict(row) for row in db.execute("""SELECT s.*, w.withdrawn_at, w.withdrawn_by, w.reason,
                    c.completed_at, c.completed_by, COALESCE(d.details,'') AS details
                    FROM effective_stays s LEFT JOIN withdrawals w ON w.stay_id=s.id
                    LEFT JOIN completions c ON c.stay_id=s.id
                    LEFT JOIN stay_details d ON d.stay_id=s.id ORDER BY start DESC,id DESC""")]
                for record in records:
                    record["edits"] = [dict(row) for row in db.execute(
                        "SELECT * FROM schedule_edits WHERE stay_id=? ORDER BY id", (record["id"],))]
                    original = db.execute("SELECT start,end FROM stays WHERE id=?", (record["id"],)).fetchone()
                    record["original_start"], record["original_end"] = original
                return self.result(200, {"name": user[0], "rooms": ROOMS, "stays": records, "now": now})
            if self.path == "/api/logout" and self.command == "POST":
                db.execute("DELETE FROM sessions WHERE token=?", (key,))
                db.commit()
                return self.result(200, {}, "sid=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict")
            if self.path == "/api/edit-schedule" and self.command == "POST":
                stay_id, start, end = (int(data[k]) for k in ("id", "start", "end"))
                reason = data.get("reason")
                if not isinstance(reason, str) or not 1 <= len(reason.strip()) <= 500 or not -62135578800 <= start < end <= 253402232400:
                    return self.result(400, {"error": "Completa el motivo y una salida posterior a la entrada."})
                attach_history(db)
                db.execute("BEGIN IMMEDIATE")
                stay = db.execute("""SELECT * FROM effective_stays WHERE id=?
                    AND id NOT IN (SELECT stay_id FROM withdrawals)
                    AND id NOT IN (SELECT stay_id FROM completions)""", (stay_id,)).fetchone()
                if not stay:
                    return self.result(409, {"error": "La estancia ya fue cerrada o retirada."})
                if db.execute("""SELECT 1 FROM effective_stays s LEFT JOIN withdrawals w ON w.stay_id=s.id
                    WHERE s.room=? AND s.id<>? AND s.start<? AND COALESCE(w.withdrawn_at,s.end)>?""",
                    (stay["room"], stay_id, end, start)).fetchone():
                    return self.result(409, {"error": "El horario se cruza con otra estancia de esta habitación."})
                edit = db.execute("INSERT INTO schedule_edits(stay_id,start,end,changed_at,operator,reason) VALUES(?,?,?,?,?,?)",
                    (stay_id,start,end,int(time.time()),user[0],reason.strip()))
                db.execute("INSERT INTO archive.schedule_edits SELECT * FROM main.schedule_edits WHERE id=?", (edit.lastrowid,))
                db.commit()
                return self.result(200, {})
            if self.path == "/api/complete" and self.command == "POST":
                stay_id = int(data["id"])
                attach_history(db)
                db.execute("BEGIN IMMEDIATE")
                if not db.execute("""SELECT 1 FROM effective_stays WHERE id=? AND end<=?
                    AND id NOT IN (SELECT stay_id FROM main.withdrawals)""", (stay_id, int(time.time()))).fetchone():
                    return self.result(409, {"error": "La estancia todavía no ha culminado o fue retirada."})
                db.execute("INSERT OR IGNORE INTO main.completions VALUES(?,?,?)", (stay_id, int(time.time()), user[0]))
                db.execute("INSERT OR IGNORE INTO archive.completions SELECT * FROM main.completions WHERE stay_id=?", (stay_id,))
                db.commit()
                return self.result(200, {})
            if self.path == "/api/withdraw" and self.command == "POST":
                reason = data.get("reason")
                if not isinstance(reason, str) or not 1 <= len(reason.strip()) <= 500:
                    return self.result(400, {"error": "Escribe un motivo de hasta 500 caracteres."})
                stay_id = int(data["id"])
                attach_history(db)
                db.execute("BEGIN IMMEDIATE")
                now = int(time.time())
                if not db.execute("""SELECT 1 FROM effective_stays WHERE id=? AND start<=? AND end>?
                        AND id NOT IN (SELECT stay_id FROM main.withdrawals)""", (stay_id, now, now)).fetchone():
                    return self.result(409, {"error": "Esta estancia ya no está activa."})
                db.execute("INSERT INTO main.withdrawals VALUES(?,?,?,?)", (stay_id, now, user[0], reason.strip()))
                db.execute("INSERT INTO archive.withdrawals SELECT * FROM main.withdrawals WHERE stay_id=?", (stay_id,))
                db.commit()
                return self.result(201, {})
            if self.path == "/api/stays" and self.command == "POST":
                room, start = int(data["room"]), int(data["start"])
                hours = data.get("hours")
                duration = data.get("duration")
                details = data.get("details", "")
                if not isinstance(details, str) or len(details) > 2000:
                    return self.result(400, {"error": "Los detalles admiten hasta 2000 caracteres."})
                if duration == "month":
                    entry = datetime.fromtimestamp(start, timezone(timedelta(hours=-5)))
                    year, month = (entry.year+1, 1) if entry.month == 12 else (entry.year, entry.month+1)
                    end = int(entry.replace(year=year, month=month, day=min(entry.day, calendar.monthrange(year, month)[1])).timestamp())
                    hours = (end-start)//3600
                elif duration == "days":
                    days = data.get("days")
                    if type(days) is not int or days < 1 or days > 36500:
                        raise ValueError()
                    hours = days * 24
                    end = start + hours * 3600
                elif "end" in data and hours is None:
                    end = int(data["end"])
                elif "end" not in data and hours in (3, 12, 168, 720):
                    end = start + hours * 3600
                else:
                    raise ValueError()
                if room not in ROOMS or not -8640000000000 <= start < end <= 8640000000000:
                    raise ValueError()
                attach_history(db)
                db.execute("BEGIN IMMEDIATE")
                if end < int(time.time()) + 60:
                    return self.result(400, {"error": "La salida debe ser al menos un minuto posterior a la hora actual."})
                if db.execute("""SELECT 1 FROM effective_stays s LEFT JOIN main.withdrawals w ON w.stay_id=s.id
                        WHERE room=? AND start<? AND COALESCE(w.withdrawn_at,s.end)>?""", (room, end, start)).fetchone():
                    return self.result(409, {"error": "La habitación ya tiene una estancia en ese horario."})
                stay = db.execute("INSERT INTO main.stays(room,start,end,hours,operator) VALUES(?,?,?,?,?)", (room, start, end, hours, user[0]))
                db.execute("INSERT INTO archive.stays SELECT * FROM main.stays WHERE id=?", (stay.lastrowid,))
                db.execute("INSERT INTO main.stay_details VALUES(?,?)", (stay.lastrowid, details.strip()))
                db.execute("INSERT INTO archive.stay_details SELECT * FROM main.stay_details WHERE stay_id=?", (stay.lastrowid,))
                db.commit()
                return self.result(201, {})
            self.result(404, {})


def read_password(prompt, window):
    if not window:
        return getpass.getpass(prompt)
    import tkinter as tk
    from tkinter import simpledialog

    root = tk.Tk()
    root.withdraw()
    try:
        value = simpledialog.askstring("Golden Gate · Recepción", prompt, parent=root, show="*")
        if value is None:
            raise SystemExit("Operación cancelada.")
        return value
    finally:
        root.destroy()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    accounts = parser.add_mutually_exclusive_group()
    accounts.add_argument("--usuario")
    accounts.add_argument("--cambiar-clave")
    accounts.add_argument("--configurar-pin")
    parser.add_argument("--ventana", action="store_true", help="Introducir la contraseña en una ventana de Windows")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()
    with sqlite3.connect(DB) as connection:
        initialize(connection)
        if args.usuario or args.cambiar_clave or args.configurar_pin:
            name = (args.usuario or args.cambiar_clave or args.configurar_pin).strip()
            exists = connection.execute("SELECT 1 FROM users WHERE name=?", (name,)).fetchone()
            if (args.cambiar_clave or args.configurar_pin) and not exists:
                parser.error("El usuario indicado no existe.")
            if args.usuario and exists:
                parser.error("El usuario ya existe. Usa --cambiar-clave para actualizar su contraseña.")
            if not args.ventana:
                print("Escribe tu clave y pulsa Enter. Las letras y los asteriscos quedan ocultos.")
            password = read_password("Nuevo PIN de 6 números: " if args.configurar_pin else "Nueva contraseña (mínimo 10 caracteres): ", args.ventana)
            if args.configurar_pin and (len(password) != 6 or not password.isascii() or not password.isdigit()):
                parser.error("El PIN debe contener exactamente 6 números del 0 al 9.")
            if not args.configurar_pin and len(password) < 10:
                parser.error("Usa al menos 10 caracteres.")
            if password != read_password("Repite la contraseña y pulsa Enter: ", args.ventana):
                parser.error("Las contraseñas deben coincidir. Vuelve a ejecutar el comando.")
            salt = secrets.token_bytes(16)
            if args.cambiar_clave or args.configurar_pin:
                connection.execute("UPDATE users SET salt=?, digest=? WHERE name=?", (salt, digest(password, salt), name))
                connection.execute("DELETE FROM sessions WHERE name=?", (name,))
                print("PIN actualizado." if args.configurar_pin else "Contraseña actualizada.")
            else:
                connection.execute("INSERT INTO users VALUES(?,?,?)", (name, salt, digest(password, salt)))
                print("Usuario creado.")
    if not (args.usuario or args.cambiar_clave or args.configurar_pin):
        print(f"Recepción en http://{args.host}:{args.port}", flush=True)
        ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


