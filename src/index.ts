import "dotenv/config";

import { utils as anchorUtils } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

import { SocialPdaAccountWatcher, type ClaimEnrichment } from "./accountWatcher";
import {
  AlertService,
  buildCreateAlertDetails,
  buildUpdateAlertDetails,
  compactShareholderDetailLines,
  textField,
} from "./alerts";
import {
  decodeSharingConfigAccount,
  decodeSocialFeePdaAccount,
  type DecodedFeeProgramEvent,
  type GovernanceCreateEvent,
  type GovernanceResetEvent,
  type GovernanceRevokeEvent,
  type GovernanceTransferEvent,
  type GovernanceUpdateEvent,
  type SocialFeePdaClaimedEvent,
  type SocialFeePdaCreatedEvent,
} from "./eventDecoder";
import { FeeProgramEventListener } from "./eventListener";
import { GitHubProfileService } from "./github";
import { createRpcConnection } from "./rpc";
import { JsonStorage, type StoredSocialPdaRecord } from "./storage";
import { TelegramControlBot } from "./telegramControl";
import {
  chunk,
  cloneAlertFilters,
  describeAlertFilters,
  deriveSocialFeePda,
  getConfig,
  isMintAllowed,
  PUMP_FEE_PROGRAM_ID,
  SHARING_CONFIG_DISCRIMINATOR,
  type NormalizedShareholder,
  uniqueStrings,
} from "./utils";

interface CachedClaimLog {
  socialPda: string;
  slot: number;
  amountLamports: bigint;
  recipient: string;
  signature: string;
  timestamp: string;
}

class ClaimLogCache {
  private readonly claimsByPda = new Map<string, CachedClaimLog[]>();

  remember(event: SocialFeePdaClaimedEvent): void {
    const records = this.claimsByPda.get(event.socialFeePda) ?? [];
    records.push({
      socialPda: event.socialFeePda,
      slot: event.slot,
      amountLamports: event.amountClaimedLamports,
      recipient: event.recipient,
      signature: event.signature,
      timestamp: event.timestamp,
    });

    this.claimsByPda.set(
      event.socialFeePda,
      records.filter((record) => record.slot >= event.slot - 16).slice(-16),
    );
  }

  consume(socialPda: string, slot: number, amountLamports: bigint): ClaimEnrichment | undefined {
    const records = this.claimsByPda.get(socialPda);
    if (!records || records.length === 0) {
      return undefined;
    }

    const index = records.findIndex(
      (record) =>
        Math.abs(record.slot - slot) <= 2 &&
        record.amountLamports === amountLamports,
    );

    if (index < 0) {
      return undefined;
    }

    const [match] = records.splice(index, 1);
    this.claimsByPda.set(socialPda, records);

    return {
      recipient: match.recipient,
      signature: match.signature,
      timestamp: match.timestamp,
    };
  }
}

