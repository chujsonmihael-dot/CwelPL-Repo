const modal = document.getElementById("imageModal");
const modalImage = document.getElementById("modalImage");
const imageModalActions = document.getElementById("imageModalActions");
const closeModalButton = document.getElementById("closeModal");
const prevImageButton = document.getElementById("prevImage");
const nextImageButton = document.getElementById("nextImage");
const reportImageButton = document.getElementById("reportImageButton");
const imageComments = document.getElementById("imageComments");
const imageCommentList = document.getElementById("imageCommentList");
const commentForm = document.getElementById("commentForm");
const commentAuthor = document.getElementById("commentAuthor");
const commentContent = document.getElementById("commentContent");
const commentLength = document.getElementById("commentLength");
const commentStatus = document.getElementById("commentStatus");
const submitCommentButton = document.getElementById("submitComment");
const reportDialog = document.getElementById("reportDialog");
const reportForm = document.getElementById("reportForm");
const reportPreview = document.getElementById("reportPreview");
const reportFilename = document.getElementById("reportFilename");
const reportReason = document.getElementById("reportReason");
const reportStatus = document.getElementById("reportStatus");
const submitReportButton = document.getElementById("submitReport");
const imageSortControls = document.getElementById("imageSortControls");
const imageSortButtons = Array.from(
    imageSortControls.querySelectorAll(".imageSortOption")
);
const refreshImagesButton = document.getElementById("refreshImagesButton");
let activeImageFigure = null;
let activeImageIndex = -1;
let activeImage = null;
const likeStates = new Map();
const likeControls = new Map();
const loadedLikeImageIds = new Set();
const likeLoadErrors = new Map();
let likesLoadPromise = Promise.resolve();
const imageSortModes = ["latest", "liked", "random"];
let imageSortMode = "latest";

function getGalleryImages() {
    return Array.from(document.querySelectorAll(".imageItem"));
}

function sortGalleryImages() {
    const images = getGalleryImages();
    if (imageSortMode === "liked") {
        images.sort((a, b) => {
            const aLikes = likeStates.get(likeStateKey("image", a.dataset.storageId))?.count || 0;
            const bLikes = likeStates.get(likeStateKey("image", b.dataset.storageId))?.count || 0;
            return bLikes - aLikes ||
                Number(b.dataset.uploadedAt) - Number(a.dataset.uploadedAt);
        });
    } else if (imageSortMode === "random") {
        for (let index = images.length - 1; index > 0; index -= 1) {
            const swapIndex = Math.floor(Math.random() * (index + 1));
            [images[index], images[swapIndex]] = [images[swapIndex], images[index]];
        }
    } else {
        images.sort(
            (a, b) => Number(b.dataset.uploadedAt) - Number(a.dataset.uploadedAt)
        );
    }

    const gallery = document.getElementById("Images");
    images.forEach((image) => gallery.appendChild(image));
    if (activeImageFigure) {
        activeImageIndex = images.indexOf(activeImageFigure);
    }
}

function setImageSortMode(mode) {
    if (!imageSortModes.includes(mode)) {
        return;
    }

    imageSortMode = mode;
    imageSortButtons.forEach((button) => {
        button.setAttribute("aria-pressed", String(button.dataset.sortMode === mode));
    });
    sortGalleryImages();
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
        storage_id: activeFigure.dataset.storageId,
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
    activeImage = image;

    unregisterLikeControlsWithin(imageModalActions);
    imageModalActions.replaceChildren();
    if (image.storage_id) {
        imageModalActions.appendChild(
            createLikeControls("image", image.storage_id, image.storage_id).container
        );
    }
    imageModalActions.appendChild(reportImageButton);

    modalImage.src = image.url;
    modalImage.alt = image.filename;
    unregisterLikeControlsWithin(imageCommentList);
    imageCommentList.replaceChildren();
    commentContent.value = "";
    commentLength.textContent = "0/150";
    commentStatus.textContent = "";
    submitCommentButton.disabled = false;
    imageComments.hidden = !image.storage_id;
    modal.setAttribute("aria-hidden", "false");
    modal.classList.remove("hidden");
    document.body.classList.add("modal-open");

    const galleryItems = getGalleryImages();
    galleryItems.forEach((item) => {
        const isActive = item === figure;
        item.classList.toggle("modal-active", isActive);
        item.classList.toggle("modal-dimmed", !isActive);
    });
    if (image.storage_id) {
        loadImageComments(image);
    }
}

