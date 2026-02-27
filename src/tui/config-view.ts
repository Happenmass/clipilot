import chalk from "chalk";
import { getAllProviders, getProvider } from "../llm/providers/registry.js";
import type { CLIPilotConfig } from "../utils/config.js";
import { BoxComponent } from "./components/box.js";
import type { Component } from "./components/renderer.js";
import type { SelectItem } from "./components/select-list.js";
import { SelectListComponent } from "./components/select-list.js";
import { TextComponent } from "./components/text.js";
import { TextInputComponent } from "./components/text-input.js";

type ConfigMode = "list" | "submenu" | "textinput";

interface ConfigMenuItem {
	key: string;
	label: string;
	getValue: () => string;
	description: string;
	type: "submenu" | "cycle" | "text";
}

const AUTONOMY_LEVELS = ["low", "medium", "high", "full"];

export interface ConfigViewOptions {
	onSave?: (config: CLIPilotConfig) => void;
	onClose?: () => void;
}

export class ConfigView implements Component {
	private config: CLIPilotConfig;
	private mode: ConfigMode = "list";
	private selectedIndex = 0;
	private menuItems: ConfigMenuItem[];

	// Sub-components
	private selectList: SelectListComponent | null = null;
	private textInput: TextInputComponent | null = null;

	// Layout components
	private box: BoxComponent;
	private contentText: TextComponent;
	private hintText: TextComponent;

	// Callbacks
	private onSave: ((config: CLIPilotConfig) => void) | null;
	private onClose: (() => void) | null;

	private cached: string[] | null = null;

	constructor(config: CLIPilotConfig, options: ConfigViewOptions = {}) {
		this.config = { ...config, llm: { ...config.llm } };
		this.onSave = options.onSave ?? null;
		this.onClose = options.onClose ?? null;

		this.menuItems = this.buildMenuItems();

		this.box = new BoxComponent({
			title: "CLIPilot Configuration",
			borderStyle: "rounded",
			borderStyleFn: chalk.cyan,
			titleStyleFn: chalk.bold.cyan,
		});

		this.contentText = new TextComponent();
		this.hintText = new TextComponent("", chalk.dim);

		this.box.addChild(this.contentText);
		this.box.addChild(this.hintText);
	}

	private buildMenuItems(): ConfigMenuItem[] {
		return [
			{
				key: "provider",
				label: "Default Provider",
				getValue: () => this.config.llm.provider,
				description: "Configure the LLM provider for planning",
				type: "submenu",
			},
			{
				key: "model",
				label: "Model",
				getValue: () => this.config.llm.model,
				description: "Select the model to use",
				type: "submenu",
			},
			{
				key: "apiKey",
				label: "API Key",
				getValue: () => (this.config.llm.apiKey ? "********" : chalk.dim("(not set)")),
				description: "Set the API key for the current provider",
				type: "text",
			},
			{
				key: "autonomy",
				label: "Autonomy Level",
				getValue: () => this.config.autonomyLevel,
				description: "How much autonomy the agent has",
				type: "cycle",
			},
			{
				key: "agent",
				label: "Default Agent",
				getValue: () => this.config.defaultAgent,
				description: "The coding agent to use",
				type: "cycle",
			},
			{
				key: "baseUrl",
				label: "Base URL",
				getValue: () => this.config.llm.baseUrl || chalk.dim("(not set)"),
				description: "Custom API endpoint (optional)",
				type: "text",
			},
			{
				key: "debug",
				label: "Debug Mode",
				getValue: () => (this.config.debug ? chalk.green("ON") : chalk.dim("OFF")),
				description: "Log every MainAgent LLM response for debugging",
				type: "cycle",
			},
		];
	}

	handleInput(data: string): void {
		if (this.mode === "submenu" && this.selectList) {
			this.selectList.handleInput(data);
			this.cached = null;
			this.box.invalidate();
			return;
		}

		if (this.mode === "textinput" && this.textInput) {
			this.textInput.handleInput(data);
			this.cached = null;
			this.box.invalidate();
			return;
		}

		// List mode
		switch (data) {
			case "\x1b[A": // Up
			case "k":
				if (this.selectedIndex > 0) {
					this.selectedIndex--;
					this.cached = null;
					this.box.invalidate();
				}
				break;

			case "\x1b[B": // Down
			case "j":
				if (this.selectedIndex < this.menuItems.length - 1) {
					this.selectedIndex++;
					this.cached = null;
					this.box.invalidate();
				}
				break;

			case "\r": // Enter
				this.activateItem(this.menuItems[this.selectedIndex]);
				break;

			case "\x1b": // Esc
			case "q":
				this.onClose?.();
				break;
		}
	}

	private activateItem(item: ConfigMenuItem): void {
		switch (item.type) {
			case "submenu":
				this.openSubmenu(item.key);
				break;
			case "cycle":
				this.cycleValue(item.key);
				break;
			case "text":
				this.openTextInput(item.key);
				break;
		}
	}