class PumpFeeMonitoringBot {
  private readonly config = getConfig();
  private readonly storage = new JsonStorage(this.config.dataFile);
  private readonly connection = createRpcConnection(this.config);
  private alertFilters = cloneAlertFilters(this.config.alertFilters);
  private readonly alerts = new AlertService(
    this.config.telegramBotToken,
    this.config.telegramChatIds,
  );
  private readonly githubProfiles = new GitHubProfileService(
    this.storage,
    this.config.githubToken,
  );
  private readonly telegramControl = new TelegramControlBot({
    botToken: this.config.telegramBotToken,
    allowedChatId: this.config.telegramChatId,
    getFilters: () => this.alertFilters,
    setFilters: async (filters) => {
      this.alertFilters = cloneAlertFilters(filters);
      await this.storage.setRuntimeAlertFilters(this.alertFilters);
    },
  });
  private readonly claimLogCache = new ClaimLogCache();
  private readonly watcher = new SocialPdaAccountWatcher({
    connection: this.connection,
    storage: this.storage,
    commitment: this.config.commitment,
    onClaim: async (claim) => {
      const firstObservedForPda = this.storage.getObservedClaimCount(claim.socialPda) === 0;
      const firstObservedForSingleMint =
        claim.relatedMints.length === 1 &&
        this.storage.getObservedClaimCountForMint(claim.socialPda, claim.relatedMints[0]!) === 0;

      await this.storage.recordObservedClaim(claim.socialPda, claim.relatedMints);
      if (this.shouldAlertOnClaim(claim)) {
        const githubProfile =
          claim.platformLabel === "GitHub"
            ? await this.githubProfiles.getProfileByAccountId(claim.userId)
            : undefined;
        await this.alerts.sendSocialClaimAlert({
          ...claim,
          firstObservedForPda,
          firstObservedForSingleMint,
          githubProfile,
        });
      }
    },
    lookupClaimEnrichment: (socialPda, slot, claimedLamports) =>
      this.claimLogCache.consume(socialPda, slot, claimedLamports),
  });
  private readonly eventListener = new FeeProgramEventListener(
    this.connection,
    {
      onEvent: async (event) => {
        this.eventQueue = this.eventQueue
          .then(async () => {
            await this.handleEvent(event);
          })
          .catch(async (error) => {
            console.error("Event handling failed", error);
            try {
              await this.alerts.sendError(
                `Failed to process ${event.type} for signature ${event.signature}: ${String(error)}`,
              );
            } catch (alertError) {
              console.error("Failed to send error alert", alertError);
            }
          });

        await this.eventQueue;
      },
      onError: (error, logs) => {
        console.error("Failed to decode logs", error, logs.signature);
      },
    },
    this.config.commitment,
  );
  private eventQueue: Promise<void> = Promise.resolve();

  async start(): Promise<void> {
    await this.storage.load();
    this.alertFilters = this.storage.getRuntimeAlertFilters() ?? cloneAlertFilters(this.config.alertFilters);
    console.log(`Loaded storage from ${this.config.dataFile}`);

    if (this.config.bootstrapExisting) {
      console.log("Bootstrapping existing fee-sharing configs...");
      await this.bootstrapExistingSharingConfigs();
      console.log(
        `Bootstrap complete. Tokens=${this.storage.getAllTokens().length}, SocialPDAs=${this.storage.getAllSocialPdas().length}`,
      );
    }

    console.log("Starting social PDA watchers...");
    await this.watcher.watchMany(this.storage.getAllSocialPdas());
    console.log("Starting fee-program log subscription...");
    this.eventListener.start();

    await this.alerts.sendStartupNotice("");

    this.telegramControl.start();

    process.once("SIGINT", () => {
      void this.stop("SIGINT");
    });
    process.once("SIGTERM", () => {
      void this.stop("SIGTERM");
    });

    console.log("Pump fee monitor is running.");
  }

  private async stop(signal: string): Promise<void> {
    console.log(`Stopping bot after ${signal}`);
    await this.eventListener.stop();
    await this.watcher.stop();
    await this.telegramControl.stop();
    process.exit(0);
  }

  private async handleEvent(event: DecodedFeeProgramEvent): Promise<void> {
    switch (event.type) {
      case "CreateFeeSharingConfigEvent":
        await this.handleCreate(event);
        return;
      case "UpdateFeeSharesEvent":
        await this.handleUpdate(event);
        return;
      case "TransferFeeSharingAuthorityEvent":
        await this.handleTransfer(event);
        return;
      case "RevokeFeeSharingAuthorityEvent":
        await this.handleRevoke(event);
        return;
      case "ResetFeeSharingConfigEvent":
        await this.handleReset(event);
        return;
      case "SocialFeePdaCreated":
        await this.handleSocialPdaCreated(event);
        return;
      case "SocialFeePdaClaimed":
        this.claimLogCache.remember(event);
        return;
      default:
        return;
    }
  }