function closeImageModal() {
    closeReportDialog();
    activeImageFigure = null;
    activeImageIndex = -1;
    activeImage = null;
    modal.setAttribute("aria-hidden", "true");
    modal.classList.add("hidden");
    document.body.classList.remove("modal-open");

    document.querySelectorAll(".imageItem").forEach((item) => {
        item.classList.remove("modal-active", "modal-dimmed");
    });
}

function openReportDialog() {
    if (!activeImage) {
        return;
    }

    reportPreview.src = activeImage.url;
    reportPreview.alt = activeImage.filename;
    reportFilename.textContent = activeImage.filename;
    reportReason.value = "";
    reportStatus.textContent = "";
    submitReportButton.disabled = false;
    reportDialog.hidden = false;
    reportReason.focus();
}

function closeReportDialog() {
    reportDialog.hidden = true;
    reportForm.reset();
    reportStatus.textContent = "";
    submitReportButton.disabled = false;
    if (!modal.classList.contains("hidden")) {
        reportImageButton.focus();
    }
}

function displayImageComments(comments) {
    unregisterLikeControlsWithin(imageCommentList);
    imageCommentList.replaceChildren();
    setCommentCount(comments.length);
    if (!comments.length) {
        const emptyMessage = document.createElement("p");
        emptyMessage.textContent = "No comments yet.";
        imageCommentList.appendChild(emptyMessage);
        return;
    }

    comments.forEach((comment) => {
        imageCommentList.appendChild(createImageCommentItem(comment));
    });
}

function setCommentCount(count) {
    document.getElementById("commentCount").textContent = `(${count})`;
}

function createImageCommentItem(comment, pending = false) {
    const item = document.createElement("article");
    item.className = "imageComment";
    if (pending) {
        item.classList.add("is-pending");
    }

    const heading = document.createElement("p");
    heading.className = "imageCommentHeading";
    heading.textContent =
        `${comment.author} · ${new Date(comment.created_at).toLocaleString()}`;

    const content = document.createElement("p");
    content.className = "imageCommentContent";
    content.textContent = comment.content;

    const likeControlsForComment = createLikeControls(
        "comment",
        String(comment.id),
        comment.image_id
    );
    if (pending) {
        likeControlsForComment.control.button.disabled = true;
    }

    const reportButton = document.createElement("button");
    reportButton.type = "button";
    reportButton.className = "reportCommentButton";
    reportButton.textContent = "Report";
    reportButton.disabled = pending;

    const reportForm = document.createElement("form");
    reportForm.className = "commentReportForm";
    reportForm.hidden = true;
    const reasonLabel = document.createElement("label");
    reasonLabel.textContent = "Why are you reporting this comment?";
    const reason = document.createElement("textarea");
    reason.maxLength = 5000;
    reason.required = true;
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Send report";
    const actions = document.createElement("div");
    actions.className = "commentReportActions";
    actions.append(cancel, submit);
    reportForm.append(reasonLabel, reason, status, actions);

    reportButton.addEventListener("click", () => {
        reportForm.hidden = !reportForm.hidden;
    });
    cancel.addEventListener("click", () => {
        reportForm.reset();
        status.textContent = "";
        reportForm.hidden = true;
    });
    reportForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        submit.disabled = true;
        status.textContent = "Submitting report...";
        try {
            const response = await fetch(`/comments/${comment.id}/report`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ reason: reason.value }),
            });
            const result = await readJsonResponse(response, "/comments/report");
            if (!response.ok) {
                throw new Error(result.error || "The report could not be submitted.");
            }
            status.textContent = "Comment reported. Thank you.";
            submit.disabled = true;
            cancel.hidden = true;
        } catch (error) {
            status.textContent = error.message || "The report could not be submitted.";
            submit.disabled = false;
        }
    });

    item.append(heading, content, likeControlsForComment.container, reportButton, reportForm);
    return item;
}

function likeStateKey(targetType, targetId) {
    return `${targetType}:${targetId}`;
}

function unregisterLikeControlsWithin(container) {
    likeControls.forEach((controls, key) => {
        const remainingControls = controls.filter(
            (control) => !container.contains(control.button)
        );
        if (remainingControls.length > 0) {
            likeControls.set(key, remainingControls);
        } else {
            likeControls.delete(key);
        }
    });
}

