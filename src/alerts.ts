import {
  formatLamports,
  type NormalizedShareholder,
  SocialPlatform,
} from "./utils";
import type { ClaimDetection } from "./accountWatcher";

export interface GovernanceAlert {
  tokenMint: string;
  event: string;
  meaning?: string;
  signature?: string;
  timestamp: string;
  details: string[];
}

interface TelegramInlineKeyboardButton {
  text: string;
  url: string;
}

interface TelegramInlineKeyboardMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}

export class AlertService {
  constructor(
    private readonly telegramBotToken?: string,
    private readonly telegramChatIds: string[] = [],
  ) {}

  async sendGovernanceAlert(alert: GovernanceAlert): Promise<void> {
    const lines = [
      formatGovernanceHeadline(alert.event),
    ];

    if (alert.meaning) {
      lines.push(`<i>${escapeHtml(alert.meaning)}</i>`);
    }

    lines.push("");
    lines.push(copyableField("🪙 Mint CA", alert.tokenMint));
    lines.push(...alert.details);
    lines.push(textField("🕒 Time", formatCompactTimestamp(alert.timestamp)));

    await this.sendMessage(lines.join("\n"), true, buildGovernanceKeyboard(alert));
  }

  async sendSocialClaimAlert(claim: ClaimDetection): Promise<void> {
    if (claim.platform === SocialPlatform.GitHub) {
      await this.sendGitHubClaimAlert(claim);
      return;
    }

    const mintLines =
      claim.relatedMints.length === 0
        ? [textField("Mint CA", "unknown")]
        : claim.relatedMints.map((mint, index) =>
            copyableField(index === 0 ? "Mint CA" : `Mint CA ${index + 1}`, mint),
          );

    const lines = [
      "💰 <b>SOCIAL FEE CLAIM DETECTED</b>",
      `<b>Platform</b>: ${escapeHtml(claim.platformLabel)}`,
      "<b>Meaning</b>: A tracked social recipient PDA balance decreased, indicating fees were claimed.",
      "",
      ...mintLines,
      copyableField("Social PDA", claim.socialPda),
      textField("Social User ID", claim.userId),
      textField("Claim Amount", formatLamports(claim.claimedLamports)),
      claim.recipient
        ? copyableField("Recipient Wallet", claim.recipient)
        : textField("Recipient Wallet", "unknown"),
      textField("Previous PDA Balance", formatLamports(claim.previousBalanceLamports)),
      textField("Current PDA Balance", formatLamports(claim.currentBalanceLamports)),
      textField("Slot", String(claim.slot)),
      ...(claim.signature ? [copyableField("Signature", claim.signature)] : []),
      textField("Time", claim.timestamp),
    ];

    await this.sendMessage(lines.join("\n"), true);
  }

  private async sendGitHubClaimAlert(claim: ClaimDetection): Promise<void> {
    const headline = claim.firstObservedForSingleMint || claim.firstObservedForPda
      ? "🆕 <b>GitHub Fee Claim</b>"
      : "🐙 <b>GitHub Fee Claim</b>";
    const accountLabel = claim.githubProfile
      ? `@${claim.githubProfile.login}${claim.githubProfile.name ? ` (${claim.githubProfile.name})` : ""}`
      : `GitHub user ${claim.userId}`;

    const lines = [
      headline,
      `🟢 <b>${escapeHtml(accountLabel)}</b> claimed <b>${escapeHtml(formatLamports(claim.claimedLamports))}</b>`,
      "",
      ...buildCompactMintLines(claim.relatedMints),
      "",
      claim.recipient
        ? textField("👛 Wallet", claim.recipient)
        : textField("👛 Recipient Wallet", "unknown"),
      textField("🏦 PDA", claim.socialPda),
      textField("⏱️ Slot", String(claim.slot)),
      textField("🕒 Time", formatCompactTimestamp(claim.timestamp)),
    ];

    await this.sendMessage(lines.join("\n"), true, buildGitHubClaimKeyboard(claim));
  }

  async sendStartupNotice(message: string): Promise<void> {
    await this.sendMessage(message ? `🟢 BOT STARTED\n${message}` : "🟢 BOT STARTED");
  }

