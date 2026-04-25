// MCP Server Settings UI
(() => {
	const overlay = document.getElementById("settings-overlay");
	const modal = document.getElementById("settings-modal");
	const openBtn = document.getElementById("settings-btn");
	const closeBtn = document.getElementById("settings-close");
	const listEl = document.getElementById("mcp-list");
	const emptyEl = document.getElementById("mcp-empty");
	const addBtn = document.getElementById("mcp-add-btn");

	// Form elements
	const formEl = document.getElementById("mcp-form");
	const formTitle = document.getElementById("mcp-form-title");
	const formClose = document.getElementById("mcp-form-close");
	const formCancel = document.getElementById("mcp-form-cancel");
	const formSave = document.getElementById("mcp-form-save");
	const formError = document.getElementById("mcp-form-error");
	const fName = document.getElementById("mcp-f-name");
	const fDescription = document.getElementById("mcp-f-description");
	const fCommand = document.getElementById("mcp-f-command");
	const fArgs = document.getElementById("mcp-f-args");
	const fEnv = document.getElementById("mcp-f-env");
	const fType = document.getElementById("mcp-f-type");
	const fUrlGroup = document.getElementById("mcp-f-url-group");
	const fUrl = document.getElementById("mcp-f-url");

	let servers = {};
	let editingName = null; // null = adding, string = editing

	// ─── API helpers ─────────────────────────────────

	async function fetchServers() {
		try {
			const res = await fetch("/api/config/mcp-servers");
			if (res.ok) servers = await res.json();
		} catch {
			/* ignore */
		}
	}

	async function saveServers() {
		try {
			await fetch("/api/config/mcp-servers", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(servers),
			});
		} catch {
			/* ignore */
		}
	}

	// ─── Render ──────────────────────────────────────

	function render() {
		const names = Object.keys(servers);
		if (names.length === 0) {
			listEl.innerHTML = "";
			emptyEl.classList.remove("hidden");
			return;
		}
		emptyEl.classList.add("hidden");
		listEl.innerHTML = names
			.map((name) => {
				const s = servers[name];
				const detail = [s.command, ...(s.args || [])].join(" ");
				const descLine = s.description
					? `<div class="mcp-item-description">${esc(s.description)}</div>`
					: "";
				return `
				<div class="mcp-item" data-name="${esc(name)}">
					<div class="mcp-item-info">
						<div class="mcp-item-name">${esc(name)}</div>
						${descLine}
						<div class="mcp-item-detail">${esc(s.type)} &middot; ${esc(detail)}</div>
					</div>
					<div class="mcp-item-actions">
						<button class="mcp-edit-btn" data-name="${esc(name)}">Edit</button>
						<button class="mcp-del-btn" data-name="${esc(name)}">Delete</button>
					</div>
				</div>`;
			})
			.join("");
	}

	function esc(s) {
		const el = document.createElement("span");
		el.textContent = s;
		return el.innerHTML;
	}

	// ─── Modal open/close ────────────────────────────

	function openModal() {
		fetchServers().then(() => {
			render();
			overlay.classList.remove("hidden");
			hideForm();
		});
	}

	function closeModal() {
		overlay.classList.add("hidden");
		hideForm();
	}

	openBtn.addEventListener("click", openModal);
	closeBtn.addEventListener("click", closeModal);

	// Close on backdrop click
	overlay.addEventListener("click", (e) => {
		if (e.target === overlay) closeModal();
	});

	// Close on Escape
	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape" && !overlay.classList.contains("hidden")) {
			e.stopPropagation();
			closeModal();
		}
	});

	// ─── Form ────────────────────────────────────────

	function showForm(name) {
		editingName = name || null;
		formTitle.textContent = editingName ? "Edit MCP Server" : "Add MCP Server";
		formError.textContent = "";
		if (editingName && servers[editingName]) {
			const s = servers[editingName];
			fName.value = editingName;
			fName.disabled = true;
			fDescription.value = s.description || "";
			fCommand.value = s.command || "";
			fArgs.value = (s.args || []).join(", ");
			fEnv.value = Object.entries(s.env || {})
				.map(([k, v]) => `${k}=${v}`)
				.join("\n");
			fType.value = s.type || "stdio";
			fUrl.value = s.url || "";
		} else {
			fName.value = "";
			fName.disabled = false;
			fDescription.value = "";
			fCommand.value = "";
			fArgs.value = "";
			fEnv.value = "";
			fType.value = "stdio";
			fUrl.value = "";
		}
		updateUrlVisibility();
		formEl.classList.remove("hidden");
	}

	function hideForm() {
		formEl.classList.add("hidden");
		editingName = null;
	}

	function updateUrlVisibility() {
		if (fType.value === "sse") {
			fUrlGroup.classList.remove("hidden");
		} else {
			fUrlGroup.classList.add("hidden");
		}
	}

	fType.addEventListener("change", updateUrlVisibility);
	addBtn.addEventListener("click", () => showForm(null));
	formClose.addEventListener("click", hideForm);
	formCancel.addEventListener("click", hideForm);

	formSave.addEventListener("click", () => {
		const name = fName.value.trim();
		const command = fCommand.value.trim();
		const type = fType.value;

		if (!name) {
			formError.textContent = "Name is required.";
			return;
		}
		if (!command) {
			formError.textContent = "Command is required.";
			return;
		}
		if (!editingName && servers[name]) {
			formError.textContent = `Server "${name}" already exists.`;
			return;
		}

		const entry = { command, type };

		const description = fDescription.value.trim();
		if (description) {
			entry.description = description;
		}

		const argsStr = fArgs.value.trim();
		if (argsStr) {
			entry.args = argsStr.split(",").map((a) => a.trim()).filter(Boolean);
		}

		const envStr = fEnv.value.trim();
		if (envStr) {
			const env = {};
			for (const line of envStr.split("\n")) {
				const eq = line.indexOf("=");
				if (eq > 0) {
					env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
				}
			}
			if (Object.keys(env).length > 0) entry.env = env;
		}

		if (type === "sse" && fUrl.value.trim()) {
			entry.url = fUrl.value.trim();
		}

		servers[name] = entry;
		saveServers().then(() => {
			render();
			hideForm();
		});
	});

	// ─── List click delegation ───────────────────────

	listEl.addEventListener("click", (e) => {
		const editBtn = e.target.closest(".mcp-edit-btn");
		if (editBtn) {
			showForm(editBtn.dataset.name);
			return;
		}
		const delBtn = e.target.closest(".mcp-del-btn");
		if (delBtn) {
			const name = delBtn.dataset.name;
			if (confirm(`Delete MCP server "${name}"?`)) {
				delete servers[name];
				saveServers().then(render);
			}
		}
	});
})();
