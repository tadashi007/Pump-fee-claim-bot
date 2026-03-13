import type { Commitment, Connection, Logs, LogsCallback } from "@solana/web3.js";

import { parseFeeProgramEvents, type DecodedFeeProgramEvent } from "./eventDecoder";
import { PUMP_FEE_PROGRAM_ID } from "./utils";

export interface FeeProgramEventCallbacks {
  onEvent: (event: DecodedFeeProgramEvent) => Promise<void> | void;
  onError?: (error: unknown, logs: Logs) => void;
}

export class FeeProgramEventListener {
  private subscriptionId: number | null = null;

  constructor(
    private readonly connection: Connection,
    private readonly callbacks: FeeProgramEventCallbacks,
    private readonly commitment: Commitment,
  ) {}

  start(): void {
    if (this.subscriptionId != null) {
      return;
    }

    const callback: LogsCallback = async (logs, context) => {
      try {
        const events = parseFeeProgramEvents(logs.logs, logs.signature, context.slot);
        for (const event of events) {
          await this.callbacks.onEvent(event);
        }
      } catch (error) {
        this.callbacks.onError?.(error, logs);
      }
    };

    this.subscriptionId = this.connection.onLogs(
      PUMP_FEE_PROGRAM_ID,
      callback,
      this.commitment,
    );
  }

  async stop(): Promise<void> {
    if (this.subscriptionId == null) {
      return;
    }
    await this.connection.removeOnLogsListener(this.subscriptionId);
    this.subscriptionId = null;
  }
}