  private async bootstrapExistingSharingConfigs(): Promise<void> {
    const accounts = await this.connection.getProgramAccounts(PUMP_FEE_PROGRAM_ID, {
      commitment: this.config.commitment,
      filters: [
        {
          memcmp: {
            offset: 0,
            bytes: anchorUtils.bytes.bs58.encode(SHARING_CONFIG_DISCRIMINATOR),
          },
        },
      ],
    });

    console.log(`Fetched ${accounts.length} SharingConfig accounts from chain`);

    const decodedConfigs: Array<{
      address: string;
      mint: string;
      admin: string;
      status: "active" | "paused" | "revoked" | "unknown";
      shareholders: NormalizedShareholder[];
    }> = [];

    for (const account of accounts) {
      const decoded = decodeSharingConfigAccount(account.account.data);
      if (!decoded) {
        continue;
      }

      decodedConfigs.push({
        address: account.pubkey.toBase58(),
        mint: decoded.mint,
        admin: decoded.admin,
        status: decoded.status,
        shareholders: decoded.shareholders,
      });

      await this.storage.upsertToken({
        mint: decoded.mint,
        sharingConfig: account.pubkey.toBase58(),
        admin: decoded.admin,
        status: decoded.status,
        shareholders: decoded.shareholders,
      });
    }

    console.log(`Decoded ${decodedConfigs.length} fee-sharing token configs`);

    const allShareholders = uniqueStrings(
      decodedConfigs.flatMap((config) => config.shareholders.map((shareholder) => shareholder.address)),
    );
    const socialMap = await this.resolveSocialPdas(allShareholders);

    for (const config of decodedConfigs) {
      const socialAddresses = config.shareholders
        .map((shareholder) => shareholder.address)
        .filter((address) => socialMap.has(address));
      await this.storage.setMintSocialPdas(config.mint, socialAddresses);
    }

  }

  private async handleCreate(event: GovernanceCreateEvent): Promise<void> {
    await this.storage.upsertToken({
      mint: event.mint,
      sharingConfig: event.sharingConfig,
      admin: event.admin,
      status: event.status,
      shareholders: event.shareholders,
    });

    await this.storage.recordAuthorityChange({
      mint: event.mint,
      event: "create",
      oldAdmin: null,
      newAdmin: event.admin,
      signature: event.signature,
      timestamp: event.timestamp,
    });

    await this.linkSocialRecipients(event.mint, event.shareholders);
    const enrichedShareholders = await this.enrichShareholders(event.shareholders);

    if (this.shouldAlertOnGovernance("create", event.mint)) {
      await this.alerts.sendGovernanceAlert({
        tokenMint: event.mint,
        event: "Fee Sharing Config Created",
        meaning: "A token enabled Pump fee sharing for the first time.",
        signature: event.signature,
        timestamp: event.timestamp,
        details: buildCreateAlertDetails({
          sharingConfig: event.sharingConfig,
          admin: event.admin,
          shareholders: enrichedShareholders,
        }),
      });
    }
  }

  private async handleUpdate(event: GovernanceUpdateEvent): Promise<void> {
    await this.storage.upsertToken({
      mint: event.mint,
      sharingConfig: event.sharingConfig,
      admin: event.admin,
      status: this.storage.getToken(event.mint)?.status ?? "active",
      shareholders: event.shareholders,
    });

    await this.linkSocialRecipients(event.mint, event.shareholders);
    const enrichedShareholders = await this.enrichShareholders(event.shareholders);

    if (this.shouldAlertOnGovernance("update", event.mint)) {
      await this.alerts.sendGovernanceAlert({
        tokenMint: event.mint,
        event: "Fee Shares Updated",
        meaning: "The recipient list or share percentages changed.",
        signature: event.signature,
        timestamp: event.timestamp,
        details: buildUpdateAlertDetails({
          sharingConfig: event.sharingConfig,
          admin: event.admin,
          shareholders: enrichedShareholders,
        }),
      });
    }
  }

