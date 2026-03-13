import {
  BorshAccountsCoder,
  BorshCoder,
  EventParser,
  type Idl,
} from "@coral-xyz/anchor";

import feeSharingIdlJson from "../idl/pump_fee_sharing.json";
import {
  describePlatform,
  normalizeShareholders,
  normalizeTimestamp,
  type NormalizedShareholder,
  SHARING_CONFIG_DISCRIMINATOR,
  SOCIAL_FEE_PDA_DISCRIMINATOR,
  statusFromAnchorEnum,
  toPublicKeyString,
} from "./utils";
import { PUMP_FEE_PROGRAM_ID } from "./utils";

const feeSharingIdl = feeSharingIdlJson as unknown as Idl;
const eventParser = new EventParser(PUMP_FEE_PROGRAM_ID, new BorshCoder(feeSharingIdl));
const accountsCoder = new BorshAccountsCoder(feeSharingIdl);

function readField<T>(input: Record<string, unknown>, ...keys: string[]): T {
  for (const key of keys) {
    if (key in input) {
      return input[key] as T;
    }
  }
  throw new Error(`Missing expected field: ${keys.join(" / ")}`);
}

export interface GovernanceCreateEvent {
  type: "CreateFeeSharingConfigEvent";
  signature: string;
  slot: number;
  timestamp: string;
  mint: string;
  sharingConfig: string;
  admin: string;
  status: "active" | "paused" | "revoked" | "unknown";
  shareholders: NormalizedShareholder[];
}

export interface GovernanceUpdateEvent {
  type: "UpdateFeeSharesEvent";
  signature: string;
  slot: number;
  timestamp: string;
  mint: string;
  sharingConfig: string;
  admin: string;
  shareholders: NormalizedShareholder[];
}

export interface GovernanceTransferEvent {
  type: "TransferFeeSharingAuthorityEvent";
  signature: string;
  slot: number;
  timestamp: string;
  mint: string;
  sharingConfig: string;
  oldAdmin: string;
  newAdmin: string;
}

export interface GovernanceRevokeEvent {
  type: "RevokeFeeSharingAuthorityEvent";
  signature: string;
  slot: number;
  timestamp: string;
  mint: string;
  sharingConfig: string;
  admin: string;
}

export interface GovernanceResetEvent {
  type: "ResetFeeSharingConfigEvent";
  signature: string;
  slot: number;
  timestamp: string;
  mint: string;
  sharingConfig: string;
  oldAdmin: string;
  newAdmin: string;
  oldShareholders: NormalizedShareholder[];
  newShareholders: NormalizedShareholder[];
}

export interface SocialFeePdaCreatedEvent {
  type: "SocialFeePdaCreated";
  signature: string;
  slot: number;
  timestamp: string;
  userId: string;
  platform: number;
  platformLabel: string;
  socialFeePda: string;
  createdBy: string;
}

export interface SocialFeePdaClaimedEvent {
  type: "SocialFeePdaClaimed";
  signature: string;
  slot: number;
  timestamp: string;
  userId: string;
  platform: number;
  platformLabel: string;
  socialFeePda: string;
  recipient: string;
  amountClaimedLamports: bigint;
}

export type DecodedFeeProgramEvent =
  | GovernanceCreateEvent
  | GovernanceUpdateEvent
  | GovernanceTransferEvent
  | GovernanceRevokeEvent
  | GovernanceResetEvent
  | SocialFeePdaCreatedEvent
  | SocialFeePdaClaimedEvent;

export interface DecodedSharingConfigAccount {
  mint: string;
  admin: string;
  adminRevoked: boolean;
  status: "active" | "paused" | "revoked" | "unknown";
  shareholders: NormalizedShareholder[];
}

export interface DecodedSocialFeePdaAccount {
  userId: string;
  platform: number;
  platformLabel: string;
  totalClaimedLamports: bigint;
  lastClaimedUnixSeconds: bigint;
}

