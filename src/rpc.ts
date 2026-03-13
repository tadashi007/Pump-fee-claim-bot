import { Connection } from "@solana/web3.js";

import type { AppConfig } from "./utils";

export function createRpcConnection(config: AppConfig): Connection {
  return new Connection(config.rpcHttpUrl, {
    wsEndpoint: config.rpcWsUrl,
    commitment: config.commitment,
    confirmTransactionInitialTimeout: 60_000,
  });
}
