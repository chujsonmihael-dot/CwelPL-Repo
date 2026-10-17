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

async function optimizeImage(file) {
    if (file.type === "image/gif") {
        return file;
    }

    const bitmap = await createImageBitmap(file);
    try {
        const scale = Math.min(256 / bitmap.width, 256 / bitmap.height, 1);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));

        const context = canvas.getContext("2d");
        if (!context) {
            throw new Error("This browser could not prepare the image for upload.");
        }
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

        const optimizedBlob = await new Promise((resolve, reject) => {
            canvas.toBlob((blob) => {
                if (blob) {
                    resolve(blob);
                } else {
                    reject(new Error("This browser could not compress the image."));
                }
            }, "image/webp", 0.82);
        });

        if (scale === 1 && optimizedBlob.size >= file.size) {
            return file;
        }

        const extension = optimizedBlob.type === "image/webp" ? "webp" : "png";
        const baseName = file.name.replace(/\.[^.]+$/, "");
        return new File([optimizedBlob], `${baseName}.${extension}`, {
            type: optimizedBlob.type,
            lastModified: file.lastModified
        });
    } finally {
        bitmap.close();
    }
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

    uploadButton.disabled = true;
    status.textContent = "Optimizing image...";

    try {
        const imageToUpload = await optimizeImage(selectedFile);
        const formData = new FormData();
        formData.append("image", imageToUpload);
        status.textContent = imageToUpload === selectedFile
            ? "Uploading image..."
            : "Uploading optimized image...";

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
        status.textContent = error.message || "Could not optimize or upload the image.";
    } finally {
        uploadButton.disabled = false;
    }
}

loadUploadedImages();