export function parseFeeProgramEvents(
  logs: string[],
  signature: string,
  slot: number,
): DecodedFeeProgramEvent[] {
  let decodedEvents;
  try {
    decodedEvents = Array.from(eventParser.parseLogs(logs));
  } catch {
    return [];
  }
  const normalized: DecodedFeeProgramEvent[] = [];

  for (const event of decodedEvents) {
    const data = event.data as Record<string, unknown>;
    switch (event.name) {
      case "CreateFeeSharingConfigEvent":
        normalized.push({
          type: "CreateFeeSharingConfigEvent",
          signature,
          slot,
          timestamp: normalizeTimestamp(readField(data, "timestamp")),
          mint: toPublicKeyString(readField(data, "mint")),
          sharingConfig: toPublicKeyString(readField(data, "sharing_config", "sharingConfig")),
          admin: toPublicKeyString(readField(data, "admin")),
          status: statusFromAnchorEnum(readField(data, "status")),
          shareholders: normalizeShareholders(
            readField(data, "initial_shareholders", "initialShareholders"),
          ),
        } satisfies GovernanceCreateEvent);
        break;

      case "UpdateFeeSharesEvent":
        normalized.push({
          type: "UpdateFeeSharesEvent",
          signature,
          slot,
          timestamp: normalizeTimestamp(readField(data, "timestamp")),
          mint: toPublicKeyString(readField(data, "mint")),
          sharingConfig: toPublicKeyString(readField(data, "sharing_config", "sharingConfig")),
          admin: toPublicKeyString(readField(data, "admin")),
          shareholders: normalizeShareholders(
            readField(data, "new_shareholders", "newShareholders"),
          ),
        } satisfies GovernanceUpdateEvent);
        break;

      case "TransferFeeSharingAuthorityEvent":
        normalized.push({
          type: "TransferFeeSharingAuthorityEvent",
          signature,
          slot,
          timestamp: normalizeTimestamp(readField(data, "timestamp")),
          mint: toPublicKeyString(readField(data, "mint")),
          sharingConfig: toPublicKeyString(readField(data, "sharing_config", "sharingConfig")),
          oldAdmin: toPublicKeyString(readField(data, "old_admin", "oldAdmin")),
          newAdmin: toPublicKeyString(readField(data, "new_admin", "newAdmin")),
        } satisfies GovernanceTransferEvent);
        break;

      case "RevokeFeeSharingAuthorityEvent":
        normalized.push({
          type: "RevokeFeeSharingAuthorityEvent",
          signature,
          slot,
          timestamp: normalizeTimestamp(readField(data, "timestamp")),
          mint: toPublicKeyString(readField(data, "mint")),
          sharingConfig: toPublicKeyString(readField(data, "sharing_config", "sharingConfig")),
          admin: toPublicKeyString(readField(data, "admin")),
        } satisfies GovernanceRevokeEvent);
        break;

      case "ResetFeeSharingConfigEvent":
        normalized.push({
          type: "ResetFeeSharingConfigEvent",
          signature,
          slot,
          timestamp: normalizeTimestamp(readField(data, "timestamp")),
          mint: toPublicKeyString(readField(data, "mint")),
          sharingConfig: toPublicKeyString(readField(data, "sharing_config", "sharingConfig")),
          oldAdmin: toPublicKeyString(readField(data, "old_admin", "oldAdmin")),
          newAdmin: toPublicKeyString(readField(data, "new_admin", "newAdmin")),
          oldShareholders: normalizeShareholders(
            readField(data, "old_shareholders", "oldShareholders"),
          ),
          newShareholders: normalizeShareholders(
            readField(data, "new_shareholders", "newShareholders"),
          ),
        } satisfies GovernanceResetEvent);
        break;

      case "SocialFeePdaCreated":
        normalized.push({
          type: "SocialFeePdaCreated",
          signature,
          slot,
          timestamp: normalizeTimestamp(readField(data, "timestamp")),
          userId: String(readField(data, "user_id", "userId")),
          platform: Number(readField(data, "platform")),
          platformLabel: describePlatform(Number(readField(data, "platform"))),
          socialFeePda: toPublicKeyString(readField(data, "social_fee_pda", "socialFeePda")),
          createdBy: toPublicKeyString(readField(data, "created_by", "createdBy")),
        } satisfies SocialFeePdaCreatedEvent);
        break;

      case "SocialFeePdaClaimed":
        normalized.push({
          type: "SocialFeePdaClaimed",
          signature,
          slot,
          timestamp: normalizeTimestamp(readField(data, "timestamp")),
          userId: String(readField(data, "user_id", "userId")),
          platform: Number(readField(data, "platform")),
          platformLabel: describePlatform(Number(readField(data, "platform"))),
          socialFeePda: toPublicKeyString(readField(data, "social_fee_pda", "socialFeePda")),
          recipient: toPublicKeyString(readField(data, "recipient")),
          amountClaimedLamports: BigInt(
            readField<{ toString: () => string }>(data, "amount_claimed", "amountClaimed").toString(),
          ),
        } satisfies SocialFeePdaClaimedEvent);
        break;

      default:
        break;
    }
  }

  return normalized;
}

export function decodeSharingConfigAccount(data: Buffer): DecodedSharingConfigAccount | null {
  if (!data.subarray(0, 8).equals(SHARING_CONFIG_DISCRIMINATOR)) {
    return null;
  }

  const decoded = accountsCoder.decode("SharingConfig", data) as Record<string, unknown>;
  const adminRevoked = Boolean(readField(decoded, "admin_revoked", "adminRevoked"));
  const status = adminRevoked
    ? "revoked"
    : statusFromAnchorEnum(readField(decoded, "status"));

  return {
    mint: toPublicKeyString(readField(decoded, "mint")),
    admin: toPublicKeyString(readField(decoded, "admin")),
    adminRevoked,
    status,
    shareholders: normalizeShareholders(readField(decoded, "shareholders")),
  };
}

export function decodeSocialFeePdaAccount(data: Buffer): DecodedSocialFeePdaAccount | null {
  if (!data.subarray(0, 8).equals(SOCIAL_FEE_PDA_DISCRIMINATOR)) {
    return null;
  }

  const decoded = accountsCoder.decode("SocialFeePda", data) as Record<string, unknown>;
  const platform = Number(readField(decoded, "platform"));

  return {
    userId: String(readField(decoded, "user_id", "userId")),
    platform,
    platformLabel: describePlatform(platform),
    totalClaimedLamports: BigInt(
      readField<{ toString: () => string }>(decoded, "total_claimed", "totalClaimed").toString(),
    ),
    lastClaimedUnixSeconds: BigInt(
      readField<{ toString: () => string }>(decoded, "last_claimed", "lastClaimed").toString(),
    ),
  };
}
