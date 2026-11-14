// Reads NEAR straight from public RPC. The site has no backend of its own.

const RPCS = {
  testnet: ["https://rpc.testnet.fastnear.com", "https://test.rpc.fastnear.com", "https://near-testnet.drpc.org"],
  mainnet: ["https://free.rpc.fastnear.com", "https://near.drpc.org", "https://rpc.mainnet.near.org"],
};
const EXPLORERS = { testnet: "https://testnet.nearblocks.io", mainnet: "https://nearblocks.io" };

export async function loadConfig() {
  const res = await fetch("config.json", { cache: "no-store" });
  if (!res.ok) return { deployed: false, network: "testnet", demo: false };
  return res.json();
}

/** `rpcUrls` overrides the public endpoints, for a site that runs its own RPC. */
export function makeChain(network, rpcUrls) {
  const urls = rpcUrls?.length ? rpcUrls : RPCS[network];
  const explorer = EXPLORERS[network];

  async function rpc(params) {
    let lastError;
    for (const url of urls) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: "grapevine", method: "query", params }),
        });
        if (!res.ok) {
          lastError = new Error(`RPC answered ${res.status}`);
          continue;
        }
        return await res.json();
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError ?? new Error("no RPC endpoint answered");
  }

  /** A read-only contract call. */
  async function view(contract, method, args = {}) {
    const bytes = new TextEncoder().encode(JSON.stringify(args));
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    const body = await rpc({
      request_type: "call_function",
      finality: "final",
      account_id: contract,
      method_name: method,
      args_base64: btoa(binary),
    });
    if (body.error || body.result?.error) {
      const raw = JSON.stringify(body.error ?? body.result.error);
      const match = raw.match(/ERR_[A-Z_]+/);
      throw new Error(match ? match[0] : raw);
    }
    const text = new TextDecoder().decode(new Uint8Array(body.result.result));
    return text.length ? JSON.parse(text) : null;
  }

  /** An account's balance in yoctoNEAR, or null when it does not exist. */
  async function balance(account) {
    const body = await rpc({ request_type: "view_account", finality: "final", account_id: account });
    return body.result ? BigInt(body.result.amount) : null;
  }

  /** What an account can spend: its balance less what its storage locks (1e19 yoctoNEAR a byte). */
  async function spendable(account) {
    const body = await rpc({ request_type: "view_account", finality: "final", account_id: account });
    if (!body.result) return null;
    const free = BigInt(body.result.amount) - BigInt(body.result.storage_usage) * 10n ** 19n;
    return free > 0n ? free : 0n;
  }

  return {
    view,
    balance,
    spendable,
    txUrl: (hash) => `${explorer}/txns/${hash}`,
    accountUrl: (id) => `${explorer}/address/${id}`,
  };
}

const YOCTO = 10n ** 24n;

/** yoctoNEAR as a short decimal: "2", "0.25", "0.125". */
export function near(yocto, digits = 3) {
  const v = BigInt(yocto);
  const unit = 10n ** BigInt(24 - digits);
  const scaled = (v + unit / 2n) / unit;
  const whole = scaled / 10n ** BigInt(digits);
  const frac = (scaled % 10n ** BigInt(digits)).toString().padStart(digits, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** "1.5" as yoctoNEAR text. */
export function toYocto(amount) {
  const [whole, frac = ""] = String(amount).trim().split(".");
  return (BigInt(whole || "0") * YOCTO + BigInt((frac + "0".repeat(24)).slice(0, 24))).toString();
}

export const nsToMs = (ns) => Number(BigInt(ns) / 1_000_000n);

export function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 50) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function left(ms) {
  const s = Math.round((ms - Date.now()) / 1000);
  if (s <= 0) return "closed to new passes";
  if (s < 3600) return `${Math.round(s / 60)} min left`;
  if (s < 86400) return `${Math.round(s / 3600)} h left`;
  return `${Math.round(s / 86400)} days left`;
}

/** A readable name from an account id when there is no profile: "bea.grapevine-hq.testnet" -> "Bea". */
export function fallbackName(account) {
  const first = account.split(".")[0];
  if (/^[0-9a-f]{64}$/.test(account)) return `${account.slice(0, 6)}…${account.slice(-4)}`;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