function updateLikeControl(control, state) {
    control.button.disabled = false;
    control.icon.src = state.liked
        ? "/Icons/LikeIcon2.png"
        : "/Icons/LikeIcon1.png";
    control.button.setAttribute("aria-label", state.liked ? "Unlike" : "Like");
    control.button.setAttribute("aria-pressed", String(state.liked));
    control.count.textContent = String(state.count);
    control.status.textContent = "";
}

function createLikeControls(targetType, targetId, imageId) {
    const container = document.createElement("div");
    container.className = "likeControls";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "likeButton";
    button.disabled = !loadedLikeImageIds.has(imageId);

    const icon = document.createElement("img");
    icon.src = "/Icons/LikeIcon1.png";
    icon.alt = "";
    icon.setAttribute("aria-hidden", "true");
    button.appendChild(icon);
    button.setAttribute("aria-label", "Like");

    const count = document.createElement("span");
    count.className = "likeCount";

    const status = document.createElement("span");
    status.className = "likeStatus";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");

    const control = { button, icon, count, status, imageId };
    const key = likeStateKey(targetType, targetId);
    const controls = likeControls.get(key) || [];
    controls.push(control);
    likeControls.set(key, controls);
    button.addEventListener("click", (event) => {
        event.stopPropagation();
        toggleLike(targetType, targetId, control);
    });

    container.append(button, count, status);
    const state = likeStates.get(key) || { count: 0, liked: false };
    if (loadedLikeImageIds.has(imageId)) {
        updateLikeControl(control, state);
    } else if (likeLoadErrors.has(imageId)) {
        status.textContent = likeLoadErrors.get(imageId);
    } else {
        count.textContent = "0";
        button.setAttribute("aria-pressed", "false");
    }
    return { container, control };
}

async function loadLikesForImages(images) {
    if (!images.length) {
        return;
    }

    try {
        const response = await fetch("/likes/state", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                image_ids: images.map((image) => image.storage_id),
            }),
        });
        const result = await readJsonResponse(response, "/likes/state");
        if (!response.ok) {
            throw new Error(result.error || "Likes could not be loaded.");
        }

        result.likes.forEach((like) => {
            likeStates.set(likeStateKey(like.target_type, like.target_id), {
                count: like.count,
                liked: like.liked,
            });
        });
        images.forEach((image) => {
            loadedLikeImageIds.add(image.storage_id);
            likeLoadErrors.delete(image.storage_id);
            const imageKey = likeStateKey("image", image.storage_id);
            if (!likeStates.has(imageKey)) {
                likeStates.set(imageKey, { count: 0, liked: false });
            }
            likeControls.forEach((controls, key) => {
                controls.forEach((control) => {
                    if (control.imageId === image.storage_id) {
                        updateLikeControl(
                            control,
                            likeStates.get(key) || { count: 0, liked: false }
                        );
                    }
                });
            });
        });
    } catch (error) {
        const message = error.message || "Likes could not be loaded.";
        images.forEach((image) => {
            likeLoadErrors.set(image.storage_id, message);
            likeControls.forEach((controls) => {
                controls.forEach((control) => {
                    if (control.imageId === image.storage_id) {
                        control.button.disabled = true;
                        control.status.textContent = message;
                    }
                });
            });
        });
    }
}

async function toggleLike(targetType, targetId, control) {
    const key = likeStateKey(targetType, targetId);
    const currentState = likeStates.get(key) || { count: 0, liked: false };
    const optimisticState = {
        count: Math.max(0, currentState.count + (currentState.liked ? -1 : 1)),
        liked: !currentState.liked,
    };
    const controls = likeControls.get(key) || [control];
    likeStates.set(key, optimisticState);
    controls.forEach((likeControl) => {
        updateLikeControl(likeControl, optimisticState);
        likeControl.button.disabled = true;
        likeControl.status.textContent = "Saving...";
    });
    if (targetType === "image" && imageSortMode === "liked") {
        sortGalleryImages();
    }
    try {
        const response = await fetch("/likes", {
            method: currentState.liked ? "DELETE" : "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ target_type: targetType, target_id: targetId }),
        });
        const result = await readJsonResponse(response, "/likes");
        if (!response.ok) {
            throw new Error(result.error || "The like could not be updated.");
        }
        if (!Number.isInteger(result.count) || typeof result.liked !== "boolean") {
            throw new Error("The like response was invalid.");
        }

        const state = { count: result.count, liked: result.liked };
        likeStates.set(key, state);
        (likeControls.get(key) || [control]).forEach((likeControl) =>
            updateLikeControl(likeControl, state)
        );
        if (targetType === "image" && imageSortMode === "liked") {
            sortGalleryImages();
        }
    } catch (error) {
        likeStates.set(key, currentState);
        (likeControls.get(key) || [control]).forEach((likeControl) => {
            updateLikeControl(likeControl, currentState);
            likeControl.status.textContent = error.message || "The like could not be updated.";
        });
        if (targetType === "image" && imageSortMode === "liked") {
            sortGalleryImages();
        }
    }
}