  async sendError(message: string): Promise<void> {
    await this.sendMessage(`⚠️ BOT ERROR\n${message}`);
  }

  async sendMessage(
    text: string,
    html = false,
    replyMarkup?: TelegramInlineKeyboardMarkup,
  ): Promise<void> {
    console.log(`\n${text}\n`);

    if (!this.telegramBotToken || this.telegramChatIds.length === 0) {
      return;
    }

    const failures: string[] = [];
    let successCount = 0;
    for (const chatId of this.telegramChatIds) {
      const response = await fetch(
        `https://api.telegram.org/bot${this.telegramBotToken}/sendMessage`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: html ? "HTML" : undefined,
            disable_web_page_preview: true,
            reply_markup: replyMarkup,
          }),
        },
      );

      if (!response.ok) {
        const body = await response.text();
        failures.push(`${chatId}: ${response.status} ${body}`);
        continue;
      }

      successCount += 1;
    }

    if (successCount === 0 && failures.length > 0) {
      throw new Error(`Telegram sendMessage failed for ${failures.join(" | ")}`);
    }

    if (failures.length > 0) {
      console.warn(`Telegram sendMessage partial failure for ${failures.join(" | ")}`);
    }
  }
}

export function buildCreateAlertDetails(params: {
  sharingConfig: string;
  admin: string;
  shareholders: NormalizedShareholder[];
}): string[] {
  return [
    textField("⚙️ Config", params.sharingConfig),
    textField("👤 Admin", params.admin),
    ...compactShareholderDetailLines("👥 Shareholders", params.shareholders),
  ];
}

export function buildUpdateAlertDetails(params: {
  sharingConfig: string;
  admin: string;
  shareholders: NormalizedShareholder[];
}): string[] {
  return [
    textField("⚙️ Config", params.sharingConfig),
    textField("👤 Admin", params.admin),
    ...compactShareholderDetailLines("👥 Recipients", params.shareholders),
  ];
}

export function copyableField(label: string, value: string): string {
  return `<b>${escapeHtml(label)}</b>\n<code>${escapeHtml(value)}</code>`;
}

export function inlineCodeField(label: string, value: string): string {
  return `<b>${escapeHtml(label)}</b>: <code>${escapeHtml(value)}</code>`;
}

export function textField(label: string, value: string): string {
  return `<b>${escapeHtml(label)}</b>: ${escapeHtml(value)}`;
}

export function shareholderDetailLines(
  label: string,
  shareholders: NormalizedShareholder[],
): string[] {
  if (shareholders.length === 0) {
    return [textField(label, "none")];
  }

  const lines = [`<b>${escapeHtml(label)}</b>`];
  for (const shareholder of shareholders) {
    const descriptor = shareholder.isSocial
      ? shareholder.platformLabel === "GitHub" && shareholder.githubLogin
        ? shareholder.githubName
          ? `${shareholder.platformLabel}:@${shareholder.githubLogin} (${shareholder.githubName})`
          : `${shareholder.platformLabel}:@${shareholder.githubLogin}`
        : `${shareholder.platformLabel ?? "social"}:${shareholder.userId ?? "unknown"}`
      : "wallet";
    lines.push(
      `• ${escapeHtml(descriptor)} | ${escapeHtml(String(shareholder.shareBps))} bps\n<code>${escapeHtml(shareholder.address)}</code>`,
    );
    if (shareholder.githubUrl) {
      lines.push(`<code>${escapeHtml(shareholder.githubUrl)}</code>`);
    }
  }
  return lines;
}

