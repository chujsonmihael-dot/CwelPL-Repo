import os
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from flask import Flask, jsonify, request, send_from_directory
from vercel.blob import sync as blob
from vercel.blob.errors import BlobError
from werkzeug.exceptions import RequestEntityTooLarge
from werkzeug.utils import secure_filename

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 5 * 1024 * 1024

BASE_DIR = Path(__file__).resolve().parent
IMAGE_DIR = BASE_DIR / "images"
USE_BLOB_STORAGE = os.environ.get("VERCEL") == "1"
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


@app.get("/style.css")
def stylesheet():
    return send_from_directory(BASE_DIR, "style.css")


@app.get("/script.js")
def script():
    return send_from_directory(BASE_DIR, "script.js")


@app.get("/images/<path:filename>")
def uploaded_image(filename):
    return send_from_directory(IMAGE_DIR, filename)


def _get_time_value(value):
    if isinstance(value, (int, float)):
        return float(value)
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


@app.get("/images")
def list_uploaded_images():
    if USE_BLOB_STORAGE:
        try:
            images = [
                {
                    "filename": get_display_filename(
                        item.pathname.removeprefix("images/")
                    ),
                    "url": item.url,
                    "uploaded_at": _get_uploaded_at_value(item),
                }
                for item in blob.query_blobs(prefix="images/")
                if Path(item.pathname).suffix.lower() in IMAGE_EXTENSIONS
            ]
            images.sort(key=lambda item: _get_time_value(item.get("uploaded_at")), reverse=True)
        except BlobError:
            app.logger.exception("Failed to list images from Vercel Blob")
            return jsonify(error="Image storage is unavailable. Check the Vercel Blob store configuration."), 503
        return jsonify(images=images)

    image_entries = []
    for path in IMAGE_DIR.iterdir():
        if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS:
            image_entries.append(
                {
                    "filename": get_display_filename(path.name),
                    "url": f"/images/{path.name}",
                    "uploaded_at": path.stat().st_mtime,
                }
            )

    image_entries.sort(key=lambda item: item["uploaded_at"], reverse=True)
    return jsonify(images=image_entries)


@app.post("/upload")
def upload_image():
    uploaded_file = request.files.get("image")
    if uploaded_file is None or not uploaded_file.filename:
        return jsonify(error="Choose an image to upload."), 400

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
        return jsonify(
            filename=display_filename,
            url=uploaded_blob.url,
            uploaded_at=uploaded_at,
        ), 201

    (IMAGE_DIR / storage_filename).write_bytes(image_data)
    return jsonify(
        filename=display_filename,
        url=f"/images/{storage_filename}",
        uploaded_at=uploaded_at,
    ), 201


@app.errorhandler(RequestEntityTooLarge)
def file_too_large(_error):
    return jsonify(error="Image must be 5 MB or smaller."), 413


if __name__ == "__main__":
    app.run()
