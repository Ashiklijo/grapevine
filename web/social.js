// near.social, read straight from FastData KV. No indexer of our own, no API key, no backend.
//
// near.social stores everything as key-value writes to the account `social` (the social-kv/1
// standard, https://api2.near.social/standard.md). FastNEAR serves those writes publicly for
// both networks, so the same code reads mainnet's near.social and the same standard on testnet.
//
// This module runs unchanged in the browser and in Node.

export const SOCIAL_ACCOUNT = "social";
export const KV_URL = {
  testnet: "https://kv.test.fastnear.com",
  mainnet: "https://kv.main.fastnear.com",
};
const FASTFS_URL = { mainnet: "https://main.fastfs.io", testnet: "https://test.fastfs.io" };

const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export const isAccountId = (s) => typeof s === "string" && s.length >= 2 && s.length <= 64 && ACCOUNT_RE.test(s);

export const postRef = (account, id) => `${account}/${id}`;
export function parseRef(ref) {
  if (typeof ref !== "string") return null;
  const cut = ref.lastIndexOf("/");
  if (cut < 1) return null;
  const account = ref.slice(0, cut);
  const id = ref.slice(cut + 1);
  return isAccountId(account) && /^[1-9][0-9]{0,15}$/.test(id) ? { account, id } : null;
}

/** A fresh post id: the time in milliseconds, bumped past the last one used. */
let lastId = 0;
export function newPostId() {
  lastId = Math.max(Date.now(), lastId + 1);
  return String(lastId);
}

/** The args of one `__fastdata_kv` call that publishes a post, quote or reply. */
export function postArgs({ id = newPostId(), text, quote, replyTo, root }) {
  const value = { text };
  if (quote) value.quote = quote;
  const args = {};
  if (replyTo) {
    value.reply_to = replyTo;
    value.root = root || replyTo;
    const parent = parseRef(replyTo);
    args[`reply/${parent.account}/${parent.id}/${id}`] = {};
  }
  args[`post/${id}`] = value;
  return { id, args };
}

/** The args that set a profile. Empty fields are left out. */
export function profileArgs({ name, about, website }) {
  const args = {};
  if (name) args["profile/name"] = name;
  if (about) args["profile/about"] = about;
  if (website) args["profile/links/website"] = website;
  return args;
}

export const followArgs = (accounts) => Object.fromEntries(accounts.map((a) => [`graph/follow/${a}`, {}]));

/** Words worth matching on, from a quest's title and brief. */
const STOP = new Set(
  "about after again also been before being could does every from have into just like more most much need needs only other over some than that their them then there these they this very want what when where which while will with would your quest reward find someone anyone people person help please near".split(
    " ",
  ),
);
export function keywords(text) {
  const words = (text || "").toLowerCase().match(/[\p{L}][\p{L}-]{3,}/gu) || [];
  return [...new Set(words.filter((w) => !STOP.has(w)))].slice(0, 12);
}

