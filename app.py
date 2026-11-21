import hashlib
import hmac
import ipaddress
import os
import secrets
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from dotenv import load_dotenv
from flask import Flask, g, jsonify, request, send_from_directory, session
from itsdangerous import BadSignature, URLSafeSerializer
import psycopg
from psycopg.rows import dict_row
from vercel.blob import sync as blob
from vercel.blob.errors import BlobError
from werkzeug.exceptions import RequestEntityTooLarge
from werkzeug.utils import secure_filename

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 5 * 1024 * 1024
app.config["SECRET_KEY"] = os.environ.get("FLASK_SECRET_KEY")
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"

IMAGE_DIR = BASE_DIR / "images"
LIKE_ICON_DIR = BASE_DIR / "Icons"
USE_BLOB_STORAGE = os.environ.get("VERCEL") == "1"
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD")
DATABASE_URL = os.environ.get("DATABASE_URL")
MAX_REPORT_LENGTH = 5000
MAX_REPORTS_PER_HOUR = 5
MAX_COMMENT_NAME_LENGTH = 32
MAX_COMMENT_LENGTH = 150
MAX_IMAGE_NAME_LENGTH = 100
LIKE_VOTER_COOKIE = "cwel_like_voter"
LIKE_VOTER_COOKIE_MAX_AGE = 60 * 60 * 24 * 365
app.config["SESSION_COOKIE_SECURE"] = USE_BLOB_STORAGE
if not USE_BLOB_STORAGE:
    IMAGE_DIR.mkdir(exist_ok=True)

IMAGE_FORMATS = {
    b"\x89PNG\r\n\x1a\n": ("png", "image/png"),
    b"\xff\xd8\xff": ("jpg", "image/jpeg"),
    b"GIF87a": ("gif", "image/gif"),
    b"GIF89a": ("gif", "image/gif"),
}
IMAGE_EXTENSIONS = {".png", ".jpg", ".gif", ".webp"}


def get_display_filename(storage_filename):
    return storage_filename.split("__", 1)[-1]


@app.get("/")
@app.get("/index.html")
def index():
    return send_from_directory(BASE_DIR, "index.html")


@app.get("/terms.html")
def terms():
    return send_from_directory(BASE_DIR, "terms.html")


@app.get("/admin")
def admin():
    return send_from_directory(BASE_DIR, "admin.html")


@app.get("/style.css")
def stylesheet():
    return send_from_directory(BASE_DIR, "style.css")


@app.get("/script.js")
def script():
    return send_from_directory(BASE_DIR, "script.js")


@app.get("/admin.js")
def admin_script():
    return send_from_directory(BASE_DIR, "admin.js")


@app.get("/Icons/<path:filename>")
def like_icon(filename):
    return send_from_directory(LIKE_ICON_DIR, filename)


@app.get("/images/<path:filename>")
def uploaded_image(filename):
    return send_from_directory(IMAGE_DIR, filename)


def _get_time_value(value):
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, datetime):
        return value.timestamp()
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            try:
                return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
            except ValueError:
                return 0.0
    return 0.0


def _get_uploaded_at_value(item):
    for attr_name in (
        "uploaded_at",
        "created_at",
        "created",
        "last_modified",
        "updated_at",
        "uploadedAt",
        "createdAt",
    ):
        value = getattr(item, attr_name, None)
        if value is not None:
            return value
    return 0


def _list_image_entries():
    if USE_BLOB_STORAGE:
        entries = [
            {
                "filename": get_display_filename(item.pathname.removeprefix("images/")),
                "url": item.url,
                "uploaded_at": _get_uploaded_at_value(item),
                "storage_id": item.pathname.removeprefix("images/"),
            }
            for item in blob.query_blobs(prefix="images/")
            if Path(item.pathname).suffix.lower() in IMAGE_EXTENSIONS
        ]
    else:
        entries = [
            {
                "filename": get_display_filename(path.name),
                "url": f"/images/{path.name}",
                "uploaded_at": path.stat().st_mtime,
                "storage_id": path.name,
            }
            for path in IMAGE_DIR.iterdir()
            if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS
        ]

    entries.sort(
        key=lambda item: _get_time_value(item.get("uploaded_at")),
        reverse=True,
    )
    custom_names = _load_image_names()
    for entry in entries:
        custom_name = custom_names.get(entry["storage_id"], "").strip()
        if custom_name:
            entry["filename"] = custom_name
    return entries


def _admin_is_configured():
    return bool(ADMIN_PASSWORD and app.config["SECRET_KEY"])


def _admin_is_authenticated():
    return session.get("admin_authenticated") is True


