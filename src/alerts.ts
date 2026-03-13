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

export class AlertService {
  constructor(
    private readonly telegramBotToken?: string,
    private readonly telegramChatId?: string,
  ) {}

  async sendGovernanceAlert(alert: GovernanceAlert): Promise<void> {
    const lines = [
      "🚨 <b>PUMP FEE ALERT</b>",
      `<b>Type</b>: ${escapeHtml(alert.event)}`,
    ];

    if (alert.meaning) {
      lines.push(`<b>Meaning</b>: ${escapeHtml(alert.meaning)}`);
    }

    lines.push("");
    lines.push(copyableField("Mint CA", alert.tokenMint));
    lines.push(...alert.details);

    if (alert.signature) {
      lines.push(copyableField("Signature", alert.signature));
    }

    lines.push(`<b>Time</b>: ${escapeHtml(alert.timestamp)}`);

    await this.sendMessage(lines.join("\n"), true);
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
    const headline = claim.firstObservedForSingleMint
      ? "🆕 <b>FIRST OBSERVED GITHUB FEE CLAIM</b>"
      : claim.firstObservedForPda
        ? "🆕 <b>FIRST OBSERVED CLAIM FROM GITHUB RECIPIENT</b>"
        : "🐙 <b>GITHUB FEE CLAIM</b>";

    const lines = [
      headline,
      textField("📌 Observation", describeClaimObservation(claim)),
      "",
      ...buildMintAttributionLines(claim.relatedMints),
      ...(claim.githubProfile
        ? [
            textField(
              "🐙 GitHub Account",
              claim.githubProfile.name
                ? `@${claim.githubProfile.login} (${claim.githubProfile.name})`
                : `@${claim.githubProfile.login}`,
            ),
            copyableField("🔗 GitHub Profile", claim.githubProfile.htmlUrl),
            ...(claim.githubProfile.followers != null
              ? [textField("👥 Followers", String(claim.githubProfile.followers))]
              : []),
            ...(claim.githubProfile.following != null
              ? [textField("➡️ Following", String(claim.githubProfile.following))]
              : []),
            ...(claim.githubProfile.publicRepos != null
              ? [textField("📦 Public Repos", String(claim.githubProfile.publicRepos))]
              : []),
            ...(claim.githubProfile.totalRepoStars != null
              ? [textField("⭐ Repo Stars", String(claim.githubProfile.totalRepoStars))]
              : []),
          ]
        : []),
      copyableField("🐙 GitHub User ID", claim.userId),
      copyableField("🏦 Social PDA", claim.socialPda),
      textField("💸 Claimed", formatLamports(claim.claimedLamports)),
      claim.recipient
        ? copyableField("👛 Recipient Wallet", claim.recipient)
        : textField("👛 Recipient Wallet", "unknown"),
      textField("📉 Previous PDA Balance", formatLamports(claim.previousBalanceLamports)),
      textField("📈 Current PDA Balance", formatLamports(claim.currentBalanceLamports)),
      textField("⏱️ Slot", String(claim.slot)),
      ...(claim.signature ? [copyableField("🔗 Signature", claim.signature)] : []),
      textField("🕒 Time", claim.timestamp),
    ];

    await this.sendMessage(lines.join("\n"), true);
  }

  async sendStartupNotice(message: string): Promise<void> {
    await this.sendMessage(`🟢 BOT STARTED\n${message}`);
  }

  async sendError(message: string): Promise<void> {
    await this.sendMessage(`⚠️ BOT ERROR\n${message}`);
  }

  async sendMessage(text: string, html = false): Promise<void> {
    console.log(`\n${text}\n`);

    if (!this.telegramBotToken || !this.telegramChatId) {
      return;
    }

    const response = await fetch(
      `https://api.telegram.org/bot${this.telegramBotToken}/sendMessage`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          chat_id: this.telegramChatId,
          text,
          parse_mode: html ? "HTML" : undefined,
          disable_web_page_preview: true,
        }),
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Telegram sendMessage failed: ${response.status} ${body}`);
    }
  }
}

export function buildCreateAlertDetails(params: {
  sharingConfig: string;
  admin: string;
  shareholders: NormalizedShareholder[];
}): string[] {
  return [
    copyableField("Sharing Config", params.sharingConfig),
    copyableField("Admin", params.admin),
    ...shareholderDetailLines("Shareholders", params.shareholders),
  ];
}

export function buildUpdateAlertDetails(params: {
  sharingConfig: string;
  admin: string;
  shareholders: NormalizedShareholder[];
}): string[] {
  return [
    copyableField("Sharing Config", params.sharingConfig),
    copyableField("Admin", params.admin),
    ...shareholderDetailLines("New Shareholders", params.shareholders),
  ];
}

export function copyableField(label: string, value: string): string {
  return `<b>${escapeHtml(label)}</b>\n<code>${escapeHtml(value)}</code>`;
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

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function describeClaimObservation(claim: ClaimDetection): string {
  if (claim.firstObservedForSingleMint) {
    return "First claim observed by this bot for this GitHub recipient on this mint.";
  }
  if (claim.firstObservedForPda) {
    return "First claim observed by this bot for this GitHub recipient PDA since monitoring began.";
  }
  return "This is not the first claim observed by this bot for this GitHub recipient PDA.";
}

function buildMintAttributionLines(relatedMints: string[]): string[] {
  if (relatedMints.length === 0) {
    return [
      textField("🪙 Mint Attribution", "unknown"),
    ];
  }

  if (relatedMints.length === 1) {
    return [
      textField("🪙 Mint Attribution", "single linked mint"),
      copyableField("Mint CA", relatedMints[0]!),
    ];
  }

  const preview = relatedMints.slice(0, 3);
  const lines = [
    textField("🪙 Mint Attribution", "exact mint unknown"),
    textField(
      "Reason",
      `This social PDA is linked to ${relatedMints.length} mints, so balance-delta claim detection cannot prove which mint generated this claim.`,
    ),
    textField("Linked Mints", String(relatedMints.length)),
  ];

  for (const [index, mint] of preview.entries()) {
    lines.push(copyableField(index === 0 ? "Possible Mint CA" : `Possible Mint CA ${index + 1}`, mint));
  }

  if (relatedMints.length > preview.length) {
    lines.push(textField("More Linked Mints", `${relatedMints.length - preview.length} more not shown`));
  }

  return lines;
}
