import { PublicKey } from "@solana/web3.js";

import type { AlertEventType, AlertFilters } from "./utils";
import {
  cloneAlertFilters,
  describeAlertFilters,
  formatLamports,
  parseAlertEventTypes,
  parsePlatformFilter,
  parseSolToLamports,
  SocialPlatform,
} from "./utils";

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramMessage {
  message_id: number;
  text?: string;
  chat: {
    id: number;
    type: string;
  };
}

interface TelegramCallbackQuery {
  id: string;
  data?: string;
  message?: TelegramMessage;
}

interface TelegramGetUpdatesResponse {
  ok: boolean;
  result: TelegramUpdate[];
}

interface TelegramControlOptions {
  botToken?: string;
  allowedChatId?: string;
  getFilters: () => AlertFilters;
  setFilters: (filters: AlertFilters) => Promise<void>;
}

const ALL_EVENTS: AlertEventType[] = [
  "claim",
  "create",
  "update",
  "transfer",
  "revoke",
  "reset",
];

const MIN_CLAIM_PRESETS: Array<bigint | undefined> = [
  undefined,
  100_000_000n,
  500_000_000n,
  1_000_000_000n,
];

export class TelegramControlBot {
  private running = false;
  private offset = 0;
  private loopPromise: Promise<void> | null = null;
  private draftFilters: AlertFilters | null = null;

  constructor(private readonly options: TelegramControlOptions) {}