	private openSubmenu(key: string): void {
		let items: SelectItem[];

		if (key === "provider") {
			items = getAllProviders().map((p) => ({
				value: p.name,
				label: p.displayName,
				description: p.baseUrl,
			}));
		} else if (key === "model") {
			const provider = getProvider(this.config.llm.provider);
			const models = provider?.models ?? [];
			items = models.map((m) => ({ value: m, label: m }));
			items.push({ value: "__custom__", label: "Custom..." });
		} else {
			return;
		}

		this.selectList = new SelectListComponent(items, {
			maxVisible: 8,
			onSelect: (selected) => {
				if (key === "provider") {
					this.config.llm.provider = selected.value;
					// Auto-switch to provider's default model
					const prov = getProvider(selected.value);
					if (prov) {
						this.config.llm.model = prov.defaultModel;
					}
				} else if (key === "model") {
					if (selected.value === "__custom__") {
						// Switch to text input for custom model
						this.mode = "list";
						this.selectList = null;
						this.openTextInput("customModel");
						return;
					}
					this.config.llm.model = selected.value;
				}
				this.mode = "list";
				this.selectList = null;
				this.cached = null;
				this.box.invalidate();
				this.onSave?.(this.config);
			},
			onCancel: () => {
				this.mode = "list";
				this.selectList = null;
				this.cached = null;
				this.box.invalidate();
			},
		});

		this.mode = "submenu";
		this.cached = null;
		this.box.invalidate();
	}

	private cycleValue(key: string): void {
		if (key === "autonomy") {
			const idx = AUTONOMY_LEVELS.indexOf(this.config.autonomyLevel);
			this.config.autonomyLevel = AUTONOMY_LEVELS[(idx + 1) % AUTONOMY_LEVELS.length];
		} else if (key === "agent") {
			// Currently only one agent
			this.config.defaultAgent = "claude-code";
		} else if (key === "debug") {
			this.config.debug = !this.config.debug;
		}
		this.cached = null;
		this.box.invalidate();
		this.onSave?.(this.config);
	}

	private openTextInput(key: string): void {
		let initialValue = "";
		let mask = false;
		let placeholder = "Enter value...";

		if (key === "apiKey") {
			mask = true;
			placeholder = "Enter API key...";
			initialValue = this.config.llm.apiKey ?? "";
		} else if (key === "baseUrl") {
			placeholder = "https://api.example.com/v1";
			initialValue = this.config.llm.baseUrl ?? "";
		} else if (key === "customModel") {
			placeholder = "Enter model name...";
			initialValue = this.config.llm.model;
		}

		this.textInput = new TextInputComponent({
			initialValue,
			mask,
			placeholder,
			onSubmit: (value) => {
				if (key === "apiKey") {
					this.config.llm.apiKey = value || undefined;
				} else if (key === "baseUrl") {
					this.config.llm.baseUrl = value || undefined;
				} else if (key === "customModel") {
					this.config.llm.model = value;
				}
				this.mode = "list";
				this.textInput = null;
				this.cached = null;
				this.box.invalidate();
				this.onSave?.(this.config);
			},
			onCancel: () => {
				this.mode = "list";
				this.textInput = null;
				this.cached = null;
				this.box.invalidate();
			},
		});

		this.mode = "textinput";
		this.cached = null;
		this.box.invalidate();
	}

	render(width: number): string[] {
		// Build content based on current mode
		const contentLines: string[] = [];

		if (this.mode === "list") {
			contentLines.push("");
			for (let i = 0; i < this.menuItems.length; i++) {
				const item = this.menuItems[i];
				const isSelected = i === this.selectedIndex;
				const prefix = isSelected ? " \u2192 " : "   ";
				const label = item.label.padEnd(20);
				const value = item.getValue();

				if (isSelected) {
					contentLines.push(prefix + chalk.bold(label) + value);
				} else {
					contentLines.push(prefix + label + chalk.dim(value));
				}
			}
			contentLines.push("");

			// Description of selected item
			const desc = this.menuItems[this.selectedIndex].description;
			contentLines.push("  " + chalk.dim(desc));
			contentLines.push("");

			this.hintText.setText("  \u2191\u2193 Navigate  Enter Change  Esc Close");
		} else if (this.mode === "submenu" && this.selectList) {
			contentLines.push("");
			const submenuTitle =
				this.menuItems[this.selectedIndex].key === "provider" ? "Select Provider:" : "Select Model:";
			contentLines.push("  " + chalk.bold(submenuTitle));
			contentLines.push("");
			contentLines.push(...this.selectList.render(width - 4));
			contentLines.push("");

			this.hintText.setText("  \u2191\u2193 Navigate  Enter Select  Esc Back");
		} else if (this.mode === "textinput" && this.textInput) {
			contentLines.push("");
			const inputLabel = this.menuItems[this.selectedIndex].label;
			contentLines.push("  " + chalk.bold(inputLabel + ":"));
			contentLines.push("");
			contentLines.push(...this.textInput.render(width - 4));
			contentLines.push("");

			this.hintText.setText("  Enter Submit  Esc Cancel");
		}

		this.contentText.setText(contentLines.join("\n"));
		this.box.invalidate();

		return this.box.render(width);
	}

	invalidate(): void {
		this.cached = null;
		this.box.invalidate();
	}
}
