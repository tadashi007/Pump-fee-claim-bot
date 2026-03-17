import type { Commitment } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";

export const PUMP_CORE_PROGRAM_ID = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
);

export const PUMP_FEE_PROGRAM_ID = new PublicKey(
  "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ",
);

export const SHARING_CONFIG_SEED = Buffer.from("sharing-config");
export const SOCIAL_FEE_PDA_SEED = Buffer.from("social-fee-pda");

export const SHARING_CONFIG_DISCRIMINATOR = Buffer.from([
  216, 74, 9, 0, 56, 140, 93, 75,
]);

export const SOCIAL_FEE_PDA_DISCRIMINATOR = Buffer.from([
  139, 96, 53, 17, 42, 169, 206, 150,
]);

export enum SocialPlatform {
  Pump = 0,
  X = 1,
  GitHub = 2,
}

export type TokenStatus = "active" | "paused" | "revoked" | "unknown";

export interface AppConfig {
  rpcHttpUrl: string;
  rpcWsUrl: string;
  commitment: Commitment;
  dataFile: string;
  bootstrapExisting: boolean;
  telegramBotToken?: string;
  telegramChatIds: string[];
  telegramChatId?: string;
  githubToken?: string;
  alertFilters: AlertFilters;
}

export interface AlertFilters {
  paused?: boolean;
  eventTypes?: Set<AlertEventType>;
  platforms?: Set<number>;
  mintAllowlist?: Set<string>;
  mintBlocklist?: Set<string>;
  minClaimLamports?: bigint;
}

export interface SerializedAlertFilters {
  paused?: boolean;
  eventTypes?: AlertEventType[];
  platforms?: number[];
  mintAllowlist?: string[];
  mintBlocklist?: string[];
  minClaimLamports?: string;
}

export type AlertEventType =
  | "create"
  | "update"
  | "transfer"
  | "revoke"
  | "reset"
  | "claim";

export interface NormalizedShareholder {
  address: string;
  shareBps: number;
  isSocial?: boolean;
  userId?: string;
  platform?: number;
  platformLabel?: string;
  githubLogin?: string;
  githubName?: string;
  githubUrl?: string;
}

export function getConfig(): AppConfig {
  const rpcHttpUrl = requireEnv("RPC_HTTP_URL");
  const rpcWsUrl = process.env.RPC_WS_URL?.trim() || deriveWsUrl(rpcHttpUrl);
  const commitment = parseCommitment(process.env.COMMITMENT);
  const dataFile = process.env.DATA_FILE?.trim() || "./data/pump-fee-monitor.json";
  const telegramChatId = emptyToUndefined(process.env.TELEGRAM_CHAT_ID);
  const telegramChatIds = parseTelegramChatIds(process.env.TELEGRAM_CHAT_IDS, telegramChatId);

  return {
    rpcHttpUrl,
    rpcWsUrl,
    commitment,
    dataFile,
    bootstrapExisting: parseBoolean(process.env.BOOTSTRAP_EXISTING, true),
    telegramBotToken: emptyToUndefined(process.env.TELEGRAM_BOT_TOKEN),
    telegramChatIds,
    telegramChatId,
    githubToken: emptyToUndefined(process.env.GITHUB_TOKEN),
    alertFilters: {
      eventTypes: parseAlertEventTypes(process.env.ALERT_EVENT_TYPES),
      platforms: parsePlatformFilter(process.env.ALERT_PLATFORMS),
      mintAllowlist: parsePublicKeySet(process.env.ALERT_MINT_ALLOWLIST),
      mintBlocklist: parsePublicKeySet(process.env.ALERT_MINT_BLOCKLIST),
      minClaimLamports: parseSolToLamports(process.env.ALERT_MIN_CLAIM_SOL),
    },
  };
}

export function deriveWsUrl(httpUrl: string): string {
  if (httpUrl.startsWith("https://")) {
    return `wss://${httpUrl.slice("https://".length)}`;
  }
  if (httpUrl.startsWith("http://")) {
    return `ws://${httpUrl.slice("http://".length)}`;
  }
  throw new Error(`Unable to derive WebSocket URL from RPC_HTTP_URL: ${httpUrl}`);
}

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function parseCommitment(value?: string): Commitment {
  const normalized = value?.trim() || "confirmed";
  if (normalized === "processed" || normalized === "confirmed" || normalized === "finalized") {
    return normalized;
  }
  throw new Error(`Unsupported COMMITMENT "${normalized}"`);
}

export function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null || value.trim() === "") {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`Invalid boolean value "${value}"`);
}

