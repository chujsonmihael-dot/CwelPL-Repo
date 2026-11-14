const loginForm = document.getElementById("adminLogin");
const passwordInput = document.getElementById("adminPassword");
const adminStatus = document.getElementById("adminStatus");
const adminPanel = document.getElementById("adminPanel");
const adminImages = document.getElementById("adminImages");
const adminReports = document.getElementById("adminReports");
const adminReportsList = document.getElementById("adminReportsList");
const logoutButton = document.getElementById("logoutButton");
let csrfToken = "";

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
    adminImages.replaceChildren();
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
    adminReportsList.replaceChildren();

    if (reports.length === 0) {
        const emptyMessage = document.createElement("p");
        emptyMessage.textContent = "No reports have been submitted.";
        adminReportsList.appendChild(emptyMessage);
        return;
    }

    reports.forEach((report) => {
        const card = document.createElement("article");
        card.className = "adminReport";

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

        const reason = document.createElement("p");
        reason.className = "adminReportReason";
        reason.textContent = report.reason;

        const reportedComment = document.createElement("p");
        reportedComment.className = "adminReportReason";
        reportedComment.textContent = report.report_type === "comment"
            ? `Reported comment by ${report.comment_author}: ${report.comment_content}`
            : "";

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
        adminReportsList.appendChild(card);
    });
}

async function loadAdminReports() {
    try {
        const result = await readAdminResponse(await fetch("/admin/reports"));
        csrfToken = result.csrf_token;
        displayAdminReports(result.reports);
    } catch (error) {
        adminReportsList.replaceChildren();
        const message = document.createElement("p");
        message.textContent = error.message || "Could not load reports.";
        adminReportsList.appendChild(message);
    }
}

async function runReportAction(report, action, endpoint, method, confirmMessage) {
    if (confirmMessage && !window.confirm(confirmMessage)) {
        return;
    }

    adminStatus.textContent = `${action} report #${report.id}...`;
    try {
        await readAdminResponse(await fetch(`/admin/reports/${report.id}${endpoint}`, {
            method,
            headers: { "X-CSRF-Token": csrfToken },
        }));
        adminStatus.textContent = `Report #${report.id} updated.`;
        await loadAdminReports();
    } catch (error) {
        adminStatus.textContent = error.message || `Could not ${action.toLowerCase()} report.`;
    }
}

async function deleteReportedImage(report, button, preview) {
    const confirmMessage =
        `Permanently delete image "${report.image_filename}"? The report will remain.`;
    if (!window.confirm(confirmMessage)) {
        return;
    }

    button.disabled = true;
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
        const deletedMessage = document.createElement("p");
        deletedMessage.className = "adminReportImageDeleted";
        deletedMessage.textContent = "Image deleted";
        preview.replaceWith(deletedMessage);
        adminStatus.textContent = `Image from report #${report.id} deleted.`;
    } catch (error) {
        button.disabled = false;
        adminStatus.textContent = error.message || "Could not delete the image.";
    }
}

async function deleteReportedComment(report, button, reportedComment) {
    if (!window.confirm(`Permanently delete this comment by ${report.comment_author}?`)) {
        return;
    }

    button.disabled = true;
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
        const deletedMessage = document.createElement("p");
        deletedMessage.className = "adminReportImageDeleted";
        deletedMessage.textContent = "Comment deleted";
        reportedComment.replaceWith(deletedMessage);
        adminStatus.textContent = `Comment from report #${report.id} deleted.`;
    } catch (error) {
        button.disabled = false;
        adminStatus.textContent = error.message || "Could not delete the comment.";
    }
}

function reviewReport(report) {
    return runReportAction(report, "Marking", "/review", "POST");
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

    adminStatus.textContent = `Deleting ${image.filename}...`;
    try {
        await readAdminResponse(await fetch(
            `/admin/images/${encodeURIComponent(image.storage_id)}`,
            {
                method: "DELETE",
                headers: { "X-CSRF-Token": csrfToken },
            }
        ));
        card.remove();
        if (!adminImages.querySelector(".adminImage")) {
            displayAdminImages([]);
        }
        adminStatus.textContent = "Image deleted.";
    } catch (error) {
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
