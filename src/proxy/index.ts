import { startHttpProxy, type HttpProxyLogEntry } from "./http.js";

export type NetLogEntry = HttpProxyLogEntry;

export type NetworkSidecars = {
  proxyPort: number;
  log: NetLogEntry[];
  close: () => Promise<void>;
};

export const PROXY_VM_IP = "10.0.2.100";
export const PROXY_VM_PORT = 8080;
export const BIND_HOST = "127.0.0.1";

export async function startNetworkSidecars(
  allowlist: string[]
): Promise<NetworkSidecars> {
  const log: NetLogEntry[] = [];
  const onLog = (entry: NetLogEntry) => log.push(entry);

  const proxy = await startHttpProxy({
    bindHost: BIND_HOST,
    allowlist,
    onLog,
  });

  return {
    proxyPort: proxy.port,
    log,
    close: async () => {
      await proxy.close();
    },
  };
}
