const loginForm = document.getElementById("adminLogin");
const passwordInput = document.getElementById("adminPassword");
const adminStatus = document.getElementById("adminStatus");
const adminPanel = document.getElementById("adminPanel");
const adminImages = document.getElementById("adminImages");
const adminReports = document.getElementById("adminReports");
const adminReportsError = document.getElementById("adminReportsError");
const adminImageReportsList = document.getElementById("adminImageReportsList");
const adminCommentReportsList = document.getElementById("adminCommentReportsList");
const logoutButton = document.getElementById("logoutButton");
let csrfToken = "";
let currentReports = [];
let reportActionInProgress = false;

async function readAdminResponse(response) {
    const result = await response.json();
    if (!response.ok) {
        throw new Error(result.error || `Admin request failed (${response.status}).`);
    }
    return result;
}

function showLogin() {
    loginForm.hidden = false;
    adminPanel.hidden = true;
    adminReports.hidden = true;
    logoutButton.hidden = true;
    csrfToken = "";
    currentReports = [];
    adminImages.replaceChildren();
    adminImageReportsList.replaceChildren();
    adminCommentReportsList.replaceChildren();
}

function showAdmin() {
    loginForm.hidden = true;
    adminPanel.hidden = false;
    adminReports.hidden = false;
    logoutButton.hidden = false;
}

function displayAdminImages(images) {
    adminImages.replaceChildren();

    if (images.length === 0) {
        const emptyMessage = document.createElement("p");
        emptyMessage.textContent = "No uploaded images.";
        adminImages.appendChild(emptyMessage);
        return;
    }

    images.forEach((image) => {
        const card = document.createElement("article");
        card.className = "adminImage";
        card.dataset.storageId = image.storage_id;

        const preview = document.createElement("img");
        preview.src = image.url;
        preview.alt = image.filename;
        preview.loading = "lazy";

        const filename = document.createElement("p");
        filename.className = "adminImageName";
        filename.textContent = image.filename;

        const deleteButton = document.createElement("button");
        deleteButton.type = "button";
        deleteButton.className = "adminDeleteButton";
        deleteButton.textContent = "Delete";
        deleteButton.addEventListener("click", () => deleteImage(image, card));

        card.append(preview, filename, deleteButton);
        adminImages.appendChild(card);
    });
}

function displayAdminReports(reports) {
    const prioritizedReports = [...reports].sort((a, b) =>
        Number(a.status === "reviewed") - Number(b.status === "reviewed")
    );
    const imageReports = prioritizedReports.filter((report) => report.report_type !== "comment");
    const commentReports = prioritizedReports.filter((report) => report.report_type === "comment");
    displayAdminReportGroup(adminImageReportsList, imageReports, "No image reports.");
    displayAdminReportGroup(adminCommentReportsList, commentReports, "No comment reports.");
}

