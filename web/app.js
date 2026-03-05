// ─── CLIPilot Chat UI ──────────────────────────────

let messagesEl;
let executionCardsEl;
let inputEl;
let sendBtn;
let statusDot;
let statusText;
let dropdownEl;

let ws = null;
let currentAssistantEl = null;
let reconnectTimer = null;
let agentState = "idle";
let commands = [];
let activeIndex = -1;
let isDropdownOpen = false;
const executionRuns = new Map();

const ANSI_STYLES = {
	30: "color:#1f2430",
	31: "color:#ef5350",
	32: "color:#8bc34a",
	33: "color:#ffca28",
	34: "color:#64b5f6",
	35: "color:#ba68c8",
	36: "color:#4dd0e1",
	37: "color:#f5f5f5",
	90: "color:#90a4ae",
	91: "color:#ff8a80",
	92: "color:#ccff90",
	93: "color:#ffe082",
	94: "color:#82b1ff",
	95: "color:#ea80fc",
	96: "color:#84ffff",
	97: "color:#ffffff",
	40: "background-color:#1f2430",
	41: "background-color:#b71c1c",
	42: "background-color:#33691e",
	43: "background-color:#f57f17",
	44: "background-color:#0d47a1",
	45: "background-color:#4a148c",
	46: "background-color:#006064",
	47: "background-color:#cfd8dc",
};