export function parseCsv(value: string | undefined): string[] {
  if (!value?.trim()) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseAlertEventTypes(value: string | undefined): Set<AlertEventType> | undefined {
  const items = parseCsv(value);
  if (items.length === 0) {
    return undefined;
  }

  const allowed = new Set<AlertEventType>([
    "create",
    "update",
    "transfer",
    "revoke",
    "reset",
    "claim",
  ]);

  const parsed = new Set<AlertEventType>();
  for (const item of items) {
    const normalized = item.toLowerCase() as AlertEventType;
    if (!allowed.has(normalized)) {
      throw new Error(`Invalid ALERT_EVENT_TYPES value "${item}"`);
    }
    parsed.add(normalized);
  }

  return parsed;
}

export function parsePlatformFilter(value: string | undefined): Set<number> | undefined {
  const items = parseCsv(value);
  if (items.length === 0) {
    return undefined;
  }

  const parsed = new Set<number>();
  for (const item of items) {
    const normalized = item.toLowerCase();
    switch (normalized) {
      case "pump":
        parsed.add(SocialPlatform.Pump);
        break;
      case "x":
      case "twitter":
        parsed.add(SocialPlatform.X);
        break;
      case "github":
        parsed.add(SocialPlatform.GitHub);
        break;
      default:
        throw new Error(`Invalid ALERT_PLATFORMS value "${item}"`);
    }
  }

  return parsed;
}

export function parsePublicKeySet(value: string | undefined): Set<string> | undefined {
  const items = parseCsv(value);
  if (items.length === 0) {
    return undefined;
  }

  const parsed = new Set<string>();
  for (const item of items) {
    parsed.add(new PublicKey(item).toBase58());
  }
  return parsed;
}

export function parseSolToLamports(value: string | undefined): bigint | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  const normalized = value.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new Error(`Invalid ALERT_MIN_CLAIM_SOL value "${value}"`);
  }

  const [wholePart, fractionPartRaw = ""] = normalized.split(".");
  const fractionPart = fractionPartRaw.padEnd(9, "0").slice(0, 9);
  return BigInt(wholePart) * 1_000_000_000n + BigInt(fractionPart || "0");
}

export function emptyToUndefined(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function parseTelegramChatIds(value: string | undefined, fallback?: string): string[] {
  const parsed = parseCsv(value);
  if (parsed.length > 0) {
    return uniqueStrings(parsed);
  }
  return fallback ? [fallback] : [];
}

export function toPublicKeyString(value: unknown): string {
  if (value instanceof PublicKey) {
    return value.toBase58();
  }
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object" && "toBase58" in value && typeof (value as any).toBase58 === "function") {
    return (value as any).toBase58();
  }
  throw new Error(`Value is not a public key: ${String(value)}`);
}

export function normalizeShareholders(raw: unknown): NormalizedShareholder[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.map((entry) => {
    const item = entry as Record<string, unknown>;
    return {
      address: toPublicKeyString(item.address),
      shareBps: Number(item.share_bps ?? item.shareBps ?? 0),
    };
  });
}

export function normalizeTimestamp(value: unknown): string {
  const bigintValue = toBigInt(value);
  if (bigintValue <= 0n) {
    return new Date().toISOString();
  }
  return new Date(Number(bigintValue) * 1000).toISOString();
}

export function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    return BigInt(value);
  }
  if (typeof value === "string") {
    return BigInt(value);
  }
  if (value && typeof value === "object") {
    const candidate = value as { toString?: () => string };
    if (typeof candidate.toString === "function") {
      return BigInt(candidate.toString());
    }
  }
  throw new Error(`Unable to convert value to bigint: ${String(value)}`);
}

export function formatLamports(lamports: bigint): string {
  const sign = lamports < 0n ? "-" : "";
  const absolute = lamports < 0n ? -lamports : lamports;
  const whole = absolute / 1_000_000_000n;
  const fraction = absolute % 1_000_000_000n;
  const trimmedFraction = fraction.toString().padStart(9, "0").replace(/0+$/, "");
  return trimmedFraction ? `${sign}${whole}.${trimmedFraction} SOL` : `${sign}${whole} SOL`;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size) as T[]);
  }
  return result;
}

export function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function describePlatform(platform: number): string {
  switch (platform) {
    case SocialPlatform.Pump:
      return "Pump";
    case SocialPlatform.X:
      return "X";
    case SocialPlatform.GitHub:
      return "GitHub";
    default:
      return `Unknown(${platform})`;
  }
}