  private async handleTransfer(event: GovernanceTransferEvent): Promise<void> {
    const token = this.storage.getToken(event.mint);
    await this.storage.upsertToken({
      mint: event.mint,
      sharingConfig: event.sharingConfig,
      admin: event.newAdmin,
      status: token?.status ?? "active",
      shareholders: token?.shareholders ?? [],
    });

    await this.storage.recordAuthorityChange({
      mint: event.mint,
      event: "transfer",
      oldAdmin: event.oldAdmin,
      newAdmin: event.newAdmin,
      signature: event.signature,
      timestamp: event.timestamp,
    });

    if (this.shouldAlertOnGovernance("transfer", event.mint)) {
      await this.alerts.sendGovernanceAlert({
        tokenMint: event.mint,
        event: "Fee Authority Transferred",
        meaning: "Control over future fee-sharing changes moved to a new admin.",
        signature: event.signature,
        timestamp: event.timestamp,
        details: [
          textField("⚙️ Config", event.sharingConfig),
          textField("👤 Old Admin", event.oldAdmin),
          textField("👤 New Admin", event.newAdmin),
        ],
      });
    }
  }

  private async handleRevoke(event: GovernanceRevokeEvent): Promise<void> {
    const token = this.storage.getToken(event.mint);
    await this.storage.upsertToken({
      mint: event.mint,
      sharingConfig: event.sharingConfig,
      admin: event.admin,
      status: "revoked",
      shareholders: token?.shareholders ?? [],
    });

    await this.storage.recordAuthorityChange({
      mint: event.mint,
      event: "revoke",
      oldAdmin: event.admin,
      newAdmin: null,
      signature: event.signature,
      timestamp: event.timestamp,
    });

    if (this.shouldAlertOnGovernance("revoke", event.mint)) {
      await this.alerts.sendGovernanceAlert({
        tokenMint: event.mint,
        event: "Fee Configuration Locked",
        meaning: "The admin authority was revoked, so fee-sharing settings can no longer be changed.",
        signature: event.signature,
        timestamp: event.timestamp,
        details: [
          textField("⚙️ Config", event.sharingConfig),
          textField("👤 Admin", event.admin),
        ],
      });
    }
  }

  private async handleReset(event: GovernanceResetEvent): Promise<void> {
    await this.storage.upsertToken({
      mint: event.mint,
      sharingConfig: event.sharingConfig,
      admin: event.newAdmin,
      status: "active",
      shareholders: event.newShareholders,
    });

    await this.storage.recordAuthorityChange({
      mint: event.mint,
      event: "reset",
      oldAdmin: event.oldAdmin,
      newAdmin: event.newAdmin,
      signature: event.signature,
      timestamp: event.timestamp,
    });

    await this.linkSocialRecipients(event.mint, event.newShareholders);
    const enrichedShareholders = await this.enrichShareholders(event.newShareholders);

    if (this.shouldAlertOnGovernance("reset", event.mint)) {
      await this.alerts.sendGovernanceAlert({
        tokenMint: event.mint,
        event: "Fee Sharing Config Reset",
        meaning: "The config was reset and replaced with a new admin and/or recipient set.",
        signature: event.signature,
        timestamp: event.timestamp,
        details: [
          textField("⚙️ Config", event.sharingConfig),
          textField("👤 Old Admin", event.oldAdmin),
          textField("👤 New Admin", event.newAdmin),
          ...compactShareholderDetailLines("👥 Recipients", enrichedShareholders),
        ],
      });
    }
  }

  private async handleSocialPdaCreated(event: SocialFeePdaCreatedEvent): Promise<void> {
    const derived = deriveSocialFeePda(event.userId, event.platform).toBase58();
    if (derived !== event.socialFeePda) {
      console.warn(
        `Derived social PDA ${derived} does not match emitted PDA ${event.socialFeePda} for ${event.userId}`,
      );
    }

    const record = await this.storage.upsertSocialPda({
      address: event.socialFeePda,
      userId: event.userId,
      platform: event.platform,
      platformLabel: event.platformLabel,
      createdBy: event.createdBy,
    });

    await this.watcher.watch(record);
  }