  start(): void {
    if (!this.options.botToken || !this.options.allowedChatId || this.running) {
      return;
    }

    this.running = true;
    this.loopPromise = this.pollLoop().catch((error) => {
      console.error("Telegram control loop failed", error);
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loopPromise;
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const payload = await this.callTelegram<TelegramGetUpdatesResponse>("getUpdates", {
          offset: this.offset,
          timeout: 25,
          allowed_updates: ["message", "callback_query"],
        });

        for (const update of payload.result) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          await this.handleUpdate(update);
        }
      } catch (error) {
        if (this.running && !isExpectedPollingTimeout(error)) {
          console.warn(`Telegram control polling retry: ${toErrorSummary(error)}`);
        }
        await sleep(3_000);
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.message) {
      await this.handleMessage(update.message);
      return;
    }

    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
    }
  }

  private async handleMessage(message: TelegramMessage): Promise<void> {
    if (String(message.chat.id) !== this.options.allowedChatId) {
      return;
    }

    const text = message.text?.trim();
    if (!text) {
      return;
    }

    try {
      if (text.startsWith("/start") || text.startsWith("/settings")) {
        this.resetDraft();
        await this.sendSettingsPanel();
        return;
      }

      if (text.startsWith("/help")) {
        await this.sendMessage(this.renderHelp());
        return;
      }

      if (text.startsWith("/status")) {
        await this.sendMessage(this.renderCurrentFilters());
        return;
      }

      if (text.startsWith("/filters")) {
        const reply = await this.handleFiltersCommand(text);
        await this.sendMessage(reply);
      }
    } catch (error) {
      await this.sendMessage(
        `⚠️ <b>FILTER COMMAND ERROR</b>\n${escapeHtml(error instanceof Error ? error.message : String(error))}`,
      );
    }
  }

  private async handleCallback(callback: TelegramCallbackQuery): Promise<void> {
    const message = callback.message;
    if (!message || String(message.chat.id) !== this.options.allowedChatId) {
      return;
    }

    const data = callback.data ?? "";
    try {
      switch (true) {
        case data === "settings:refresh":
          this.resetDraft();
          await this.answerCallbackQuery(callback.id, "Draft reset to current live settings");
          await this.sendSettingsPanel(message.message_id);
          return;

        case data === "settings:save":
          await this.saveDraft();
          await this.answerCallbackQuery(callback.id, "Settings saved");
          await this.sendSettingsPanel(message.message_id);
          return;

        case data === "settings:pause":
          await this.updateFilters((filters) => {
            filters.paused = !filters.paused;
          });
          await this.answerCallbackQuery(callback.id, "Draft updated. Tap Save to apply.");
          await this.sendSettingsPanel(message.message_id);
          return;

        case data === "settings:min_claim":
          await this.updateFilters((filters) => {
            const index = MIN_CLAIM_PRESETS.findIndex((preset) => preset === filters.minClaimLamports);
            const nextIndex = index >= 0 ? (index + 1) % MIN_CLAIM_PRESETS.length : 0;
            filters.minClaimLamports = MIN_CLAIM_PRESETS[nextIndex];
          });
          await this.answerCallbackQuery(callback.id, "Draft updated. Tap Save to apply.");
          await this.sendSettingsPanel(message.message_id);
          return;

        case data === "settings:platform:all":
          await this.updateFilters((filters) => {
            filters.platforms = undefined;
          });
          await this.answerCallbackQuery(callback.id, "Draft updated. Tap Save to apply.");
          await this.sendSettingsPanel(message.message_id);
          return;

        case data === "settings:platform:github":
          await this.updateFilters((filters) => {
            filters.platforms = new Set([SocialPlatform.GitHub]);
          });
          await this.answerCallbackQuery(callback.id, "Draft updated. Tap Save to apply.");
          await this.sendSettingsPanel(message.message_id);
          return;

        case data === "settings:platform:x":
          await this.updateFilters((filters) => {
            filters.platforms = new Set([SocialPlatform.X]);
          });
          await this.answerCallbackQuery(callback.id, "Draft updated. Tap Save to apply.");
          await this.sendSettingsPanel(message.message_id);
          return;

        case data.startsWith("settings:event:"):
          await this.toggleEventFilter(data.slice("settings:event:".length) as AlertEventType);
          await this.answerCallbackQuery(callback.id, "Draft updated. Tap Save to apply.");
          await this.sendSettingsPanel(message.message_id);
          return;

        case data === "settings:bonded":
          await this.answerCallbackQuery(callback.id, "Bonded alerts are not implemented in this bot yet.");
          return;

        case data === "settings:migrated":
          await this.answerCallbackQuery(callback.id, "Migrated alerts are not implemented in this bot yet.");
          return;

        default:
          await this.answerCallbackQuery(callback.id, "Unknown action");
      }
    } catch (error) {
      await this.answerCallbackQuery(
        callback.id,
        shortenCallbackText(error instanceof Error ? error.message : String(error)),
      );
    }
  }

  private async handleFiltersCommand(text: string): Promise<string> {
    const tokens = text.trim().split(/\s+/);

    if (tokens.length === 1 || tokens[1]?.toLowerCase() === "help") {
      return this.renderHelp();
    }

    const action = tokens[1]!.toLowerCase();

    if (action === "show") {
      return this.renderCurrentFilters();
    }

    if (action === "reset") {
      await this.options.setFilters({});
      return this.renderConfirmation("Filters reset. All alerts are enabled again.");
    }

    if (action === "events") {
      const next = cloneAlertFilters(this.options.getFilters());
      next.eventTypes = parseAlertEventTypes(tokens.slice(2).join(" "));
      await this.options.setFilters(next);
      return this.renderConfirmation("Updated event type filter.");
    }

    if (action === "platforms") {
      const next = cloneAlertFilters(this.options.getFilters());
      next.platforms = parsePlatformFilter(tokens.slice(2).join(" "));
      await this.options.setFilters(next);
      return this.renderConfirmation("Updated social platform filter.");
    }

    if (action === "min_claim") {
      const value = tokens[2];
      if (!value) {
        throw new Error("Usage: /filters min_claim <SOL amount>");
      }
      const next = cloneAlertFilters(this.options.getFilters());
      next.minClaimLamports = parseSolToLamports(value);
      await this.options.setFilters(next);
      return this.renderConfirmation(`Updated minimum claim alert threshold to ${value} SOL.`);
    }

    if (action === "clear") {
      const target = tokens[2]?.toLowerCase();
      if (!target) {
        throw new Error("Usage: /filters clear <events|platforms|min_claim|mint_allow|mint_block>");
      }
      const next = cloneAlertFilters(this.options.getFilters());
      switch (target) {
        case "events":
          next.eventTypes = undefined;
          break;
        case "platforms":
          next.platforms = undefined;
          break;
        case "min_claim":
          next.minClaimLamports = undefined;
          break;
        case "mint_allow":
          next.mintAllowlist = undefined;
          break;
        case "mint_block":
          next.mintBlocklist = undefined;
          break;
        default:
          throw new Error(`Unknown clear target "${target}"`);
      }
      await this.options.setFilters(next);
      return this.renderConfirmation(`Cleared ${target} filter.`);
    }

    if (action === "mint_allow" || action === "mint_block") {
      const mode = tokens[2]?.toLowerCase();
      const mints = parseMintList(tokens.slice(3).join(" "));
      if (!mode || mints.length === 0) {
        throw new Error(`Usage: /filters ${action} <add|remove|set> <mint1,mint2,...>`);
      }
      const next = cloneAlertFilters(this.options.getFilters());
      const key = action === "mint_allow" ? "mintAllowlist" : "mintBlocklist";
      const set = new Set(next[key] ?? []);
      if (mode === "set") {
        next[key] = new Set(mints);
      } else if (mode === "add") {
        for (const mint of mints) {
          set.add(mint);
        }
        next[key] = set;
      } else if (mode === "remove") {
        for (const mint of mints) {
          set.delete(mint);
        }
        next[key] = set.size > 0 ? set : undefined;
      } else {
        throw new Error(`Unknown ${action} mode "${mode}"`);
      }
      await this.options.setFilters(next);
      return this.renderConfirmation(`Updated ${action} filter.`);
    }

    throw new Error(`Unknown /filters subcommand "${action}"`);
  }

  private async toggleEventFilter(eventType: AlertEventType): Promise<void> {
    await this.updateFilters((filters) => {
      const eventSet = new Set(filters.eventTypes ?? ALL_EVENTS);
      if (eventSet.has(eventType)) {
        eventSet.delete(eventType);
      } else {
        eventSet.add(eventType);
      }
      filters.eventTypes = eventSet.size === ALL_EVENTS.length ? undefined : eventSet;
    });
  }

  private async updateFilters(mutator: (filters: AlertFilters) => void): Promise<void> {
    const next = cloneAlertFilters(this.getPanelFilters());
    mutator(next);
    this.draftFilters = next;
  }

  private resetDraft(): void {
    this.draftFilters = cloneAlertFilters(this.options.getFilters());
  }

  private async saveDraft(): Promise<void> {
    const next = cloneAlertFilters(this.getPanelFilters());
    await this.options.setFilters(next);
    this.resetDraft();
  }

  private getPanelFilters(): AlertFilters {
    return this.draftFilters ?? cloneAlertFilters(this.options.getFilters());
  }

  private async sendSettingsPanel(editMessageId?: number): Promise<void> {
    const text = this.renderSettingsPanel();
    const replyMarkup = {
      inline_keyboard: buildSettingsKeyboard(this.getPanelFilters()),
    };

    if (editMessageId) {
      await this.callTelegram("editMessageText", {
        chat_id: this.options.allowedChatId,
        message_id: editMessageId,
        text,
        parse_mode: "HTML",
        reply_markup: replyMarkup,
        disable_web_page_preview: true,
      });
      return;
    }

    await this.callTelegram("sendMessage", {
      chat_id: this.options.allowedChatId,
      text,
      parse_mode: "HTML",
      reply_markup: replyMarkup,
      disable_web_page_preview: true,
    });
  }

  private renderSettingsPanel(): string {
    const filters = this.getPanelFilters();
    const liveFilters = this.options.getFilters();
    const hasUnsavedChanges = !alertFiltersEqual(filters, liveFilters);
    return [
      "⚙️ <b>Settings Panel</b>",
      `Draft Status: ${filters.paused ? "⏸ Paused" : "▶️ Running"}`,
      `Live Status: ${liveFilters.paused ? "⏸ Paused" : "▶️ Running"}`,
      `Alerts: ${escapeHtml(renderEnabledEvents(filters))}`,
      `Platforms: ${escapeHtml(renderPlatforms(filters))}`,
      `Min Claim: ${escapeHtml(filters.minClaimLamports != null ? formatLamports(filters.minClaimLamports) : "off")}`,
      `Mint Allowlist: ${filters.mintAllowlist?.size ?? 0}`,
      `Mint Blocklist: ${filters.mintBlocklist?.size ?? 0}`,
      `Unsaved Changes: ${hasUnsavedChanges ? "Yes" : "No"}`,
      "",
      "Buttons only change the draft.",
      "Tap Save to apply the draft to the running bot.",
      "Use <code>/filters mint_allow ...</code> and <code>/filters mint_block ...</code> for exact mint lists.",
      "Bonded / Migrated buttons are placeholders until those monitors are added.",
    ].join("\n");
  }

  private renderHelp(): string {
    return [
      "⚙️ <b>FILTER CONTROLS</b>",
      "",
      ...renderFilterLines(this.options.getFilters()),
      "",
      "<b>Panel</b>",
      "<code>/start</code>",
      "<code>/settings</code>",
      "<code>/status</code>",
      "",
      "<b>Text Commands</b>",
      "<code>/filters show</code>",
      "<code>/filters reset</code>",
      "<code>/filters events claim,create,revoke</code>",
      "<code>/filters platforms github,x</code>",
      "<code>/filters min_claim 0.5</code>",
      "<code>/filters clear events</code>",
      "<code>/filters clear platforms</code>",
      "<code>/filters clear min_claim</code>",
      "<code>/filters mint_allow add &lt;mint&gt;</code>",
      "<code>/filters mint_allow remove &lt;mint&gt;</code>",
      "<code>/filters mint_allow set &lt;mint1,mint2&gt;</code>",
      "<code>/filters mint_block add &lt;mint&gt;</code>",
      "<code>/filters mint_block remove &lt;mint&gt;</code>",
    ].join("\n");
  }

  private renderCurrentFilters(): string {
    return [
      "📋 <b>CURRENT FILTERS</b>",
      "",
      ...renderFilterLines(this.options.getFilters()),
    ].join("\n");
  }

  private renderConfirmation(message: string): string {
    return [
      `✅ <b>${escapeHtml(message)}</b>`,
      "",
      ...renderFilterLines(this.options.getFilters()),
    ].join("\n");
  }

  private async sendMessage(text: string): Promise<void> {
    await this.callTelegram("sendMessage", {
      chat_id: this.options.allowedChatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  }

  private async answerCallbackQuery(callbackQueryId: string, text: string): Promise<void> {
    await this.callTelegram("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text: shortenCallbackText(text),
      show_alert: false,
    });
  }

  private async callTelegram<T = unknown>(method: string, body: Record<string, unknown>): Promise<T> {
    const timeoutMs = method === "getUpdates" ? 35_000 : 15_000;
    const response = await fetch(
      `https://api.telegram.org/bot${this.options.botToken}/${method}`,
      {
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      const payload = await response.text();
      throw new Error(`${method} failed: ${response.status} ${payload}`);
    }

    return (await response.json()) as T;
  }
}

function buildSettingsKeyboard(filters: AlertFilters): Array<Array<{ text: string; callback_data: string }>> {
  return [
    [
      eventButton("Claims", "claim", filters),
      eventButton("Config Created", "create", filters),
      eventButton("Shares Updated", "update", filters),
    ],
    [
      eventButton("Authority Transfer", "transfer", filters),
      eventButton("Config Locked", "revoke", filters),
      eventButton("Config Reset", "reset", filters),
    ],
    [
      platformButton("All", "all", !filters.platforms),
      platformButton("GitHub", "github", filters.platforms?.has(SocialPlatform.GitHub) ?? false),
      platformButton("X", "x", filters.platforms?.has(SocialPlatform.X) ?? false),
    ],
    [
      {
        text: `Min Claim: ${renderMinClaimPreset(filters.minClaimLamports)}`,
        callback_data: "settings:min_claim",
      },
    ],
    [
      {
        text: "💾 Save",
        callback_data: "settings:save",
      },
      {
        text: "🔄 Reload",
        callback_data: "settings:refresh",
      },
    ],
    [
      {
        text: filters.paused ? "▶️ Resume" : "⏸ Pause",
        callback_data: "settings:pause",
      },
    ],
    [
      {
        text: "🚧 Bonded",
        callback_data: "settings:bonded",
      },
      {
        text: "🚧 Migrated",
        callback_data: "settings:migrated",
      },
    ],
  ];
}

function eventButton(label: string, eventType: AlertEventType, filters: AlertFilters): { text: string; callback_data: string } {
  return {
    text: `${isEventEnabled(filters, eventType) ? "✅" : "⚪"} ${label}`,
    callback_data: `settings:event:${eventType}`,
  };
}

function platformButton(label: string, value: "all" | "github" | "x", active: boolean): { text: string; callback_data: string } {
  return {
    text: `${active ? "✅" : "⚪"} ${label}`,
    callback_data: `settings:platform:${value}`,
  };
}

function isEventEnabled(filters: AlertFilters, eventType: AlertEventType): boolean {
  return !filters.eventTypes || filters.eventTypes.has(eventType);
}

function renderEnabledEvents(filters: AlertFilters): string {
  if (!filters.eventTypes) {
    return "all supported alerts";
  }
  if (filters.eventTypes.size === 0) {
    return "none";
  }
  return [...filters.eventTypes].join(", ");
}

function renderPlatforms(filters: AlertFilters): string {
  if (!filters.platforms || filters.platforms.size === 0) {
    return "all";
  }
  return [...filters.platforms].map((platform) => {
    switch (platform) {
      case SocialPlatform.GitHub:
        return "GitHub";
      case SocialPlatform.X:
        return "X";
      case SocialPlatform.Pump:
        return "Pump";
      default:
        return String(platform);
    }
  }).join(", ");
}

function renderMinClaimPreset(value: bigint | undefined): string {
  if (value == null) {
    return "Off";
  }
  return formatLamports(value);
}

function alertFiltersEqual(left: AlertFilters, right: AlertFilters): boolean {
  return (
    left.paused === right.paused &&
    setEquals(left.eventTypes, right.eventTypes) &&
    setEquals(left.platforms, right.platforms) &&
    setEquals(left.mintAllowlist, right.mintAllowlist) &&
    setEquals(left.mintBlocklist, right.mintBlocklist) &&
    left.minClaimLamports === right.minClaimLamports
  );
}

function renderFilterLines(filters: AlertFilters): string[] {
  return describeAlertFilters(filters).map((line) => escapeHtml(line));
}

function parseMintList(input: string): string[] {
  return input
    .split(/[\s,]+/)
    .map((mint) => mint.trim())
    .filter(Boolean)
    .map((mint) => new PublicKey(mint).toBase58());
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function setEquals<T>(left?: Set<T>, right?: Set<T>): boolean {
  if (!left && !right) {
    return true;
  }
  if (!left || !right || left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}

function shortenCallbackText(value: string): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= 120) {
    return singleLine;
  }
  return `${singleLine.slice(0, 117)}...`;
}

function toErrorSummary(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isExpectedPollingTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.name === "TimeoutError" ||
    error.name === "AbortError" ||
    error.message.includes("aborted due to timeout")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