function displayAdminReportGroup(reportList, reports, emptyMessageText) {
    reportList.replaceChildren();

    if (reports.length === 0) {
        const emptyMessage = document.createElement("p");
        emptyMessage.textContent = emptyMessageText;
        reportList.appendChild(emptyMessage);
        return;
    }

    reports.forEach((report) => {
        const card = document.createElement("article");
        card.className = "adminReport";
        card.dataset.reportId = report.id;
        if (report.pending) {
            card.classList.add("is-pending");
        }
        const isReviewed = report.status === "reviewed";
        if (isReviewed) {
            card.classList.add("adminReportReviewed");
        }

        const reason = document.createElement("p");
        reason.className = "adminReportReason";
        reason.textContent = report.reason;

        const reportedComment = document.createElement("p");
        reportedComment.className = "adminReportReason";
        reportedComment.textContent = report.report_type === "comment"
            ? `Reported comment by ${report.comment_author}: ${report.comment_content}`
            : "";

        if (isReviewed) {
            card.append(reason);
            if (report.report_type === "comment") {
                card.append(reportedComment);
            }
            const actions = document.createElement("div");
            actions.className = "adminReportActions";

            const unreviewButton = document.createElement("button");
            unreviewButton.type = "button";
            unreviewButton.textContent = "Mark unreviewed";
            unreviewButton.addEventListener("click", () => unreviewReport(report));
            actions.appendChild(unreviewButton);

            const deleteButton = document.createElement("button");
            deleteButton.type = "button";
            deleteButton.textContent = "Delete report";
            deleteButton.addEventListener("click", () => deleteReport(report));
            actions.appendChild(deleteButton);

            card.appendChild(actions);
            reportList.appendChild(card);
            return;
        }

        const preview = document.createElement("img");
        preview.src = report.image_url;
        preview.alt = report.image_filename;
        preview.loading = "lazy";

        const title = document.createElement("h3");
        title.textContent = report.report_type === "comment"
            ? `Comment report #${report.id}: ${report.image_filename}`
            : `Report #${report.id}: ${report.image_filename}`;

        const details = document.createElement("p");
        details.textContent =
            `${new Date(report.created_at).toLocaleString()} · ` +
            report.status;

        const actions = document.createElement("div");
        actions.className = "adminReportActions";

        if (report.status !== "reviewed") {
            const reviewButton = document.createElement("button");
            reviewButton.type = "button";
            reviewButton.textContent = "Mark reviewed";
            reviewButton.addEventListener("click", () => reviewReport(report));
            actions.appendChild(reviewButton);
        }

        const deleteButton = document.createElement("button");
        deleteButton.type = "button";
        deleteButton.textContent = "Delete report";
        deleteButton.addEventListener("click", () => deleteReport(report));
        actions.appendChild(deleteButton);

        if (report.report_type === "comment") {
            if (report.comment_exists) {
                const deleteCommentButton = document.createElement("button");
                deleteCommentButton.type = "button";
                deleteCommentButton.textContent = "Delete comment";
                deleteCommentButton.addEventListener("click", () =>
                    deleteReportedComment(report, deleteCommentButton, reportedComment)
                );
                actions.appendChild(deleteCommentButton);
            }
        } else {
            const deleteImageButton = document.createElement("button");
            deleteImageButton.type = "button";
            deleteImageButton.textContent = "Delete image";
            deleteImageButton.addEventListener("click", () =>
                deleteReportedImage(report, deleteImageButton, preview)
            );
            actions.appendChild(deleteImageButton);
        }

        card.append(preview, title, details);
        if (report.report_type === "comment") {
            card.append(reportedComment);
        }
        card.append(reason, actions);
        reportList.appendChild(card);
    });
}

async function loadAdminReports() {
    try {
        const result = await readAdminResponse(await fetch("/admin/reports"));
        csrfToken = result.csrf_token;
        currentReports = result.reports;
        adminReportsError.hidden = true;
        adminReportsError.textContent = "";
        displayAdminReports(currentReports);
    } catch (error) {
        adminImageReportsList.replaceChildren();
        adminCommentReportsList.replaceChildren();
        adminReportsError.textContent = error.message || "Could not load reports.";
        adminReportsError.hidden = false;
    }
}

async function runReportAction(report, action, endpoint, method, confirmMessage) {
    if (reportActionInProgress) {
        return;
    }
    if (confirmMessage && !window.confirm(confirmMessage)) {
        return;
    }

    const previousReports = currentReports;
    const previousStatus = report.status;
    reportActionInProgress = true;
    if (method === "DELETE") {
        currentReports = currentReports.filter((item) => item.id !== report.id);
    } else {
        report.status = endpoint === "/review" ? "reviewed" : "open";
        report.pending = true;
    }
    displayAdminReports(currentReports);
    adminReports.querySelectorAll(".adminReportActions button").forEach((button) => {
        button.disabled = true;
    });
    adminStatus.textContent = `${action} report #${report.id}...`;
    try {
        await readAdminResponse(await fetch(`/admin/reports/${report.id}${endpoint}`, {
            method,
            headers: { "X-CSRF-Token": csrfToken },
        }));
        report.pending = false;
        displayAdminReports(currentReports);
        adminStatus.textContent = `Report #${report.id} updated.`;
    } catch (error) {
        report.status = previousStatus;
        report.pending = false;
        currentReports = previousReports;
        displayAdminReports(currentReports);
        adminStatus.textContent = error.message || `Could not ${action.toLowerCase()} report.`;
    } finally {
        reportActionInProgress = false;
    }
}

async function deleteReportedImage(report, button, preview) {
    const confirmMessage =
        `Permanently delete image "${report.image_filename}"? The report will remain.`;
    if (!window.confirm(confirmMessage)) {
        return;
    }

    button.disabled = true;
    const originalPreview = preview;
    const deletedMessage = document.createElement("p");
    deletedMessage.className = "adminReportImageDeleted";
    deletedMessage.textContent = "Deleting image...";
    preview.replaceWith(deletedMessage);
    const imageCard = Array.from(adminImages.querySelectorAll(".adminImage"))
        .find((card) => card.dataset.storageId === report.image_id);
    const imageCardNextSibling = imageCard?.nextSibling || null;
    imageCard?.remove();
    adminStatus.textContent = `Deleting image from report #${report.id}...`;
    try {
        await readAdminResponse(await fetch(
            `/admin/images/${encodeURIComponent(report.image_id)}`,
            {
                method: "DELETE",
                headers: { "X-CSRF-Token": csrfToken },
            }
        ));
        button.textContent = "Image deleted";
        deletedMessage.textContent = "Image deleted";
        if (!adminImages.querySelector(".adminImage")) {
            displayAdminImages([]);
        }
        adminStatus.textContent = `Image from report #${report.id} deleted.`;
    } catch (error) {
        button.disabled = false;
        deletedMessage.replaceWith(originalPreview);
        if (imageCard) {
            adminImages.insertBefore(imageCard, imageCardNextSibling);
        }
        adminStatus.textContent = error.message || "Could not delete the image.";
    }
}