export function escapeHtml(text) {
	return String(text)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

export function renderMarkdown(text) {
	let html = escapeHtml(text);
	html = html.replace(/```(\w*)\n([\s\S]*?)```/g, function (_match, _lang, code) {
		return "<pre><code>" + code.trim() + "</code></pre>";
	});
	html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
	html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
	return html;
}

function styleStateToString(state) {
	return Object.values(state).filter(Boolean).join(";");
}

function applyAnsiCodes(codes, state) {
	for (const rawCode of codes) {
		const code = Number.parseInt(rawCode || "0", 10);
		if (code === 0) {
			state.color = "";
			state.background = "";
			state.weight = "";
			continue;
		}
		if (code === 1) {
			state.weight = "font-weight:700";
			continue;
		}
		if (ANSI_STYLES[code]) {
			if (code >= 40 && code <= 47) {
				state.background = ANSI_STYLES[code];
			} else {
				state.color = ANSI_STYLES[code];
			}
		}
	}
}

export function renderAnsiToHtml(text) {
	const ansiPattern = /\u001b\[([0-9;]*)m/g;
	const state = {
		color: "",
		background: "",
		weight: "",
	};

	let html = "";
	let cursor = 0;
	let match;

	while ((match = ansiPattern.exec(text)) !== null) {
		const chunk = text.slice(cursor, match.index);
		if (chunk) {
			const style = styleStateToString(state);
			const escaped = escapeHtml(chunk).replace(/\n/g, "<br>");
			html += style ? `<span style="${style}">${escaped}</span>` : escaped;
		}
		applyAnsiCodes(match[1].split(";"), state);
		cursor = ansiPattern.lastIndex;
	}

	const tail = text.slice(cursor);
	if (tail) {
		const style = styleStateToString(state);
		const escaped = escapeHtml(tail).replace(/\n/g, "<br>");
		html += style ? `<span style="${style}">${escaped}</span>` : escaped;
	}

	return html;
}

function stripAnsi(text) {
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function extractText(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter(function (b) { return b.type === "text"; })
			.map(function (b) { return b.text; })
			.join("");
	}
	return "";
}

export function mergeExecutionEventSnapshot(existing, event) {
	const next = existing
		? {
			...existing,
			toolName: event.toolName || existing.toolName,
			runId: event.runId || existing.runId,
		}
		: {
			runId: event.runId,
			toolName: event.toolName,
			createdAt: event.createdAt,
		};

	next.phase = event.phase;
	next.summary = event.summary ?? next.summary;
	next.workspace = event.workspace ?? next.workspace;
	next.pane = event.pane ?? next.pane;
	next.persistence = event.persistence
		? {
			memoryWrites: event.persistence.memoryWrites ?? [],
			sessionResumeId: event.persistence.sessionResumeId,
			sessionResumable: event.persistence.sessionResumable,
			conversationPersisted: event.persistence.conversationPersisted !== false,
		}
		: next.persistence;
	next.test = event.test ?? next.test;
	next.verification = event.verification ?? next.verification;
	next.updatedAt = event.createdAt;
	return next;
}

function phaseLabel(phase) {
	switch (phase) {
		case "planned":
			return "即将调用";
		case "settled":
			return "已完成";
		case "persisted":
			return "已持久化";
		default:
			return phase;
	}
}

function renderList(items, emptyText) {
	if (!items || items.length === 0) {
		return `<div class="execution-empty">${emptyText}</div>`;
	}

	return `<ul class="execution-list">${items
		.map(function (item) {
			return `<li>${escapeHtml(item)}</li>`;
		})
		.join("")}</ul>`;
}

function renderPersistence(snapshot) {
	if (!snapshot.persistence) return "";

	const parts = [];
	if (snapshot.persistence.memoryWrites.length > 0) {
		parts.push(`写入 memory: ${snapshot.persistence.memoryWrites.join(", ")}`);
	}

	if (snapshot.persistence.sessionResumable !== undefined) {
		parts.push(
			snapshot.persistence.sessionResumable && snapshot.persistence.sessionResumeId
				? `会话可恢复: ${snapshot.persistence.sessionResumeId}`
				: "会话恢复信息不可用",
		);
	}

	parts.push(snapshot.persistence.conversationPersisted ? "对话会持久化" : "对话未持久化");

	return `
		<section class="execution-section">
			<h3>持久化状态</h3>
			${renderList(parts, "暂无持久化信息")}
		</section>
	`;
}

function renderPane(snapshot) {
	if (!snapshot.pane) return "";
	const paneHtml = snapshot.pane.ansiContent
		? renderAnsiToHtml(snapshot.pane.ansiContent)
		: escapeHtml(stripAnsi(snapshot.pane.content)).replace(/\n/g, "<br>");

	return `
		<section class="execution-section">
			<h3>最近一次 Pane 片段</h3>
			<pre class="execution-pane">${paneHtml}</pre>
		</section>
	`;
}

export function buildExecutionCardMarkup(snapshot) {
	const workspace = snapshot.workspace;
	const changedFiles = workspace
		? workspace.available
			? renderList(workspace.changedFiles, "未发现工作区改动")
			: `<div class="execution-empty">改动文件暂不可用</div>`
		: `<div class="execution-empty">尚未收集工作区证据</div>`;
	const diffSummary =
		workspace && workspace.diffSummary && workspace.diffSummary.length > 0
			? renderList(workspace.diffSummary, "暂无 diff 摘要")
			: "";
	const testSummary = snapshot.test
		? `<div class="execution-meta-row"><span>测试结果</span><strong>${escapeHtml(snapshot.test.status)}</strong><em>${escapeHtml(snapshot.test.summary)}</em></div>`
		: "";
	const verificationSummary = snapshot.verification
		? `<div class="execution-meta-row"><span>验证状态</span><strong>${escapeHtml(snapshot.verification.status)}</strong><em>${escapeHtml(snapshot.verification.summary)}</em></div>`
		: "";
	const diffStatSummary =
		workspace && workspace.diffStat
			? `<div class="execution-meta-row"><span>Diff 统计</span><em>${escapeHtml(workspace.diffStat)}</em></div>`
			: "";

	return `
		<header class="execution-card-header">
			<div>
				<div class="execution-card-title">${escapeHtml(snapshot.toolName)}</div>
				${snapshot.summary ? `<div class="execution-card-summary">${escapeHtml(snapshot.summary)}</div>` : ""}
			</div>
			<span class="execution-badge phase-${escapeHtml(snapshot.phase)}">${escapeHtml(phaseLabel(snapshot.phase))}</span>
		</header>
		<section class="execution-section execution-meta">
			<div class="execution-meta-row">
				<span>目标目录</span>
				<code>${escapeHtml(workspace ? workspace.workingDir : "未知")}</code>
			</div>
			${diffStatSummary}
			${testSummary}
			${verificationSummary}
		</section>
		<section class="execution-section">
			<h3>改动文件</h3>
			${changedFiles}
		</section>
		${diffSummary ? `<section class="execution-section"><h3>Diff 摘要</h3>${diffSummary}</section>` : ""}
		${renderPersistence(snapshot)}
		${renderPane(snapshot)}
	`;
}

function renderExecutionCards() {
	if (!executionCardsEl) return;

	const snapshots = Array.from(executionRuns.values()).sort(function (a, b) {
		return (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0);
	});

	if (snapshots.length === 0) {
		executionCardsEl.innerHTML = '<div class="execution-empty-state">最近还没有执行证据。</div>';
		return;
	}

	executionCardsEl.innerHTML = "";
	for (const snapshot of snapshots) {
		const article = document.createElement("article");
		article.className = "execution-card";
		article.innerHTML = buildExecutionCardMarkup(snapshot);
		executionCardsEl.appendChild(article);
	}
}

function upsertExecutionCard(event) {
	const existing = executionRuns.get(event.runId);
	executionRuns.set(event.runId, mergeExecutionEventSnapshot(existing, event));
	renderExecutionCards();
}

function resetExecutionCards() {
	executionRuns.clear();
	renderExecutionCards();
}

function connect() {
	const protocol = location.protocol === "https:" ? "wss:" : "ws:";
	ws = new WebSocket(`${protocol}//${location.host}/ws`);

	ws.onopen = function () {
		setConnectionStatus("connected");
		loadHistory();
		loadExecutionEvents();
		fetchCommands();
	};

	ws.onmessage = function (event) {
		let data;
		try {
			data = JSON.parse(event.data);
		} catch {
			return;
		}
		handleServerMessage(data);
	};

	ws.onclose = function () {
		setConnectionStatus("disconnected");
		scheduleReconnect();
	};

	ws.onerror = function () {
		// onclose will fire after this
	};
}

function scheduleReconnect() {
	if (reconnectTimer) return;
	reconnectTimer = setTimeout(function () {
		reconnectTimer = null;
		connect();
	}, 3000);
}

function setConnectionStatus(status) {
	statusDot.className = "";
	if (status === "connected") {
		statusDot.classList.add(agentState);
		statusText.textContent = agentState === "idle" ? "空闲" : "执行中...";
	} else {
		statusDot.classList.add("disconnected");
		statusText.textContent = "连接断开，正在重连...";
	}
}

function loadHistory() {
	fetch("/api/history")
		.then(function (res) { return res.json(); })
		.then(function (messages) {
			messagesEl.innerHTML = "";
			currentAssistantEl = null;
			for (const msg of messages) {
				if (msg.role === "user") {
					const content = typeof msg.content === "string" ? msg.content : "[complex content]";
					if (content.startsWith("[HUMAN]") || content.startsWith("[RESUME]")) continue;
					addMessageBubble("user", content);
				} else if (msg.role === "assistant") {
					const text = extractText(msg.content);
					if (text) addMessageBubble("assistant", text);
				}
			}
			scrollToBottom();
		})
		.catch(function () {
			// Silently fail — history is optional
		});
}

function loadExecutionEvents() {
	fetch("/api/execution-events")
		.then(function (res) { return res.json(); })
		.then(function (events) {
			resetExecutionCards();
			for (const event of events) {
				upsertExecutionCard(event);
			}
		})
		.catch(function () {
			resetExecutionCards();
		});
}

function handleServerMessage(data) {
	switch (data.type) {
		case "assistant_delta":
			if (!currentAssistantEl) {
				currentAssistantEl = addMessageBubble("assistant", "");
			}
			currentAssistantEl.textContent += data.delta;
			scrollToBottom();
			break;

		case "assistant_done":
			if (currentAssistantEl) {
				currentAssistantEl.innerHTML = renderMarkdown(currentAssistantEl.textContent);
				currentAssistantEl = null;
			}
			break;

		case "agent_update":
			addMessageBubble("agent-update", data.summary);
			scrollToBottom();
			break;

		case "tool_activity":
			addMessageBubble("tool-activity", data.summary);
			scrollToBottom();
			break;

		case "execution_event":
			upsertExecutionCard(data.event);
			break;

		case "state":
			agentState = data.state;
			setConnectionStatus("connected");
			break;

		case "system":
			addMessageBubble("system", data.message);
			scrollToBottom();
			break;

		case "clear":
			messagesEl.innerHTML = "";
			currentAssistantEl = null;
			resetExecutionCards();
			break;
	}
}

function addMessageBubble(type, text) {
	const el = document.createElement("div");
	el.className = "msg " + type;

	if (type === "assistant" && text) {
		el.innerHTML = renderMarkdown(text);
	} else {
		el.textContent = text;
	}

	messagesEl.appendChild(el);
	return el;
}

function scrollToBottom() {
	requestAnimationFrame(function () {
		messagesEl.scrollTop = messagesEl.scrollHeight;
	});
}

function fetchCommands() {
	fetch("/api/commands")
		.then(function (res) { return res.json(); })
		.then(function (data) { commands = data; })
		.catch(function () { commands = []; });
}

function getFilteredCommands() {
	const text = inputEl.value;
	if (!text.startsWith("/")) return [];
	const query = text.slice(1).toLowerCase();
	return commands
		.filter(function (c) {
			return c.name.toLowerCase().startsWith(query) || c.name.toLowerCase().includes(query);
		})
		.sort(function (a, b) {
			const aStarts = a.name.toLowerCase().startsWith(query) ? 0 : 1;
			const bStarts = b.name.toLowerCase().startsWith(query) ? 0 : 1;
			if (aStarts !== bStarts) return aStarts - bStarts;
			if (a.category !== b.category) return a.category === "builtin" ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
}

function renderDropdown(filtered) {
	if (filtered.length === 0) {
		closeDropdown();
		return;
	}

	dropdownEl.innerHTML = "";
	for (let i = 0; i < filtered.length; i++) {
		const cmd = filtered[i];
		const item = document.createElement("div");
		item.className = "command-item" + (i === activeIndex ? " active" : "");
		item.dataset.index = String(i);
		item.dataset.name = cmd.name;

		const nameSpan = document.createElement("span");
		nameSpan.className = "command-name";
		nameSpan.textContent = "/" + cmd.name;

		const descSpan = document.createElement("span");
		descSpan.className = "command-desc";
		descSpan.textContent = cmd.description;

		const catSpan = document.createElement("span");
		catSpan.className = "command-category";
		catSpan.textContent = cmd.category;

		item.appendChild(nameSpan);
		item.appendChild(descSpan);
		item.appendChild(catSpan);
		item.addEventListener("click", function () {
			selectCommand(this.dataset.name);
		});

		dropdownEl.appendChild(item);
	}

	dropdownEl.classList.remove("hidden");
	isDropdownOpen = true;
}

function closeDropdown() {
	dropdownEl.classList.add("hidden");
	dropdownEl.innerHTML = "";
	isDropdownOpen = false;
	activeIndex = -1;
}

function selectCommand(name) {
	inputEl.value = "/" + name;
	closeDropdown();
	inputEl.focus();
	const cmd = commands.find(function (c) { return c.name === name; });
	if (cmd && cmd.category === "builtin") {
		sendMessage();
	}
}

function updateActiveItem(items) {
	for (let i = 0; i < items.length; i++) {
		items[i].classList.toggle("active", i === activeIndex);
	}
	if (activeIndex >= 0 && items[activeIndex]) {
		items[activeIndex].scrollIntoView({ block: "nearest" });
	}
}

function sendMessage() {
	const text = inputEl.value.trim();
	if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;

	closeDropdown();

	if (text.startsWith("/")) {
		const name = text.slice(1).split(/\s+/)[0];
		ws.send(JSON.stringify({ type: "command", name }));
	} else {
		ws.send(JSON.stringify({ type: "message", content: text }));
		addMessageBubble("user", text);
		scrollToBottom();
	}

	inputEl.value = "";
	inputEl.style.height = "auto";
}

function initDomReferences() {
	messagesEl = document.getElementById("messages");
	executionCardsEl = document.getElementById("execution-cards");
	inputEl = document.getElementById("input");
	sendBtn = document.getElementById("send-btn");
	statusDot = document.getElementById("status-dot");
	statusText = document.getElementById("status-text");
	dropdownEl = document.getElementById("command-dropdown");
}

function initApp() {
	initDomReferences();
	renderExecutionCards();

	document.addEventListener("click", function (e) {
		if (!dropdownEl.contains(e.target) && e.target !== inputEl) {
			closeDropdown();
		}
	});

	inputEl.addEventListener("keydown", function (e) {
		if (isDropdownOpen) {
			const items = dropdownEl.querySelectorAll(".command-item");

			if (e.key === "ArrowDown") {
				e.preventDefault();
				activeIndex = Math.min(activeIndex + 1, items.length - 1);
				updateActiveItem(items);
				return;
			}

			if (e.key === "ArrowUp") {
				e.preventDefault();
				activeIndex = Math.max(activeIndex - 1, 0);
				updateActiveItem(items);
				return;
			}

			if (e.key === "Enter" && !e.shiftKey && activeIndex >= 0) {
				e.preventDefault();
				selectCommand(items[activeIndex].dataset.name);
				return;
			}

			if (e.key === "Escape") {
				e.preventDefault();
				closeDropdown();
				return;
			}

			if (e.key === "Tab" && items.length > 0) {
				e.preventDefault();
				const idx = activeIndex >= 0 ? activeIndex : 0;
				selectCommand(items[idx].dataset.name);
				return;
			}
		}

		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			sendMessage();
		}
	});

	sendBtn.addEventListener("click", sendMessage);

	inputEl.addEventListener("input", function () {
		this.style.height = "auto";
		this.style.height = Math.min(this.scrollHeight, 120) + "px";

		if (this.value.startsWith("/")) {
			activeIndex = -1;
			renderDropdown(getFilteredCommands());
		} else {
			closeDropdown();
		}
	});

	connect();
}

if (typeof document !== "undefined") {
	initApp();
}
