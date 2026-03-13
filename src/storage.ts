import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  AlertFilters,
  NormalizedShareholder,
  SerializedAlertFilters,
  TokenStatus,
} from "./utils";
import { deserializeAlertFilters, serializeAlertFilters } from "./utils";

export interface StoredTokenRecord {
  mint: string;
  sharingConfig: string;
  admin: string | null;
  status: TokenStatus;
  shareholders: NormalizedShareholder[];
  socialPdas: string[];
  createdAt: string;
  updatedAt: string;
}

export interface StoredSocialPdaRecord {
  address: string;
  userId: string;
  platform: number;
  platformLabel: string;
  relatedMints: string[];
  createdBy?: string;
  lastKnownBalanceLamports: string;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubProfileRecord {
  accountId: string;
  login: string;
  name?: string;
  htmlUrl: string;
  avatarUrl?: string;
  followers?: number;
  following?: number;
  publicRepos?: number;
  totalRepoStars?: number;
  fetchedAt: string;
}

export interface AuthorityHistoryRecord {
  mint: string;
  event: "create" | "transfer" | "revoke" | "reset";
  oldAdmin: string | null;
  newAdmin: string | null;
  signature?: string;
  timestamp: string;
}

interface StorageShape {
  tokensWithFeeSharing: Record<string, StoredTokenRecord>;
  socialPdas: Record<string, StoredSocialPdaRecord>;
  lastKnownBalances: Record<string, string>;
  socialClaimCounts: Record<string, number>;
  socialClaimCountsByMint: Record<string, number>;
  githubProfiles: Record<string, GitHubProfileRecord>;
  runtimeConfig: {
    alertFilters?: SerializedAlertFilters;
  };
  authorityHistory: AuthorityHistoryRecord[];
  updatedAt: string;
}

const EMPTY_STORAGE: StorageShape = {
  tokensWithFeeSharing: {},
  socialPdas: {},
  lastKnownBalances: {},
  socialClaimCounts: {},
  socialClaimCountsByMint: {},
  githubProfiles: {},
  runtimeConfig: {},
  authorityHistory: [],
  updatedAt: new Date(0).toISOString(),
};

export class JsonStorage {
  private data: StorageShape = structuredClone(EMPTY_STORAGE);
  private persistChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const contents = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(contents) as Partial<StorageShape>;
      this.data = {
        tokensWithFeeSharing: parsed.tokensWithFeeSharing ?? {},
        socialPdas: parsed.socialPdas ?? {},
        lastKnownBalances: parsed.lastKnownBalances ?? {},
        socialClaimCounts: parsed.socialClaimCounts ?? {},
        socialClaimCountsByMint: parsed.socialClaimCountsByMint ?? {},
        githubProfiles: parsed.githubProfiles ?? {},
        runtimeConfig: parsed.runtimeConfig ?? {},
        authorityHistory: parsed.authorityHistory ?? [],
        updatedAt: parsed.updatedAt ?? new Date().toISOString(),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await this.persist();
    }
  }

  getToken(mint: string): StoredTokenRecord | undefined {
    return this.data.tokensWithFeeSharing[mint];
  }

  getAllTokens(): StoredTokenRecord[] {
    return Object.values(this.data.tokensWithFeeSharing);
  }

  getSocialPda(address: string): StoredSocialPdaRecord | undefined {
    return this.data.socialPdas[address];
  }

  getAllSocialPdas(): StoredSocialPdaRecord[] {
    return Object.values(this.data.socialPdas);
  }

  getLastKnownBalance(address: string): bigint | undefined {
    const raw = this.data.lastKnownBalances[address];
    return raw == null ? undefined : BigInt(raw);
  }

  getObservedClaimCount(address: string): number {
    return this.data.socialClaimCounts[address] ?? 0;
  }

  getObservedClaimCountForMint(address: string, mint: string): number {
    return this.data.socialClaimCountsByMint[`${address}:${mint}`] ?? 0;
  }

  getRuntimeAlertFilters(): AlertFilters | undefined {
    return deserializeAlertFilters(this.data.runtimeConfig.alertFilters);
  }

  getGitHubProfile(accountId: string): GitHubProfileRecord | undefined {
    return this.data.githubProfiles[accountId];
  }

