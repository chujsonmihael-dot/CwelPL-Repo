const modal = document.getElementById("imageModal");
const modalImage = document.getElementById("modalImage");
const closeModalButton = document.getElementById("closeModal");
const prevImageButton = document.getElementById("prevImage");
const nextImageButton = document.getElementById("nextImage");
let activeImageFigure = null;
let activeImageIndex = -1;

function getGalleryImages() {
    return Array.from(document.querySelectorAll(".imageItem"));
}

function showImageAtIndex(index) {
    const galleryFigures = getGalleryImages();
    if (!galleryFigures.length) {
        return;
    }

    const normalizedIndex = (index + galleryFigures.length) % galleryFigures.length;
    const activeFigure = galleryFigures[normalizedIndex];
    const img = activeFigure.querySelector("img");
    const title = activeFigure.querySelector("figcaption");
    const imageData = {
        url: img.src,
        filename: title ? title.textContent : img.alt,
    };

    activeImageFigure = activeFigure;
    activeImageIndex = normalizedIndex;
    openImageModal(imageData, activeFigure);
}

function getImageTimestamp(image) {
    const value = image.uploaded_at ?? image.created_at ?? image.created ?? image.uploadedAt ?? image.createdAt ?? 0;
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === "string" && value.trim() !== "") {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    return 0;
}

function openImageModal(image, figure) {
    activeImageFigure = figure;
    activeImageIndex = getGalleryImages().indexOf(figure);

    modalImage.src = image.url;
    modalImage.alt = image.filename;
    modal.setAttribute("aria-hidden", "false");
    modal.classList.remove("hidden");
    document.body.classList.add("modal-open");

    const galleryItems = getGalleryImages();
    galleryItems.forEach((item) => {
        const isActive = item === figure;
        item.classList.toggle("modal-active", isActive);
        item.classList.toggle("modal-dimmed", !isActive);
    });
}

function closeImageModal() {
    activeImageFigure = null;
    activeImageIndex = -1;
    modal.setAttribute("aria-hidden", "true");
    modal.classList.add("hidden");
    document.body.classList.remove("modal-open");

    document.querySelectorAll(".imageItem").forEach((item) => {
        item.classList.remove("modal-active", "modal-dimmed");
    });
}

function showPreviousImage() {
    if (activeImageIndex < 0) {
        return;
    }

    showImageAtIndex(activeImageIndex - 1);
}

function showNextImage() {
    if (activeImageIndex < 0) {
        return;
    }

    showImageAtIndex(activeImageIndex + 1);
}

function displayImage(image, prepend = false) {
    const figure = document.createElement("figure");
    figure.className = "imageItem";
    figure.tabIndex = 0;

    const img = document.createElement("img");
    img.src = image.url;
    img.alt = image.filename;

    const caption = document.createElement("figcaption");
    caption.textContent = image.filename;

    figure.append(img, caption);
    figure.addEventListener("click", () => openImageModal(image, figure));
    figure.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openImageModal(image, figure);
        }
    });

    const gallery = document.getElementById("Images");
    if (prepend) {
        gallery.prepend(figure);
        return;
    }

    gallery.appendChild(figure);
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

        const images = [...(result.images || [])].sort((a, b) => 
            getImageTimestamp(b) - getImageTimestamp(a)
        );

        images.forEach((image) => displayImage(image));
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

        displayImage(result, true);
        status.textContent = "Image uploaded successfully.";
        input.value = "";
        document.getElementById("selectedFileName").textContent = "No file chosen";
    } catch (error) {
        status.textContent = error.message || "Could not optimize or upload the image.";
    } finally {
        uploadButton.disabled = false;
    }
}

document.getElementById("input").addEventListener("change", (event) => {
    const input = event.currentTarget;
    document.getElementById("selectedFileName").textContent =
        input.files[0]?.name || "No file chosen";
});

closeModalButton.addEventListener("click", closeImageModal);
prevImageButton.addEventListener("click", showPreviousImage);
nextImageButton.addEventListener("click", showNextImage);
modal.addEventListener("click", (event) => {
    if (event.target === modal) {
        closeImageModal();
    }
});
document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.classList.contains("hidden")) {
        closeImageModal();
    }

    if (modal.classList.contains("hidden")) {
        return;
    }

    if (event.key === "ArrowLeft") {
        showPreviousImage();
    } else if (event.key === "ArrowRight") {
        showNextImage();
    }
});

loadUploadedImages();