export function compactShareholderDetailLines(
  label: string,
  shareholders: NormalizedShareholder[],
): string[] {
  if (shareholders.length === 0) {
    return [textField(label, "none")];
  }

  const preview = shareholders.slice(0, 2);
  const lines = [textField(label, `${shareholders.length} recipient(s)`)];

  for (const shareholder of preview) {
    lines.push(
      `• ${escapeHtml(formatShareholderDescriptor(shareholder))} | ${escapeHtml(String(shareholder.shareBps))} bps`,
    );
    lines.push(escapeHtml(shareholder.address));
  }

  if (shareholders.length > preview.length) {
    lines.push(textField("More Recipients", `${shareholders.length - preview.length} more not shown`));
  }

  return lines;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function buildCompactMintLines(relatedMints: string[]): string[] {
  if (relatedMints.length === 0) {
    return [
      textField("🪙 Token CA", "unknown"),
    ];
  }

  if (relatedMints.length === 1) {
    return [
      copyableField("🪙 Token CA", relatedMints[0]!),
    ];
  }

  const preview = relatedMints.slice(0, 3);
  const lines = [
    textField("🪙 Token CA", `unknown (${relatedMints.length} linked mints)`),
  ];

  for (const [index, mint] of preview.entries()) {
    lines.push(copyableField(index === 0 ? "Token CA 1" : `Token CA ${index + 1}`, mint));
  }

  if (relatedMints.length > preview.length) {
    lines.push(textField("More Token CAs", `${relatedMints.length - preview.length} more not shown`));
  }

  return lines;
}

function buildGovernanceKeyboard(alert: GovernanceAlert): TelegramInlineKeyboardMarkup | undefined {
  const rows: TelegramInlineKeyboardButton[][] = [];
  const primaryRow: TelegramInlineKeyboardButton[] = [
    { text: "🪙 Pump", url: `https://pump.fun/coin/${alert.tokenMint}` },
    { text: "📈 DexScreener", url: `https://dexscreener.com/solana/${alert.tokenMint}` },
  ];
  rows.push(primaryRow);

  if (alert.signature) {
    rows.push([
      { text: "🔗 Tx", url: `https://solscan.io/tx/${alert.signature}` },
    ]);
  }

  return { inline_keyboard: rows };
}

function buildGitHubClaimKeyboard(claim: ClaimDetection): TelegramInlineKeyboardMarkup | undefined {
  const rows: TelegramInlineKeyboardButton[][] = [];
  const primaryRow: TelegramInlineKeyboardButton[] = [];

  if (claim.githubProfile?.htmlUrl) {
    primaryRow.push({ text: "🐙 GitHub", url: claim.githubProfile.htmlUrl });
  }
  if (claim.signature) {
    primaryRow.push({ text: "🔗 Tx", url: `https://solscan.io/tx/${claim.signature}` });
  }
  if (claim.recipient) {
    primaryRow.push({ text: "👛 Wallet", url: `https://solscan.io/account/${claim.recipient}` });
  }
  if (primaryRow.length > 0) {
    rows.push(primaryRow);
  }

  if (claim.relatedMints.length === 1) {
    rows.push([
      { text: "🪙 Pump", url: `https://pump.fun/coin/${claim.relatedMints[0]!}` },
      { text: "📈 DexScreener", url: `https://dexscreener.com/solana/${claim.relatedMints[0]!}` },
    ]);
  }

  return rows.length > 0 ? { inline_keyboard: rows } : undefined;
}

function formatCompactTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  const year = parsed.getUTCFullYear();
  const month = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  const day = String(parsed.getUTCDate()).padStart(2, "0");
  const hours = String(parsed.getUTCHours()).padStart(2, "0");
  const minutes = String(parsed.getUTCMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes} UTC`;
}

function formatGovernanceHeadline(event: string): string {
  switch (event) {
    case "Fee Sharing Config Created":
      return "🆕 <b>Fee Sharing Enabled</b>";
    case "Fee Shares Updated":
      return "🔄 <b>Fee Shares Updated</b>";
    case "Fee Authority Transferred":
      return "🔁 <b>Fee Authority Transferred</b>";
    case "Fee Configuration Locked":
      return "🔒 <b>Fee Config Locked</b>";
    case "Fee Sharing Config Reset":
      return "♻️ <b>Fee Config Reset</b>";
    default:
      return `🚨 <b>${escapeHtml(event)}</b>`;
  }
}

function formatShareholderDescriptor(shareholder: NormalizedShareholder): string {
  if (!shareholder.isSocial) {
    return "wallet";
  }

  if (shareholder.platformLabel === "GitHub" && shareholder.githubLogin) {
    return shareholder.githubName
      ? `${shareholder.platformLabel}:@${shareholder.githubLogin} (${shareholder.githubName})`
      : `${shareholder.platformLabel}:@${shareholder.githubLogin}`;
  }

  return `${shareholder.platformLabel ?? "social"}:${shareholder.userId ?? "unknown"}`;
}