async function loadImageComments(image) {
    try {
        const response = await fetch(
            `/comments?image_id=${encodeURIComponent(image.storage_id)}`
        );
        const result = await readJsonResponse(response, "/comments");
        if (!response.ok) {
            throw new Error(result.error || "Comments could not be loaded.");
        }
        await likesLoadPromise;
        if (activeImage?.storage_id === image.storage_id) {
            displayImageComments(result.comments);
        }
    } catch (error) {
        if (activeImage?.storage_id === image.storage_id) {
            imageCommentList.replaceChildren();
            const message = document.createElement("p");
            message.textContent = error.message || "Comments could not be loaded.";
            imageCommentList.appendChild(message);
        }
    }
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
    figure.dataset.storageId = image.storage_id || "";
    figure.dataset.uploadedAt = String(getImageTimestamp(image));

    const img = document.createElement("img");
    img.src = image.url;
    img.alt = image.filename;

    const caption = document.createElement("figcaption");
    caption.textContent = image.filename;

    const likeControlsForImage = createLikeControls(
        "image",
        image.storage_id || "",
        image.storage_id || ""
    );

    figure.append(img, caption, likeControlsForImage.container);
    figure.addEventListener("click", (event) => {
        if (!event.target.closest(".likeControls")) {
            openImageModal(image, figure);
        }
    });
    figure.addEventListener("keydown", (event) => {
        if (event.target.closest(".likeButton")) {
            return;
        }
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
        likesLoadPromise = loadLikesForImages(images);
        await likesLoadPromise;
        sortGalleryImages();
        imageSortButtons.forEach((button) => {
            button.disabled = false;
        });
    } catch (error) {
        status.textContent = error.message || "Could not load saved images.";
    } finally {
        refreshImagesButton.disabled = false;
    }
}

async function refreshUploadedImages() {
    const status = document.getElementById("uploadStatus");
    refreshImagesButton.disabled = true;
    refreshImagesButton.classList.add("isRefreshing");
    status.textContent = "Refreshing images...";

    try {
        const response = await fetch("/images", { cache: "no-store" });
        const result = await readJsonResponse(response, "/images");
        if (!response.ok) {
            throw new Error(result.error || "Saved images could not be refreshed.");
        }
        if (!Array.isArray(result.images)) {
            throw new Error("The image refresh response was invalid.");
        }

        const existingIds = new Set(
            getGalleryImages().map((figure) => figure.dataset.storageId)
        );
        result.images.forEach((image) => {
            if (!image.storage_id || existingIds.has(image.storage_id)) {
                return;
            }
            displayImage(image);
            existingIds.add(image.storage_id);
        });

        likesLoadPromise = loadLikesForImages(result.images);
        await likesLoadPromise;
        sortGalleryImages();
        imageSortButtons.forEach((button) => {
            button.disabled = false;
        });
        status.textContent = "Images refreshed.";
    } catch (error) {
        status.textContent = error.message || "Could not refresh images.";
    } finally {
        refreshImagesButton.disabled = false;
        refreshImagesButton.classList.remove("isRefreshing");
    }
}

async function uploadImage() {
    const input = document.getElementById("input");
    const nameInput = document.getElementById("uploadImageName");
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
        formData.append("name", nameInput.value.trim());
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
        likesLoadPromise = loadLikesForImages([result]);
        await likesLoadPromise;
        sortGalleryImages();
        status.textContent = "Image uploaded successfully.";
        input.value = "";
        nameInput.value = "";
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

reportImageButton.addEventListener("click", openReportDialog);
refreshImagesButton.addEventListener("click", refreshUploadedImages);
imageSortButtons.forEach((button) => {
    button.addEventListener("click", () => setImageSortMode(button.dataset.sortMode));
});
commentContent.addEventListener("input", () => {
    commentLength.textContent = `${commentContent.value.length}/150`;
});
commentForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!activeImage?.storage_id) {
        commentStatus.textContent = "This image cannot receive comments.";
        return;
    }

    const commentImage = activeImage;
    const optimisticComment = {
        id: `pending-${Date.now()}`,
        image_id: commentImage.storage_id,
        author: commentAuthor.value.trim(),
        content: commentContent.value.trim(),
        created_at: new Date().toISOString(),
    };
    const emptyMessage = imageCommentList.querySelector(":scope > p");
    if (emptyMessage) {
        emptyMessage.remove();
    }
    const optimisticItem = createImageCommentItem(optimisticComment, true);
    imageCommentList.appendChild(optimisticItem);
    setCommentCount(imageCommentList.querySelectorAll(".imageComment").length);

    submitCommentButton.disabled = true;
    commentStatus.textContent = "Posting...";
    try {
        const response = await fetch("/comments", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                image_id: commentImage.storage_id,
                author: commentAuthor.value,
                content: commentContent.value,
            }),
        });
        const result = await readJsonResponse(response, "/comments");
        if (!response.ok) {
            throw new Error(result.error || "The comment could not be posted.");
        }

        if (activeImage?.storage_id === commentImage.storage_id) {
            const confirmedComment = result.comment;
            unregisterLikeControlsWithin(optimisticItem);
            optimisticItem.replaceWith(createImageCommentItem(confirmedComment));
            commentForm.reset();
            commentLength.textContent = "0/150";
            commentStatus.textContent = "Comment posted.";
            setCommentCount(imageCommentList.querySelectorAll(".imageComment").length);
            loadImageComments(commentImage);
        }
    } catch (error) {
        optimisticItem.remove();
        unregisterLikeControlsWithin(optimisticItem);
        if (activeImage?.storage_id === commentImage.storage_id) {
            const remainingComments = imageCommentList.querySelectorAll(".imageComment");
            setCommentCount(remainingComments.length);
            if (!remainingComments.length) {
                const emptyMessageAfterRollback = document.createElement("p");
                emptyMessageAfterRollback.textContent = "No comments yet.";
                imageCommentList.appendChild(emptyMessageAfterRollback);
            }
            commentStatus.textContent = error.message || "The comment could not be posted.";
        }
    } finally {
        if (activeImage?.storage_id === commentImage.storage_id) {
            submitCommentButton.disabled = false;
        }
    }
});
document.getElementById("cancelReport").addEventListener("click", closeReportDialog);
reportDialog.addEventListener("click", (event) => {
    if (event.target === reportDialog) {
        closeReportDialog();
    }
});
reportForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!activeImage || !activeImage.storage_id) {
        reportStatus.textContent = "This image cannot be identified for reporting.";
        return;
    }

    submitReportButton.disabled = true;
    reportStatus.textContent = "Submitting report...";
    try {
        const response = await fetch("/report", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                image_id: activeImage.storage_id,
                reason: reportReason.value,
            }),
        });
        const result = await readJsonResponse(response, "/report");
        if (!response.ok) {
            throw new Error(result.error || "The report could not be sent.");
        }

        reportStatus.textContent = "Report submitted. Thank you.";
    } catch (error) {
        reportStatus.textContent = error.message || "The report could not be sent.";
        submitReportButton.disabled = false;
    }
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
    if (!reportDialog.hidden) {
        if (event.key === "Escape") {
            closeReportDialog();
        }
        return;
    }

    if (event.key === "Escape" && !modal.classList.contains("hidden")) {
        closeImageModal();
    }

    if (modal.classList.contains("hidden")) {
        return;
    }

    if (
        event.target instanceof HTMLElement
        && (event.target.isContentEditable
            || ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName))
    ) {
        return;
    }

    if (event.key === "ArrowLeft") {
        showPreviousImage();
    } else if (event.key === "ArrowRight") {
        showNextImage();
    }
});

loadUploadedImages();