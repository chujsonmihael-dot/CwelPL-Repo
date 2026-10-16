function displayImage(image) {
    const figure = document.createElement("figure");
    figure.className = "imageItem";

    const img = document.createElement("img");
    img.src = image.url;
    img.alt = image.filename;

    const caption = document.createElement("figcaption");
    caption.textContent = image.filename;

    figure.append(img, caption);
    document.getElementById("Images").appendChild(figure);
}

async function readJsonResponse(response, endpoint) {
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
        throw new Error(
            `${endpoint} returned HTTP ${response.status}, not JSON. Vercel may not be routing this request to the Flask app.`
        );
    }

    return response.json();
}

async function loadUploadedImages() {
    const status = document.getElementById("uploadStatus");

    try {
        const response = await fetch("/images");
        const result = await readJsonResponse(response, "/images");

        if (!response.ok) {
            throw new Error(result.error || "Saved images could not be loaded.");
        }

        result.images.forEach((image) => displayImage(image));
    } catch (error) {
        status.textContent = error.message || "Could not load saved images.";
    }
}

async function uploadImage() {
    const input = document.getElementById("input");
    const status = document.getElementById("uploadStatus");
    const uploadButton = document.getElementById("uploadButton");
    const selectedFile = input.files[0];

    if (!selectedFile) {
        status.textContent = "Choose an image to upload.";
        return;
    }

    const formData = new FormData();
    formData.append("image", selectedFile);
    uploadButton.disabled = true;
    status.textContent = "Uploading...";

    try {
        const response = await fetch("/upload", {
            method: "POST",
            body: formData
        });
        const result = await readJsonResponse(response, "/upload");

        if (!response.ok) {
            throw new Error(result.error || "The image could not be uploaded.");
        }

        displayImage(result);
        status.textContent = "Image uploaded successfully.";
        input.value = "";
    } catch (error) {
        status.textContent = error.message || "Could not connect to the upload server.";
    } finally {
        uploadButton.disabled = false;
    }
}

loadUploadedImages();