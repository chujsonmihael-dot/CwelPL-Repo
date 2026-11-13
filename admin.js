const loginForm = document.getElementById("adminLogin");
const passwordInput = document.getElementById("adminPassword");
const adminStatus = document.getElementById("adminStatus");
const adminPanel = document.getElementById("adminPanel");
const adminImages = document.getElementById("adminImages");
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
    logoutButton.hidden = true;
    csrfToken = "";
    adminImages.replaceChildren();
}

function showAdmin() {
    loginForm.hidden = true;
    adminPanel.hidden = false;
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

async function loadAdminImages() {
    adminStatus.textContent = "Loading images...";

    try {
        const result = await readAdminResponse(await fetch("/admin/images"));
        csrfToken = result.csrf_token;
        displayAdminImages(result.images);
        showAdmin();
        adminStatus.textContent = "";
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
