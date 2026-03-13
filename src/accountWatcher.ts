import { PublicKey, type AccountInfo, type Commitment, type Connection } from "@solana/web3.js";

import type { GitHubProfileRecord } from "./storage";
import type { JsonStorage, StoredSocialPdaRecord } from "./storage";

export interface ClaimEnrichment {
  signature?: string;
  recipient?: string;
  timestamp?: string;
}

export interface ClaimDetection {
  socialPda: string;
  userId: string;
  platform: number;
  platformLabel: string;
  claimedLamports: bigint;
  previousBalanceLamports: bigint;
  currentBalanceLamports: bigint;
  relatedMints: string[];
  slot: number;
  recipient?: string;
  signature?: string;
  timestamp: string;
  firstObservedForPda?: boolean;
  firstObservedForSingleMint?: boolean;
  githubProfile?: GitHubProfileRecord;
}

interface WatcherOptions {
  connection: Connection;
  storage: JsonStorage;
  commitment: Commitment;
  onClaim: (claim: ClaimDetection) => Promise<void>;
  lookupClaimEnrichment: (
    socialPda: string,
    slot: number,
    claimedLamports: bigint,
  ) => ClaimEnrichment | undefined;
}

export class SocialPdaAccountWatcher {
  private readonly subscriptions = new Map<string, number>();
  private readonly balances = new Map<string, bigint>();

  constructor(private readonly options: WatcherOptions) {}

  async watch(record: StoredSocialPdaRecord): Promise<void> {
    if (this.subscriptions.has(record.address)) {
      return;
    }

    const publicKey = new PublicKey(record.address);
    const initialInfo = await this.options.connection.getAccountInfo(
      publicKey,
      this.options.commitment,
    );

    if (initialInfo) {
      const initialBalance = BigInt(initialInfo.lamports);
      this.balances.set(record.address, initialBalance);
      await this.options.storage.setLastKnownBalance(record.address, initialBalance);
    }

    const subscriptionId = this.options.connection.onAccountChange(
      publicKey,
      async (accountInfo, context) => {
        await this.handleAccountChange(record.address, accountInfo, context.slot);
      },
      this.options.commitment,
    );

    this.subscriptions.set(record.address, subscriptionId);
  }

  async watchMany(records: StoredSocialPdaRecord[]): Promise<void> {
    for (const record of records) {
      await this.watch(record);
    }
  }

  async stop(): Promise<void> {
    for (const subscriptionId of this.subscriptions.values()) {
      await this.options.connection.removeAccountChangeListener(subscriptionId);
    }
    this.subscriptions.clear();
  }

  private async handleAccountChange(
    address: string,
    accountInfo: AccountInfo<Buffer>,
    slot: number,
  ): Promise<void> {
    const previousBalance =
      this.balances.get(address) ??
      this.options.storage.getLastKnownBalance(address) ??
      BigInt(accountInfo.lamports);
    const currentBalance = BigInt(accountInfo.lamports);

    this.balances.set(address, currentBalance);
    await this.options.storage.setLastKnownBalance(address, currentBalance);

    if (currentBalance >= previousBalance) {
      return;
    }

    const record = this.options.storage.getSocialPda(address);
    if (!record) {
      return;
    }

    const claimedLamports = previousBalance - currentBalance;
    const enrichment = this.options.lookupClaimEnrichment(address, slot, claimedLamports);

    await this.options.onClaim({
      socialPda: address,
      userId: record.userId,
      platform: record.platform,
      platformLabel: record.platformLabel,
      claimedLamports,
      previousBalanceLamports: previousBalance,
      currentBalanceLamports: currentBalance,
      relatedMints: record.relatedMints,
      slot,
      recipient: enrichment?.recipient,
      signature: enrichment?.signature,
      timestamp: enrichment?.timestamp ?? new Date().toISOString(),
    });
  }
}