  async upsertToken(params: {
    mint: string;
    sharingConfig: string;
    admin: string | null;
    status: TokenStatus;
    shareholders: NormalizedShareholder[];
  }): Promise<void> {
    const now = new Date().toISOString();
    const existing = this.data.tokensWithFeeSharing[params.mint];

    this.data.tokensWithFeeSharing[params.mint] = {
      mint: params.mint,
      sharingConfig: params.sharingConfig,
      admin: params.admin,
      status: params.status,
      shareholders: this.decorateShareholders(params.shareholders),
      socialPdas: existing?.socialPdas ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await this.persistQueued();
  }

  async setMintSocialPdas(mint: string, socialAddresses: string[]): Promise<void> {
    const token = this.data.tokensWithFeeSharing[mint];
    if (!token) {
      return;
    }

    const nextSet = new Set(socialAddresses);
    token.socialPdas = [...nextSet];
    token.shareholders = this.decorateShareholders(token.shareholders);
    token.updatedAt = new Date().toISOString();

    for (const socialRecord of Object.values(this.data.socialPdas)) {
      const currentSet = new Set(socialRecord.relatedMints);
      if (nextSet.has(socialRecord.address)) {
        currentSet.add(mint);
      } else {
        currentSet.delete(mint);
      }
      socialRecord.relatedMints = [...currentSet];
      socialRecord.updatedAt = new Date().toISOString();
    }

    await this.persistQueued();
  }

  async upsertSocialPda(params: {
    address: string;
    userId: string;
    platform: number;
    platformLabel: string;
    relatedMints?: string[];
    createdBy?: string;
  }): Promise<StoredSocialPdaRecord> {
    const now = new Date().toISOString();
    const existing = this.data.socialPdas[params.address];
    const relatedMints = new Set([
      ...(existing?.relatedMints ?? []),
      ...(params.relatedMints ?? []),
    ]);

    const record: StoredSocialPdaRecord = {
      address: params.address,
      userId: params.userId,
      platform: params.platform,
      platformLabel: params.platformLabel,
      relatedMints: [...relatedMints],
      createdBy: params.createdBy ?? existing?.createdBy,
      lastKnownBalanceLamports:
        existing?.lastKnownBalanceLamports ??
        this.data.lastKnownBalances[params.address] ??
        "0",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.data.socialPdas[params.address] = record;
    await this.persistQueued();
    return record;
  }

  async setLastKnownBalance(address: string, lamports: bigint): Promise<void> {
    const serialized = lamports.toString();
    this.data.lastKnownBalances[address] = serialized;

    const socialRecord = this.data.socialPdas[address];
    if (socialRecord) {
      socialRecord.lastKnownBalanceLamports = serialized;
      socialRecord.updatedAt = new Date().toISOString();
    }

    await this.persistQueued();
  }

  async recordAuthorityChange(change: AuthorityHistoryRecord): Promise<void> {
    this.data.authorityHistory.push(change);
    await this.persistQueued();
  }

  async recordObservedClaim(address: string, relatedMints: string[]): Promise<void> {
    this.data.socialClaimCounts[address] = (this.data.socialClaimCounts[address] ?? 0) + 1;
    for (const mint of relatedMints) {
      const key = `${address}:${mint}`;
      this.data.socialClaimCountsByMint[key] = (this.data.socialClaimCountsByMint[key] ?? 0) + 1;
    }
    await this.persistQueued();
  }

  async setRuntimeAlertFilters(filters: AlertFilters): Promise<void> {
    this.data.runtimeConfig.alertFilters = serializeAlertFilters(filters);
    await this.persistQueued();
  }

  async upsertGitHubProfile(profile: GitHubProfileRecord): Promise<void> {
    this.data.githubProfiles[profile.accountId] = profile;
    await this.persistQueued();
  }

  private decorateShareholders(shareholders: NormalizedShareholder[]): NormalizedShareholder[] {
    return shareholders.map((shareholder) => {
      const socialRecord = this.data.socialPdas[shareholder.address];
      if (!socialRecord) {
        return {
          address: shareholder.address,
          shareBps: shareholder.shareBps,
        };
      }

      return {
        address: shareholder.address,
        shareBps: shareholder.shareBps,
        isSocial: true,
        userId: socialRecord.userId,
        platform: socialRecord.platform,
        platformLabel: socialRecord.platformLabel,
        githubLogin:
          socialRecord.platformLabel === "GitHub"
            ? this.data.githubProfiles[socialRecord.userId]?.login
            : undefined,
        githubName:
          socialRecord.platformLabel === "GitHub"
            ? this.data.githubProfiles[socialRecord.userId]?.name
            : undefined,
        githubUrl:
          socialRecord.platformLabel === "GitHub"
            ? this.data.githubProfiles[socialRecord.userId]?.htmlUrl
            : undefined,
      };
    });
  }

  private async persistQueued(): Promise<void> {
    this.persistChain = this.persistChain.then(() => this.persist());
    await this.persistChain;
  }

  private async persist(): Promise<void> {
    this.data.updatedAt = new Date().toISOString();
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
    await rename(tempPath, this.filePath);
  }
}