async function deleteReportedComment(report, button, reportedComment) {
    if (!window.confirm(`Permanently delete this comment by ${report.comment_author}?`)) {
        return;
    }

    button.disabled = true;
    const originalComment = reportedComment;
    const deletedMessage = document.createElement("p");
    deletedMessage.className = "adminReportImageDeleted";
    deletedMessage.textContent = "Deleting comment...";
    reportedComment.replaceWith(deletedMessage);
    adminStatus.textContent = `Deleting comment from report #${report.id}...`;
    try {
        await readAdminResponse(await fetch(
            `/admin/comments/${report.comment_id}`,
            {
                method: "DELETE",
                headers: { "X-CSRF-Token": csrfToken },
            }
        ));
        button.textContent = "Comment deleted";
        deletedMessage.textContent = "Comment deleted";
        adminStatus.textContent = `Comment from report #${report.id} deleted.`;
    } catch (error) {
        button.disabled = false;
        deletedMessage.replaceWith(originalComment);
        adminStatus.textContent = error.message || "Could not delete the comment.";
    }
}

function reviewReport(report) {
    return runReportAction(report, "Marking", "/review", "POST");
}

function unreviewReport(report) {
    return runReportAction(report, "Marking unreviewed", "/unreview", "POST");
}

function deleteReport(report) {
    return runReportAction(
        report,
        "Deleting",
        "",
        "DELETE",
        `Permanently delete report #${report.id}?`
    );
}

async function loadAdminImages() {
    adminStatus.textContent = "Loading images...";

    try {
        const result = await readAdminResponse(await fetch("/admin/images"));
        csrfToken = result.csrf_token;
        displayAdminImages(result.images);
        showAdmin();
        adminStatus.textContent = "";
        await loadAdminReports();
    } catch (error) {
        if (error.message === "Admin login required.") {
            showLogin();
            adminStatus.textContent = "";
            return;
        }
        showLogin();
        adminStatus.textContent = error.message || "Could not load admin images.";
    }
}

async function deleteImage(image, card) {
    if (!window.confirm(`Permanently delete "${image.filename}"?`)) {
        return;
    }

    const nextSibling = card.nextSibling;
    const placeholder = document.createElement("p");
    placeholder.className = "adminImage adminImagePending";
    placeholder.textContent = `Deleting ${image.filename}...`;
    card.replaceWith(placeholder);
    adminStatus.textContent = `Deleting ${image.filename}...`;
    try {
        await readAdminResponse(await fetch(
            `/admin/images/${encodeURIComponent(image.storage_id)}`,
            {
                method: "DELETE",
                headers: { "X-CSRF-Token": csrfToken },
            }
        ));
        placeholder.remove();
        if (!adminImages.querySelector(".adminImage")) {
            displayAdminImages([]);
        }
        adminStatus.textContent = "Image deleted.";
    } catch (error) {
        placeholder.replaceWith(card);
        if (nextSibling && nextSibling.parentNode === adminImages) {
            adminImages.insertBefore(card, nextSibling);
        }
        adminStatus.textContent = error.message || "The image could not be deleted.";
    }
}

loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    adminStatus.textContent = "Logging in...";

    try {
        const result = await readAdminResponse(await fetch("/admin/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: passwordInput.value }),
        }));
        csrfToken = result.csrf_token;
        passwordInput.value = "";
        await loadAdminImages();
    } catch (error) {
        adminStatus.textContent = error.message || "Login failed.";
        passwordInput.select();
    }
});

logoutButton.addEventListener("click", async () => {
    try {
        await readAdminResponse(await fetch("/admin/logout", {
            method: "POST",
            headers: { "X-CSRF-Token": csrfToken },
        }));
        showLogin();
        adminStatus.textContent = "Logged out.";
    } catch (error) {
        adminStatus.textContent = error.message || "Could not log out.";
    }
});

loadAdminImages();