export function isMintAllowed(filters: AlertFilters, mints: readonly string[]): boolean {
  if (mints.length === 0) {
    return !filters.mintAllowlist;
  }

  if (filters.mintBlocklist && mints.some((mint) => filters.mintBlocklist!.has(mint))) {
    return false;
  }

  if (!filters.mintAllowlist) {
    return true;
  }

  return mints.some((mint) => filters.mintAllowlist!.has(mint));
}

export function describeAlertFilters(filters: AlertFilters): string[] {
  const lines: string[] = [`Status: ${filters.paused ? "paused" : "running"}`];

  if (filters.eventTypes && filters.eventTypes.size > 0) {
    lines.push(`Alert events: ${[...filters.eventTypes].join(", ")}`);
  }
  if (filters.platforms && filters.platforms.size > 0) {
    lines.push(
      `Alert platforms: ${[...filters.platforms].map((platform) => describePlatform(platform)).join(", ")}`,
    );
  }
  if (filters.mintAllowlist && filters.mintAllowlist.size > 0) {
    lines.push(`Mint allowlist: ${filters.mintAllowlist.size} mint(s)`);
  }
  if (filters.mintBlocklist && filters.mintBlocklist.size > 0) {
    lines.push(`Mint blocklist: ${filters.mintBlocklist.size} mint(s)`);
  }
  if (filters.minClaimLamports != null) {
    lines.push(`Min claim alert: ${formatLamports(filters.minClaimLamports)}`);
  }

  return lines;
}

export function cloneAlertFilters(filters: AlertFilters): AlertFilters {
  return {
    paused: filters.paused,
    eventTypes: filters.eventTypes ? new Set(filters.eventTypes) : undefined,
    platforms: filters.platforms ? new Set(filters.platforms) : undefined,
    mintAllowlist: filters.mintAllowlist ? new Set(filters.mintAllowlist) : undefined,
    mintBlocklist: filters.mintBlocklist ? new Set(filters.mintBlocklist) : undefined,
    minClaimLamports: filters.minClaimLamports,
  };
}

export function serializeAlertFilters(filters: AlertFilters): SerializedAlertFilters {
  return {
    paused: filters.paused,
    eventTypes: filters.eventTypes ? [...filters.eventTypes] : undefined,
    platforms: filters.platforms ? [...filters.platforms] : undefined,
    mintAllowlist: filters.mintAllowlist ? [...filters.mintAllowlist] : undefined,
    mintBlocklist: filters.mintBlocklist ? [...filters.mintBlocklist] : undefined,
    minClaimLamports: filters.minClaimLamports?.toString(),
  };
}

export function deserializeAlertFilters(
  filters?: SerializedAlertFilters | null,
): AlertFilters | undefined {
  if (!filters) {
    return undefined;
  }

  return {
    paused: filters.paused,
    eventTypes: filters.eventTypes?.length ? new Set(filters.eventTypes) : undefined,
    platforms: filters.platforms?.length ? new Set(filters.platforms) : undefined,
    mintAllowlist: filters.mintAllowlist?.length ? new Set(filters.mintAllowlist) : undefined,
    mintBlocklist: filters.mintBlocklist?.length ? new Set(filters.mintBlocklist) : undefined,
    minClaimLamports: filters.minClaimLamports ? BigInt(filters.minClaimLamports) : undefined,
  };
}

export function deriveSharingConfigPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SHARING_CONFIG_SEED, mint.toBuffer()],
    PUMP_FEE_PROGRAM_ID,
  )[0];
}

export function deriveSocialFeePda(userId: string, platform: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      SOCIAL_FEE_PDA_SEED,
      Buffer.from(userId),
      Buffer.from([platform]),
    ],
    PUMP_FEE_PROGRAM_ID,
  )[0];
}

export function formatShareholders(shareholders: NormalizedShareholder[]): string {
  if (shareholders.length === 0) {
    return "none";
  }

  return shareholders
    .map((shareholder) => {
      const social = shareholder.isSocial
        ? ` (${shareholder.platformLabel ?? "social"}:${shareholder.userId ?? shareholder.address})`
        : "";
      return `${shareholder.address}=${shareholder.shareBps}bps${social}`;
    })
    .join(", ");
}

export function statusFromAnchorEnum(value: unknown): TokenStatus {
  if (typeof value === "string") {
    return value.toLowerCase() === "active"
      ? "active"
      : value.toLowerCase() === "paused"
        ? "paused"
        : "unknown";
  }

  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.includes("Active")) {
      return "active";
    }
    if (keys.includes("Paused")) {
      return "paused";
    }
  }

  return "unknown";
}