/** A reader for one network. */
export function makeSocial(network, fetcher = globalThis.fetch, kvUrl = null) {
  const base = kvUrl || KV_URL[network];
  if (!base) throw new Error(`unknown network ${network}`);

  async function request(path, body) {
    const res = await fetcher(`${base}${path}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`FastData KV answered ${res.status} for ${path}`);
    return res.json();
  }

  /** Every latest entry under a key prefix written by one account, up to `max`. */
  async function latest(account, keyPrefix, max = 200) {
    const out = [];
    let pageToken;
    do {
      const body = { key_prefix: keyPrefix, limit: Math.min(200, max - out.length) };
      if (pageToken) body.page_token = pageToken;
      const page = await request(`/v0/latest/${SOCIAL_ACCOUNT}/${account}`, body);
      out.push(...(page.entries || []));
      pageToken = page.page_token;
    } while (pageToken && out.length < max);
    return out;
  }

  /** The latest value of exact keys, as a Map from "account/key" to the entry. */
  async function multi(pairs) {
    const found = new Map();
    for (let i = 0; i < pairs.length; i += 100) {
      const chunk = pairs.slice(i, i + 100);
      const page = await request("/v0/multi", { keys: chunk.map(([account, key]) => `${SOCIAL_ACCOUNT}/${account}/${key}`) });
      for (const e of page.entries || []) {
        if (e && e.value !== null && e.value !== undefined) found.set(`${e.predecessor_id}/${e.key}`, e);
      }
    }
    return found;
  }

  function avatarUrl(uri) {
    if (typeof uri !== "string" || !uri.startsWith("fastfs://")) return null;
    return `${FASTFS_URL[network]}/${uri.slice("fastfs://".length)}`;
  }

  /** Display names, bios and avatars for many accounts in one request. */
  async function profiles(accounts) {
    const unique = [...new Set(accounts.filter(isAccountId))];
    const pairs = unique.flatMap((a) => [
      [a, "profile/name"],
      [a, "profile/about"],
      [a, "profile/avatar"],
    ]);
    const found = pairs.length ? await multi(pairs) : new Map();
    const text = (a, key) => {
      const v = found.get(`${a}/${key}`)?.value;
      return typeof v === "string" && v.length ? v : null;
    };
    return new Map(
      unique.map((a) => [a, { account: a, name: text(a, "profile/name"), about: text(a, "profile/about"), avatar: avatarUrl(text(a, "profile/avatar")) }]),
    );
  }

  function toPost(entry) {
    const v = entry?.value;
    if (!v || typeof v !== "object") return null;
    const id = entry.key.slice("post/".length);
    return {
      ref: postRef(entry.predecessor_id, id),
      account: entry.predecessor_id,
      id,
      text: typeof v.text === "string" ? v.text : "",
      quote: typeof v.quote === "string" ? v.quote : null,
      replyTo: typeof v.reply_to === "string" ? v.reply_to : null,
      at: Math.floor(Number(BigInt(entry.block_timestamp) / 1_000_000n)),
      blockHeight: entry.block_height,
    };
  }

  /** Posts by reference, as a Map from reference to post. Missing and deleted ones are left out. */
  async function posts(refs) {
    const parsed = [...new Set(refs)].map(parseRef).filter(Boolean);
    const found = parsed.length ? await multi(parsed.map((r) => [r.account, `post/${r.id}`])) : new Map();
    const out = new Map();
    for (const entry of found.values()) {
      const post = toPost(entry);
      if (post) out.set(post.ref, post);
    }
    return out;
  }

  async function recentPosts(account, max = 5) {
    const entries = await latest(account, "post/", 200);
    return entries
      .map(toPost)
      .filter(Boolean)
      .sort((a, b) => b.at - a.at)
      .slice(0, max);
  }

  /** Accounts this account follows. An edge is active when its value is an object. */
  async function following(account, max = 200) {
    const entries = await latest(account, "graph/follow/", max);
    return entries.filter((e) => e.value && typeof e.value === "object").map((e) => e.key.slice("graph/follow/".length));
  }

  /** Accounts that follow this account: the same key, read across every writer. */
  async function followers(account, max = 200) {
    const page = await request(`/v0/latest/${SOCIAL_ACCOUNT}`, { key: `graph/follow/${account}`, limit: Math.min(200, max) });
    return (page.entries || []).filter((e) => e.value && typeof e.value === "object").map((e) => e.predecessor_id);
  }

  /**
   * People around `viewer` whose profile or recent posts mention what a quest is looking for.
   * This is what makes a pass targeted: the app suggests who to tell, not a blast to everyone.
   */
  async function suggest(viewer, questText, max = 6) {
    const words = keywords(questText);
    if (!words.length) return [];
    const [out, back] = await Promise.all([following(viewer, 80).catch(() => []), followers(viewer, 80).catch(() => [])]);
    const circle = [...new Set([...out, ...back])].filter((a) => a !== viewer).slice(0, 60);
    if (!circle.length) return [];
    const [who, recent] = await Promise.all([
      profiles(circle),
      Promise.all(circle.map((a) => recentPosts(a, 4).catch(() => []))),
    ]);
    const scored = circle.map((account, i) => {
      const profile = who.get(account);
      const haystack = [profile?.name, profile?.about, ...recent[i].map((p) => p.text)].filter(Boolean).join(" \n ").toLowerCase();
      const hits = words.filter((w) => haystack.includes(w));
      const proof = recent[i].find((p) => hits.some((w) => p.text.toLowerCase().includes(w)));
      return {
        account,
        name: profile?.name ?? null,
        about: profile?.about ?? null,
        hits,
        because: proof ? proof.text : profile?.about ?? null,
        mutual: out.includes(account) && back.includes(account),
      };
    });
    return scored
      .filter((s) => s.hits.length)
      .sort((a, b) => b.hits.length - a.hits.length || Number(b.mutual) - Number(a.mutual))
      .slice(0, max);
  }

  return { network, latest, multi, profiles, posts, recentPosts, following, followers, suggest, avatarUrl };
}
