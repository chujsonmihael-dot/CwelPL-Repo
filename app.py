import os
from pathlib import Path
from uuid import uuid4

from flask import Flask, jsonify, request, send_from_directory
from vercel.blob import sync as blob
from vercel.blob.errors import BlobError
from werkzeug.exceptions import RequestEntityTooLarge

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


@app.get("/")
def index():
    return send_from_directory(BASE_DIR, "index.html")


@app.get("/style.css")
def stylesheet():
    return send_from_directory(BASE_DIR, "style.css")


@app.get("/script.js")
def script():
    return send_from_directory(BASE_DIR, "script.js")


@app.get("/images/<path:filename>")
def uploaded_image(filename):
    return send_from_directory(IMAGE_DIR, filename)


@app.get("/images")
def list_uploaded_images():
    if USE_BLOB_STORAGE:
        try:
            images = [
                {"filename": item.pathname.removeprefix("images/"), "url": item.url}
                for item in blob.query_blobs(prefix="images/")
                if Path(item.pathname).suffix.lower() in IMAGE_EXTENSIONS
            ]
        except BlobError:
            app.logger.exception("Failed to list images from Vercel Blob")
            return jsonify(error="Image storage is unavailable. Check the Vercel Blob store configuration."), 503
        return jsonify(images=images)

    filenames = sorted(
        path.name
        for path in IMAGE_DIR.iterdir()
        if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS
    )
    return jsonify(images=[{"filename": name, "url": f"/images/{name}"} for name in filenames])


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
    filename = f"{uuid4().hex}.{extension}"
    if USE_BLOB_STORAGE:
        try:
            uploaded_blob = blob.put_blob(
                f"images/{filename}",
                image_data,
                access="public",
                content_type=content_type,
            )
        except BlobError:
            app.logger.exception("Failed to upload image to Vercel Blob")
            return jsonify(error="Image storage is unavailable. Check the Vercel Blob store configuration."), 503
        return jsonify(filename=filename, url=uploaded_blob.url), 201

    (IMAGE_DIR / filename).write_bytes(image_data)
    return jsonify(filename=filename, url=f"/images/{filename}"), 201


@app.errorhandler(RequestEntityTooLarge)
def file_too_large(_error):
    return jsonify(error="Image must be 5 MB or smaller."), 413


if __name__ == "__main__":
    app.run()