  private async linkSocialRecipients(
    mint: string,
    shareholders: NormalizedShareholder[],
  ): Promise<void> {
    const socialMap = await this.resolveSocialPdas(shareholders.map((shareholder) => shareholder.address), [mint]);
    const socialAddresses = shareholders
      .map((shareholder) => shareholder.address)
      .filter((address) => socialMap.has(address));

    await this.storage.setMintSocialPdas(mint, socialAddresses);
  }

  private async resolveSocialPdas(
    addresses: string[],
    relatedMints: string[] = [],
  ): Promise<Map<string, StoredSocialPdaRecord>> {
    const uniqueAddresses = uniqueStrings(addresses);
    const result = new Map<string, StoredSocialPdaRecord>();

    for (const group of chunk(uniqueAddresses, 100)) {
      const publicKeys = group.map((address) => new PublicKey(address));
      const accounts = await this.connection.getMultipleAccountsInfo(
        publicKeys,
        this.config.commitment,
      );

      for (let index = 0; index < group.length; index += 1) {
        const account = accounts[index];
        if (!account || !account.owner.equals(PUMP_FEE_PROGRAM_ID)) {
          continue;
        }

        const decoded = decodeSocialFeePdaAccount(account.data);
        if (!decoded) {
          continue;
        }

        const derived = deriveSocialFeePda(decoded.userId, decoded.platform).toBase58();
        if (derived !== group[index]) {
          console.warn(
            `Ignoring social PDA ${group[index]} because derived PDA is ${derived}`,
          );
          continue;
        }

        const record = await this.storage.upsertSocialPda({
          address: group[index],
          userId: decoded.userId,
          platform: decoded.platform,
          platformLabel: decoded.platformLabel,
          relatedMints,
        });

        await this.storage.setLastKnownBalance(group[index], BigInt(account.lamports));
        result.set(group[index], record);
      }

    }

    await this.watcher.watchMany([...result.values()]);
    return result;
  }

  private async enrichShareholders(
    shareholders: NormalizedShareholder[],
  ): Promise<NormalizedShareholder[]> {
    const enriched = [...shareholders];
    await Promise.all(
      enriched.map(async (shareholder, index) => {
        const socialRecord = this.storage.getSocialPda(shareholder.address);
        if (!socialRecord || socialRecord.platformLabel !== "GitHub") {
          return;
        }

        const profile = await this.githubProfiles.getProfileByAccountId(socialRecord.userId);
        enriched[index] = {
          ...shareholder,
          isSocial: true,
          userId: socialRecord.userId,
          platform: socialRecord.platform,
          platformLabel: socialRecord.platformLabel,
          githubLogin: profile?.login,
          githubName: profile?.name,
          githubUrl: profile?.htmlUrl,
        };
      }),
    );
    return enriched;
  }

  private shouldAlertOnGovernance(
    eventType: "create" | "update" | "transfer" | "revoke" | "reset",
    mint: string,
  ): boolean {
    const alertFilters = this.alertFilters;
    if (alertFilters.paused) {
      return false;
    }
    if (alertFilters.eventTypes && !alertFilters.eventTypes.has(eventType)) {
      return false;
    }
    return isMintAllowed(alertFilters, [mint]);
  }

  private shouldAlertOnClaim(claim: {
    platform: number;
    claimedLamports: bigint;
    relatedMints: string[];
  }): boolean {
    const alertFilters = this.alertFilters;
    if (alertFilters.paused) {
      return false;
    }

    if (alertFilters.eventTypes && !alertFilters.eventTypes.has("claim")) {
      return false;
    }
    if (alertFilters.platforms && !alertFilters.platforms.has(claim.platform)) {
      return false;
    }
    if (alertFilters.minClaimLamports != null && claim.claimedLamports < alertFilters.minClaimLamports) {
      return false;
    }
    return isMintAllowed(alertFilters, claim.relatedMints);
  }
}

async function main(): Promise<void> {
  const bot = new PumpFeeMonitoringBot();
  await bot.start();
  await new Promise<void>(() => {
    // Keep the process alive while WebSocket subscriptions are active.
  });
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
