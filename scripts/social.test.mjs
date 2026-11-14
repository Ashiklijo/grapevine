// Checks for the near.social writer and reader that need no network: the arguments this project
// sends to `social` must follow the social-kv/1 standard exactly, or the indexer drops them.
//
//   node --test scripts/
import assert from "node:assert/strict";
import { test } from "node:test";
import { followArgs, isAccountId, keywords, makeSocial, newPostId, parseRef, postArgs, postRef, profileArgs } from "../web/social.js";
import { passText, sponsorText } from "./actions.mjs";

test("a post is one key, post/{id}, holding its text", () => {
  const { id, args } = postArgs({ id: "1794400000000", text: "gm #grapevine" });
  assert.equal(id, "1794400000000");
  assert.deepEqual(args, { "post/1794400000000": { text: "gm #grapevine" } });
});

test("a pass is a quote of the post it came from", () => {
  const { args } = postArgs({ id: "5", text: "Passing this on", quote: "noor.testnet/4" });
  assert.deepEqual(args, { "post/5": { text: "Passing this on", quote: "noor.testnet/4" } });
});

test("a reply writes the post and its backlink in the same call, with the thread's root", () => {
  const { args } = postArgs({ id: "9", text: "I can do this", replyTo: "noor.testnet/4", root: "noor.testnet/4" });
  assert.deepEqual(args, {
    "reply/noor.testnet/4/9": {},
    "post/9": { text: "I can do this", reply_to: "noor.testnet/4", root: "noor.testnet/4" },
  });
});

test("post ids are milliseconds, never repeat, and stay inside 2^53", () => {
  const a = Number(newPostId());
  const b = Number(newPostId());
  assert.ok(b > a);
  assert.ok(Math.abs(a - Date.now()) < 5000);
  assert.ok(Number.isSafeInteger(b));
});

test("post references parse only when the account and the id are valid", () => {
  assert.deepEqual(parseRef("bea.grapevine-hq.testnet/1794400000000"), { account: "bea.grapevine-hq.testnet", id: "1794400000000" });
  assert.equal(postRef("a.near", "7"), "a.near/7");
  for (const bad of ["a.near", "a.near/", "a.near/07", "a.near/x", "A.near/7", "/7", "a.near/12345678901234567", null, 7]) {
    assert.equal(parseRef(bad), null, String(bad));
  }
});

test("account ids follow NEAR's rule", () => {
  for (const good of ["social", "bea.testnet", "v1.grapevine-hq.testnet", "a_b-c.near", "0".repeat(64)]) assert.ok(isAccountId(good), good);
  for (const bad of ["a", "A.near", "a..near", ".near", "a.near.", "a b.near", "x".repeat(65), "-a.near"]) assert.ok(!isAccountId(bad), bad);
});

test("profiles and follows use the standard's keys", () => {
  assert.deepEqual(profileArgs({ name: "Bea", about: "Shift lead" }), { "profile/name": "Bea", "profile/about": "Shift lead" });
  assert.deepEqual(profileArgs({ name: "G", website: "https://x.org" }), { "profile/name": "G", "profile/links/website": "https://x.org" });
  assert.deepEqual(followArgs(["a.near", "b.near"]), { "graph/follow/a.near": {}, "graph/follow/b.near": {} });
});

test("keywords keep what a quest is looking for and drop filler", () => {
  const words = keywords("Find a sign-language interpreter for Saturday's members' meeting. We need someone qualified.");
  assert.ok(words.includes("interpreter"));
  assert.ok(words.includes("sign-language"));
  assert.ok(!words.includes("find") && !words.includes("need") && !words.includes("someone"));
  assert.deepEqual(keywords(""), []);
});

test("what people post mentions the DAO, tags the quest and carries the link", () => {
  const sponsor = sponsorText({ title: "Find an interpreter", brief: "Saturday at 10.", reward: "2", dao: "coop.sputnikv2.testnet", link: "https://x.org/#quest/3" });
  assert.match(sponsor, /@coop\.sputnikv2\.testnet/);
  assert.match(sponsor, /#grapevine/);
  assert.match(sponsor, /https:\/\/x\.org\/#quest\/3/);
  const pass = passText({ title: "Find an interpreter", reward: "2", link: "https://x.org/#quest/3?via=bea.testnet", mentions: ["kofi.testnet"] });
  assert.match(pass, /cc @kofi\.testnet/);
  assert.match(pass, /via=bea\.testnet/);
  assert.ok(sponsor.length < 25_000 && pass.length < 25_000);
});

test("the reader turns FastData entries into profiles, posts and follows", async () => {
  const entry = (account, key, value) => ({ predecessor_id: account, current_account_id: "social", block_height: 1, block_timestamp: "1794400000000000000", key, value });
  const calls = [];
  const fake = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    calls.push([new URL(url).pathname, body]);
    let entries = [];
    if (url.endsWith("/v0/multi")) {
      entries = body.keys
        .map((k) => {
          if (k === "social/bea.testnet/profile/name") return entry("bea.testnet", "profile/name", "Bea Okafor");
          if (k === "social/bea.testnet/post/5") return entry("bea.testnet", "post/5", { text: "hello", quote: "noor.testnet/4" });
          if (k === "social/gone.testnet/post/6") return entry("gone.testnet", "post/6", null); // a deleted post
          return null;
        })
        .filter(Boolean);
    } else if (url.endsWith("/v0/latest/social/bea.testnet")) {
      entries = [entry("bea.testnet", "graph/follow/kofi.testnet", {}), entry("bea.testnet", "graph/follow/old.testnet", null)];
    } else if (url.endsWith("/v0/latest/social")) {
      entries = [entry("kofi.testnet", body.key, {})];
    }
    return { ok: true, json: async () => ({ entries }) };
  };
  const social = makeSocial("testnet", fake);

  const profiles = await social.profiles(["bea.testnet", "nobody.testnet", "not an account"]);
  assert.equal(profiles.get("bea.testnet").name, "Bea Okafor");
  assert.equal(profiles.get("nobody.testnet").name, null);
  assert.ok(!profiles.has("not an account"));

  const posts = await social.posts(["bea.testnet/5", "gone.testnet/6", "junk"]);
  assert.equal(posts.size, 1, "a deleted post and a bad reference are left out");
  assert.deepEqual(
    { text: posts.get("bea.testnet/5").text, quote: posts.get("bea.testnet/5").quote, at: posts.get("bea.testnet/5").at },
    { text: "hello", quote: "noor.testnet/4", at: 1794400000000 },
  );

  assert.deepEqual(await social.following("bea.testnet"), ["kofi.testnet"], "an unfollow is a null, not an edge");
  assert.deepEqual(await social.followers("bea.testnet"), ["kofi.testnet"]);
  assert.ok(calls.every(([path]) => path.startsWith("/v0/")));
});