def _admin_auth_error():
    if not _admin_is_configured():
        return jsonify(error="Admin access is not configured."), 503
    return jsonify(error="Admin login required."), 401


def _admin_request_is_valid():
    return hmac.compare_digest(
        request.headers.get("X-CSRF-Token", "").encode("utf-8"),
        session.get("csrf_token", "").encode("utf-8"),
    )


def _ensure_reports_table(connection):
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS cwel_image_names (
            storage_id TEXT PRIMARY KEY,
            display_name TEXT NOT NULL CHECK (char_length(display_name) <= 100),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS cwel_reports (
            id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            image_id TEXT NOT NULL,
            image_filename TEXT NOT NULL,
            image_url TEXT NOT NULL,
            reason TEXT NOT NULL CHECK (char_length(reason) <= 5000),
            status TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'reviewed')),
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS cwel_reports_created_at_idx "
        "ON cwel_reports (created_at DESC)"
    )
    connection.execute(
        "ALTER TABLE cwel_reports ADD COLUMN IF NOT EXISTS "
        "report_type TEXT NOT NULL DEFAULT 'image'"
    )
    connection.execute(
        "ALTER TABLE cwel_reports ADD COLUMN IF NOT EXISTS comment_id BIGINT"
    )
    connection.execute(
        "ALTER TABLE cwel_reports ADD COLUMN IF NOT EXISTS comment_author TEXT"
    )
    connection.execute(
        "ALTER TABLE cwel_reports ADD COLUMN IF NOT EXISTS comment_content TEXT"
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS cwel_report_rate_limits (
            ip_hash TEXT PRIMARY KEY,
            window_started_at TIMESTAMPTZ NOT NULL,
            report_count INTEGER NOT NULL
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS cwel_comments (
            id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            image_id TEXT NOT NULL,
            image_filename TEXT NOT NULL,
            image_url TEXT NOT NULL,
            author TEXT NOT NULL CHECK (char_length(author) <= 32),
            content TEXT NOT NULL CHECK (char_length(content) <= 150),
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS cwel_comments_image_created_idx "
        "ON cwel_comments (image_id, created_at, id)"
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS cwel_likes (
            target_type TEXT NOT NULL CHECK (target_type IN ('image', 'comment')),
            target_id TEXT NOT NULL,
            voter_hash TEXT NOT NULL,
            PRIMARY KEY (target_type, target_id, voter_hash)
        )
        """
    )
    connection.execute(
        """
        DO $$
        BEGIN
            ALTER TABLE cwel_likes RENAME COLUMN ip_hash TO voter_hash;
        EXCEPTION WHEN undefined_column THEN
            IF NOT EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = current_schema()
                  AND table_name = 'cwel_likes'
                  AND column_name = 'voter_hash'
            ) THEN
                RAISE;
            END IF;
        END;
        $$
        """
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS cwel_likes_target_idx "
        "ON cwel_likes (target_type, target_id)"
    )


def _save_image_name(storage_id, display_name):
    if not DATABASE_URL:
        return
    with psycopg.connect(
        DATABASE_URL,
        connect_timeout=5,
    ) as connection:
        _ensure_reports_table(connection)
        connection.execute(
            """
            INSERT INTO cwel_image_names (storage_id, display_name)
            VALUES (%s, %s)
            ON CONFLICT (storage_id)
            DO UPDATE SET display_name = EXCLUDED.display_name,
                          updated_at = CURRENT_TIMESTAMP
            """,
            (storage_id, display_name),
        )


def _delete_image_name(storage_id):
    if not DATABASE_URL:
        return
    with psycopg.connect(
        DATABASE_URL,
        connect_timeout=5,
    ) as connection:
        _ensure_reports_table(connection)
        connection.execute(
            "DELETE FROM cwel_image_names WHERE storage_id = %s",
            (storage_id,),
        )


def _load_image_names():
    if not DATABASE_URL:
        return {}
    try:
        with psycopg.connect(
            DATABASE_URL,
            connect_timeout=5,
            row_factory=dict_row,
        ) as connection:
            _ensure_reports_table(connection)
            rows = connection.execute(
                "SELECT storage_id, display_name FROM cwel_image_names"
            ).fetchall()
        return {
            row["storage_id"]: row["display_name"]
            for row in rows
        }
    except psycopg.Error:
        app.logger.exception("Failed to load custom image names")
        return {}


def _report_to_dict(report):
    return {
        **report,
        "created_at": report["created_at"].isoformat(),
    }


def _insert_report(image, reason):
    with psycopg.connect(
        DATABASE_URL,
        connect_timeout=5,
        row_factory=dict_row,
    ) as connection:
        _ensure_reports_table(connection)
        report = connection.execute(
            """
            INSERT INTO cwel_reports (image_id, image_filename, image_url, reason)
            VALUES (%s, %s, %s, %s)
            RETURNING id, image_id, image_filename, image_url, reason,
                      status, created_at
            """,
            (image["storage_id"], image["filename"], image["url"], reason),
        ).fetchone()
    return _report_to_dict(report)


def _list_reports():
    with psycopg.connect(
        DATABASE_URL,
        connect_timeout=5,
        row_factory=dict_row,
    ) as connection:
        _ensure_reports_table(connection)
        reports = connection.execute(
            """
            SELECT reports.id, reports.image_id, reports.image_filename,
                   reports.image_url, reports.reason, reports.status,
                   reports.report_type, reports.comment_id,
                   reports.comment_author, reports.comment_content,
                   reports.created_at,
                   (comments.id IS NOT NULL) AS comment_exists
            FROM cwel_reports AS reports
            LEFT JOIN cwel_comments AS comments
                ON comments.id = reports.comment_id
            ORDER BY reports.created_at DESC
            """
        ).fetchall()
    return [_report_to_dict(report) for report in reports]


def _insert_comment(image, author, content):
    with psycopg.connect(
        DATABASE_URL,
        connect_timeout=5,
        row_factory=dict_row,
    ) as connection:
        _ensure_reports_table(connection)
        comment = connection.execute(
            """
            INSERT INTO cwel_comments (
                image_id, image_filename, image_url, author, content
            )
            VALUES (%s, %s, %s, %s, %s)
            RETURNING id, image_id, author, content, created_at
            """,
            (
                image["storage_id"],
                image["filename"],
                image["url"],
                author,
                content,
            ),
        ).fetchone()
    return _report_to_dict(comment)


def _list_comments(image_id):
    with psycopg.connect(
        DATABASE_URL,
        connect_timeout=5,
        row_factory=dict_row,
    ) as connection:
        _ensure_reports_table(connection)
        comments = connection.execute(
            """
            SELECT id, image_id, author, content, created_at
            FROM cwel_comments
            WHERE image_id = %s
            ORDER BY created_at, id
            """,
            (image_id,),
        ).fetchall()
    return [_report_to_dict(comment) for comment in comments]


def _insert_comment_report(comment_id, reason):
    with psycopg.connect(
        DATABASE_URL,
        connect_timeout=5,
        row_factory=dict_row,
    ) as connection:
        _ensure_reports_table(connection)
        comment = connection.execute(
            """
            SELECT id, image_id, image_filename, image_url, author, content
            FROM cwel_comments
            WHERE id = %s
            """,
            (comment_id,),
        ).fetchone()
        if comment is None:
            return False
        connection.execute(
            """
            INSERT INTO cwel_reports (
                image_id, image_filename, image_url, reason, report_type,
                comment_id, comment_author, comment_content
            )
            VALUES (%s, %s, %s, %s, 'comment', %s, %s, %s)
            """,
            (
                comment["image_id"],
                comment["image_filename"],
                comment["image_url"],
                reason,
                comment["id"],
                comment["author"],
                comment["content"],
            ),
        )
    return True


def _delete_comment(comment_id):
    with psycopg.connect(DATABASE_URL, connect_timeout=5) as connection:
        _ensure_reports_table(connection)
        connection.execute(
            "SELECT id FROM cwel_comments WHERE id = %s FOR UPDATE",
            (comment_id,),
        )
        connection.execute(
            "DELETE FROM cwel_likes WHERE target_type = 'comment' AND target_id = %s",
            (str(comment_id),),
        )
        cursor = connection.execute(
            "DELETE FROM cwel_comments WHERE id = %s",
            (comment_id,),
        )
        return cursor.rowcount > 0


def _update_report_fields(report_id, **fields):
    allowed_fields = {"status"}
    if not fields or not fields.keys() <= allowed_fields:
        raise ValueError("Invalid report fields.")

    assignments = ", ".join(f"{field} = %s" for field in fields)
    values = tuple(fields.values()) + (report_id,)
    with psycopg.connect(DATABASE_URL, connect_timeout=5) as connection:
        _ensure_reports_table(connection)
        cursor = connection.execute(
            f"UPDATE cwel_reports SET {assignments} WHERE id = %s",
            values,
        )
        return cursor.rowcount > 0


def _delete_report(report_id):
    with psycopg.connect(DATABASE_URL, connect_timeout=5) as connection:
        _ensure_reports_table(connection)
        cursor = connection.execute(
            "DELETE FROM cwel_reports WHERE id = %s",
            (report_id,),
        )
        return cursor.rowcount > 0


def _report_client_ip():
    client_ip = (
        request.headers.get("x-forwarded-for")
        if USE_BLOB_STORAGE
        else request.remote_addr
    )
    try:
        return str(ipaddress.ip_address(client_ip))
    except (TypeError, ValueError):
        return None


@app.before_request
def load_like_voter_cookie():
    secret_key = app.config["SECRET_KEY"]
    g.like_voter_cookie = None
    g.like_voter_id = None
    if not secret_key:
        return

    serializer = URLSafeSerializer(secret_key, salt="cwel-like-voter")
    signed_voter_id = request.cookies.get(LIKE_VOTER_COOKIE)
    if signed_voter_id:
        try:
            voter_id = serializer.loads(signed_voter_id)
        except BadSignature:
            voter_id = None
        if isinstance(voter_id, str) and len(voter_id) == 43:
            g.like_voter_id = voter_id
            return

    voter_id = secrets.token_urlsafe(32)
    g.like_voter_id = voter_id
    g.like_voter_cookie = serializer.dumps(voter_id)


@app.after_request
def persist_like_voter_cookie(response):
    signed_voter_id = getattr(g, "like_voter_cookie", None)
    if signed_voter_id:
        response.set_cookie(
            LIKE_VOTER_COOKIE,
            signed_voter_id,
            max_age=LIKE_VOTER_COOKIE_MAX_AGE,
            secure=USE_BLOB_STORAGE,
            httponly=True,
            samesite="Lax",
            path="/",
        )
    return response


def _like_voter_hash():
    secret_key = app.config["SECRET_KEY"]
    voter_id = getattr(g, "like_voter_id", None)
    if not secret_key or not voter_id:
        raise ValueError("FLASK_SECRET_KEY is required to store likes.")
    return hmac.new(
        secret_key.encode("utf-8"),
        b"likes:browser:" + voter_id.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def _list_like_states(image_ids, voter_hash):
    with psycopg.connect(
        DATABASE_URL,
        connect_timeout=5,
        row_factory=dict_row,
    ) as connection:
        _ensure_reports_table(connection)
        states = connection.execute(
            """
            SELECT likes.target_type, likes.target_id, COUNT(*) AS count,
                   BOOL_OR(likes.voter_hash = %s) AS liked
            FROM cwel_likes AS likes
            WHERE (
                likes.target_type = 'image'
                AND likes.target_id = ANY(%s)
            ) OR (
                likes.target_type = 'comment'
                AND likes.target_id IN (
                    SELECT comments.id::text
                    FROM cwel_comments AS comments
                    WHERE comments.image_id = ANY(%s)
                )
            )
            GROUP BY likes.target_type, likes.target_id
            """,
            (voter_hash, image_ids, image_ids),
        ).fetchall()
    return states


def _change_like(target_type, target_id, voter_hash, liked):
    with psycopg.connect(
        DATABASE_URL,
        connect_timeout=5,
        row_factory=dict_row,
    ) as connection:
        _ensure_reports_table(connection)
        if target_type == "comment":
            comment = connection.execute(
                "SELECT id FROM cwel_comments WHERE id = %s FOR UPDATE",
                (target_id,),
            ).fetchone()
            if comment is None:
                return None

        if liked:
            connection.execute(
                """
                INSERT INTO cwel_likes (target_type, target_id, voter_hash)
                VALUES (%s, %s, %s)
                ON CONFLICT (target_type, target_id, voter_hash) DO NOTHING
                """,
                (target_type, target_id, voter_hash),
            )
        else:
            connection.execute(
                """
                DELETE FROM cwel_likes
                WHERE target_type = %s AND target_id = %s AND voter_hash = %s
                """,
                (target_type, target_id, voter_hash),
            )
        count = connection.execute(
            """
            SELECT COUNT(*) AS count
            FROM cwel_likes
            WHERE target_type = %s AND target_id = %s
            """,
            (target_type, target_id),
        ).fetchone()["count"]
    return count


def _consume_report_rate_limit(client_ip):
    secret_key = app.config["SECRET_KEY"]
    if not secret_key:
        raise ValueError("FLASK_SECRET_KEY is required for report rate limiting.")
    ip_hash = hmac.new(
        secret_key.encode("utf-8"),
        client_ip.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()

    with psycopg.connect(DATABASE_URL, connect_timeout=5) as connection:
        _ensure_reports_table(connection)
        connection.execute(
            "DELETE FROM cwel_report_rate_limits "
            "WHERE window_started_at < CURRENT_TIMESTAMP - INTERVAL '24 hours'"
        )
        report_count = connection.execute(
            """
            INSERT INTO cwel_report_rate_limits
                (ip_hash, window_started_at, report_count)
            VALUES (%s, CURRENT_TIMESTAMP, 1)
            ON CONFLICT (ip_hash) DO UPDATE SET
                window_started_at = CASE
                    WHEN cwel_report_rate_limits.window_started_at
                        <= CURRENT_TIMESTAMP - INTERVAL '1 hour'
                    THEN CURRENT_TIMESTAMP
                    ELSE cwel_report_rate_limits.window_started_at
                END,
                report_count = CASE
                    WHEN cwel_report_rate_limits.window_started_at
                        <= CURRENT_TIMESTAMP - INTERVAL '1 hour'
                    THEN 1
                    ELSE cwel_report_rate_limits.report_count + 1
                END
            RETURNING report_count
            """,
            (ip_hash,),
        ).fetchone()[0]
    return report_count <= MAX_REPORTS_PER_HOUR


@app.get("/images")
def list_uploaded_images():
    try:
        entries = _list_image_entries()
    except BlobError:
        app.logger.exception("Failed to list images from Vercel Blob")
        return jsonify(error="Image storage is unavailable. Check the Vercel Blob store configuration."), 503
    return jsonify(images=entries)


@app.post("/likes/state")
def list_likes():
    if not DATABASE_URL:
        return jsonify(error="Likes are not configured. Please try again later."), 503

    like_data = request.get_json(silent=True)
    image_ids = like_data.get("image_ids") if isinstance(like_data, dict) else None
    if (
        not isinstance(image_ids, list)
        or not image_ids
        or len(image_ids) > 5000
        or any(
            not isinstance(image_id, str) or not image_id or len(image_id) > 512
            for image_id in image_ids
        )
    ):
        return jsonify(error="Choose one or more valid images to load likes."), 400

    try:
        voter_hash = _like_voter_hash()
        likes = _list_like_states(image_ids, voter_hash)
    except (psycopg.Error, ValueError):
        app.logger.exception("Failed to load like counts")
        return jsonify(error="Likes are temporarily unavailable."), 503
    return jsonify(likes=likes)


@app.route("/likes", methods=["POST", "DELETE"])
def change_like():
    if not DATABASE_URL:
        return jsonify(error="Likes are not configured. Please try again later."), 503

    like_data = request.get_json(silent=True)
    if not isinstance(like_data, dict):
        return jsonify(error="Submit a valid like action."), 400
    target_type = like_data.get("target_type")
    target_id = like_data.get("target_id")
    if (
        not isinstance(target_type, str)
        or target_type not in {"image", "comment"}
        or not isinstance(target_id, str)
    ):
        return jsonify(error="Choose a valid image or comment to like."), 400

    if target_type == "image":
        if not target_id or len(target_id) > 512:
            return jsonify(error="Choose a valid image to like."), 400
        try:
            image_exists = any(
                image["storage_id"] == target_id
                for image in _list_image_entries()
            )
        except BlobError:
            app.logger.exception("Failed to verify image for like")
            return jsonify(error="Image storage is unavailable. Please try again later."), 503
        if not image_exists:
            return jsonify(error="That image could not be found."), 404
    elif (
        not target_id.isascii()
        or not target_id.isdigit()
        or len(target_id) > 19
    ):
        return jsonify(error="Choose a valid comment to like."), 400
    else:
        comment_id = int(target_id)
        if comment_id < 1 or comment_id > 9223372036854775807:
            return jsonify(error="Choose a valid comment to like."), 400
        target_id = str(comment_id)

    try:
        voter_hash = _like_voter_hash()
        liked = request.method == "POST"
        count = _change_like(target_type, target_id, voter_hash, liked)
    except (psycopg.Error, ValueError):
        app.logger.exception("Failed to update a like")
        return jsonify(error="The like could not be updated. Please try again later."), 503
    if count is None:
        return jsonify(error="That comment could not be found."), 404
    return jsonify(
        target_type=target_type,
        target_id=target_id,
        count=count,
        liked=liked,
    )


@app.get("/comments")
def list_image_comments():
    if not DATABASE_URL:
        return jsonify(error="Comments are not configured. Please try again later."), 503
    image_id = request.args.get("image_id", "")
    if not image_id:
        return jsonify(error="Choose an image to load comments."), 400

    try:
        comments = _list_comments(image_id)
    except psycopg.Error:
        app.logger.exception("Failed to load comments for image '%s'", image_id)
        return jsonify(error="Comments are temporarily unavailable."), 503
    return jsonify(comments=comments)


@app.post("/comments")
def submit_image_comment():
    if not DATABASE_URL:
        return jsonify(error="Comments are not configured. Please try again later."), 503
    comment_data = request.get_json(silent=True)
    if not isinstance(comment_data, dict):
        return jsonify(error="Submit a valid comment."), 400

    image_id = comment_data.get("image_id")
    author = comment_data.get("author")
    content = comment_data.get("content")
    if not all(isinstance(value, str) for value in (image_id, author, content)):
        return jsonify(error="Enter your name and comment."), 400
    author = author.strip()
    content = content.strip()
    if not author or not content:
        return jsonify(error="Enter your name and comment."), 400
    if len(author) > MAX_COMMENT_NAME_LENGTH:
        return jsonify(
            error=f"Names must be {MAX_COMMENT_NAME_LENGTH} characters or fewer."
        ), 400
    if len(content) > MAX_COMMENT_LENGTH:
        return jsonify(
            error=f"Comments must be {MAX_COMMENT_LENGTH} characters or fewer."
        ), 400

    try:
        image = next(
            (entry for entry in _list_image_entries() if entry["storage_id"] == image_id),
            None,
        )
    except BlobError:
        app.logger.exception("Failed to verify image for comment")
        return jsonify(error="Image storage is unavailable. Please try again later."), 503
    if image is None:
        return jsonify(error="That image could not be found."), 404

    try:
        comment = _insert_comment(image, author, content)
    except psycopg.Error:
        app.logger.exception("Failed to save comment for image '%s'", image_id)
        return jsonify(error="The comment could not be saved. Please try again later."), 503
    return jsonify(comment=comment), 201


@app.post("/comments/<int:comment_id>/report")
def report_image_comment(comment_id):
    if not DATABASE_URL:
        return jsonify(error="Comment reporting is not configured."), 503
    report_data = request.get_json(silent=True)
    reason = report_data.get("reason") if isinstance(report_data, dict) else None
    if not isinstance(reason, str) or not reason.strip():
        return jsonify(error="Enter a reason for reporting this comment."), 400
    reason = reason.strip()
    if len(reason) > MAX_REPORT_LENGTH:
        return jsonify(
            error=f"Report reasons must be {MAX_REPORT_LENGTH} characters or fewer."
        ), 400

    client_ip = _report_client_ip()
    if client_ip is None:
        return jsonify(error="The report could not be verified. Please try again later."), 503
    try:
        allowed = _consume_report_rate_limit(client_ip)
    except (psycopg.Error, ValueError):
        app.logger.exception("Failed to apply comment-report rate limit")
        return jsonify(error="Reporting is temporarily unavailable."), 503
    if not allowed:
        return jsonify(error=f"You can submit up to {MAX_REPORTS_PER_HOUR} reports per hour."), 429

    try:
        inserted = _insert_comment_report(comment_id, reason)
    except psycopg.Error:
        app.logger.exception("Failed to save report for comment %d", comment_id)
        return jsonify(error="The report could not be saved. Please try again later."), 503
    if not inserted:
        return jsonify(error="That comment could not be found."), 404
    return jsonify(success=True), 201


@app.post("/admin/login")
def admin_login():
    if not _admin_is_configured():
        return _admin_auth_error()

    credentials = request.get_json(silent=True)
    if not isinstance(credentials, dict) or not isinstance(credentials.get("password"), str):
        return jsonify(error="Enter the admin password."), 400
    if not hmac.compare_digest(
        credentials["password"].encode("utf-8"),
        ADMIN_PASSWORD.encode("utf-8"),
    ):
        return jsonify(error="Incorrect password."), 401

    session.clear()
    session["admin_authenticated"] = True
    session["csrf_token"] = secrets.token_urlsafe(32)
    return jsonify(csrf_token=session["csrf_token"])


@app.post("/admin/logout")
def admin_logout():
    if not _admin_is_authenticated():
        return _admin_auth_error()
    if not _admin_request_is_valid():
        return jsonify(error="Invalid request token."), 403

    session.clear()
    return jsonify(success=True)


@app.get("/admin/images")
def admin_list_images():
    if not _admin_is_authenticated():
        return _admin_auth_error()

    try:
        entries = _list_image_entries()
    except BlobError:
        app.logger.exception("Failed to list images for admin")
        return jsonify(error="Image storage is unavailable. Check the Vercel Blob store configuration."), 503
    return jsonify(
        images=entries,
        csrf_token=session.get("csrf_token", ""),
    )


@app.delete("/admin/images/<path:storage_id>")
def admin_delete_image(storage_id):
    if not _admin_is_authenticated():
        return _admin_auth_error()
    if not _admin_request_is_valid():
        return jsonify(error="Invalid request token."), 403
    if (
        Path(storage_id).name != storage_id
        or Path(storage_id).suffix.lower() not in IMAGE_EXTENSIONS
    ):
        return jsonify(error="Invalid image identifier."), 400

    if USE_BLOB_STORAGE:
        try:
            blob.delete_blob(f"images/{storage_id}")
        except BlobError:
            app.logger.exception("Failed to delete image from Vercel Blob")
            return jsonify(error="Image storage is unavailable. Check the Vercel Blob store configuration."), 503
    else:
        image_path = IMAGE_DIR / storage_id
        if not image_path.is_file():
            return jsonify(error="Image not found."), 404
        try:
            image_path.unlink()
        except OSError:
            app.logger.exception("Failed to delete local image '%s'", storage_id)
            return jsonify(error="The image could not be deleted."), 500

    try:
        _delete_image_name(storage_id)
    except psycopg.Error:
        app.logger.exception("Failed to delete custom name for image '%s'", storage_id)

    return jsonify(success=True)


@app.post("/report")
def submit_image_report():
    if not DATABASE_URL:
        return jsonify(error="Reporting is not configured. Please try again later."), 503

    report_data = request.get_json(silent=True)
    if not isinstance(report_data, dict):
        return jsonify(error="Submit a valid report."), 400

    image_id = report_data.get("image_id")
    reason = report_data.get("reason")
    if not isinstance(image_id, str) or not isinstance(reason, str):
        return jsonify(error="Choose an image and enter a reason."), 400
    reason = reason.strip()
    if not reason:
        return jsonify(error="Enter a reason for the report."), 400
    if len(reason) > MAX_REPORT_LENGTH:
        return jsonify(error=f"Report reasons must be {MAX_REPORT_LENGTH} characters or fewer."), 400

    try:
        image = next(
            (entry for entry in _list_image_entries() if entry["storage_id"] == image_id),
            None,
        )
    except BlobError:
        app.logger.exception("Failed to verify reported image in Vercel Blob")
        return jsonify(error="Image storage is unavailable. Please try again later."), 503
    if image is None:
        return jsonify(error="That image could not be found."), 404

    client_ip = _report_client_ip()
    if client_ip is None:
        return jsonify(error="The report could not be verified. Please try again later."), 503
    try:
        allowed = _consume_report_rate_limit(client_ip)
    except (psycopg.Error, ValueError):
        app.logger.exception("Failed to apply report submission rate limit")
        return jsonify(error="Reporting is temporarily unavailable. Please try again later."), 503
    if not allowed:
        return jsonify(error=f"You can submit up to {MAX_REPORTS_PER_HOUR} reports per hour."), 429

    try:
        _insert_report(image, reason)
    except psycopg.Error:
        app.logger.exception("Failed to save image report")
        return jsonify(error="The report could not be saved. Please try again later."), 503

    return jsonify(success=True), 201


@app.get("/admin/reports")
def admin_list_reports():
    if not _admin_is_authenticated():
        return _admin_auth_error()
    if not DATABASE_URL:
        return jsonify(error="Report storage is not configured. Set DATABASE_URL."), 503

    try:
        reports = _list_reports()
    except psycopg.Error:
        app.logger.exception("Failed to list image reports")
        return jsonify(error="Report storage is unavailable."), 503
    return jsonify(
        reports=reports,
        csrf_token=session.get("csrf_token", ""),
    )


@app.post("/admin/reports/<int:report_id>/review")
def admin_review_report(report_id):
    if not _admin_is_authenticated():
        return _admin_auth_error()
    if not _admin_request_is_valid():
        return jsonify(error="Invalid request token."), 403
    if not DATABASE_URL:
        return jsonify(error="Report storage is not configured. Set DATABASE_URL."), 503

    try:
        updated = _update_report_fields(report_id, status="reviewed")
    except psycopg.Error:
        app.logger.exception("Failed to mark report %d as reviewed", report_id)
        return jsonify(error="The report could not be updated."), 503
    if not updated:
        return jsonify(error="Report not found."), 404
    return jsonify(success=True)


@app.post("/admin/reports/<int:report_id>/unreview")
def admin_unreview_report(report_id):
    if not _admin_is_authenticated():
        return _admin_auth_error()
    if not _admin_request_is_valid():
        return jsonify(error="Invalid request token."), 403
    if not DATABASE_URL:
        return jsonify(error="Report storage is not configured. Set DATABASE_URL."), 503

    try:
        updated = _update_report_fields(report_id, status="open")
    except psycopg.Error:
        app.logger.exception("Failed to mark report %d as unreviewed", report_id)
        return jsonify(error="The report could not be updated."), 503
    if not updated:
        return jsonify(error="Report not found."), 404
    return jsonify(success=True)


@app.delete("/admin/comments/<int:comment_id>")
def admin_delete_comment(comment_id):
    if not _admin_is_authenticated():
        return _admin_auth_error()
    if not _admin_request_is_valid():
        return jsonify(error="Invalid request token."), 403
    if not DATABASE_URL:
        return jsonify(error="Comment storage is not configured."), 503

    try:
        deleted = _delete_comment(comment_id)
    except psycopg.Error:
        app.logger.exception("Failed to delete comment %d", comment_id)
        return jsonify(error="The comment could not be deleted."), 503
    if not deleted:
        return jsonify(error="Comment not found."), 404
    return jsonify(success=True)


@app.delete("/admin/reports/<int:report_id>")
def admin_delete_report(report_id):
    if not _admin_is_authenticated():
        return _admin_auth_error()
    if not _admin_request_is_valid():
        return jsonify(error="Invalid request token."), 403
    if not DATABASE_URL:
        return jsonify(error="Report storage is not configured. Set DATABASE_URL."), 503

    try:
        deleted = _delete_report(report_id)
    except psycopg.Error:
        app.logger.exception("Failed to delete report %d", report_id)
        return jsonify(error="The report could not be deleted."), 503
    if not deleted:
        return jsonify(error="Report not found."), 404
    return jsonify(success=True)


@app.post("/upload")
def upload_image():
    uploaded_file = request.files.get("image")
    if uploaded_file is None or not uploaded_file.filename:
        return jsonify(error="Choose an image to upload."), 400

    custom_name = request.form.get("name", "").strip()
    if len(custom_name) > MAX_IMAGE_NAME_LENGTH:
        return jsonify(error=f"Image name must be {MAX_IMAGE_NAME_LENGTH} characters or fewer."), 400
    if custom_name and not DATABASE_URL:
        return jsonify(error="Image names are not configured. Please try again without a name."), 503

    image_data = uploaded_file.read()
    if not image_data:
        return jsonify(error="The selected image is empty."), 400

    image_format = next(
        (
            image_format
            for signature, image_format in IMAGE_FORMATS.items()
            if image_data.startswith(signature)
        ),
        None,
    )
    if image_format is None and image_data.startswith(b"RIFF") and image_data[8:12] == b"WEBP":
        image_format = ("webp", "image/webp")
    if image_format is None:
        return jsonify(error="Upload a valid PNG, JPEG, GIF, or WebP image."), 400

    extension, content_type = image_format
    safe_original_name = secure_filename(uploaded_file.filename) or "image"
    display_filename = f"{Path(safe_original_name).stem or 'image'}.{extension}"
    storage_filename = f"{uuid4().hex}__{display_filename}"
    uploaded_at = datetime.now(timezone.utc).timestamp()
    if USE_BLOB_STORAGE:
        try:
            uploaded_blob = blob.put_blob(
                f"images/{storage_filename}",
                image_data,
                access="public",
                content_type=content_type,
            )
        except BlobError:
            app.logger.exception("Failed to upload image to Vercel Blob")
            return jsonify(error="Image storage is unavailable. Check the Vercel Blob store configuration."), 503
        if custom_name:
            try:
                _save_image_name(storage_filename, custom_name)
            except psycopg.Error:
                app.logger.exception("Failed to save custom name for uploaded image")
                return jsonify(error="The image was uploaded, but its custom name could not be saved."), 503
        return jsonify(
            filename=custom_name or display_filename,
            url=uploaded_blob.url,
            uploaded_at=uploaded_at,
            storage_id=storage_filename,
        ), 201

    try:
        (IMAGE_DIR / storage_filename).write_bytes(image_data)
    except OSError:
        app.logger.exception("Failed to save uploaded image locally")
        return jsonify(error="The image could not be saved."), 500
    if custom_name:
        try:
            _save_image_name(storage_filename, custom_name)
        except psycopg.Error:
            app.logger.exception("Failed to save custom name for uploaded image")
            return jsonify(error="The image was uploaded, but its custom name could not be saved."), 503
    return jsonify(
        filename=custom_name or display_filename,
        url=f"/images/{storage_filename}",
        uploaded_at=uploaded_at,
        storage_id=storage_filename,
    ), 201


@app.errorhandler(RequestEntityTooLarge)
def file_too_large(_error):
    return jsonify(error="Image must be 5 MB or smaller."), 413


@app.after_request
def prevent_sensitive_response_caching(response):
    if (
        request.path == "/likes"
        or request.path == "/likes/state"
        or request.path == "/admin"
        or request.path.startswith("/admin/")
    ):
        response.headers["Cache-Control"] = "no-store"
    return response


if __name__ == "__main__":
    app.run()
