// Gives the demo community a past: near.social profiles and follows for its people, and one
// finished quest so the board has a record on it. Safe to re-run.
//
//   node scripts/seed.mjs
import { deployment, keepFloats, loadAccount, log, toNear, view } from "./lib.mjs";
import * as act from "./actions.mjs";
import { CONTRACT_PROFILE, PEOPLE } from "./people.mjs";
import { followArgs, profileArgs, social, waitForKeys, writeSocial } from "./social.mjs";

const d = deployment();
const person = (name) => `${name}.${d.hq}`;
const [noor, tomas] = d.people.council;
await keepFloats(d);

// 1. Profiles and follows, written the way near.social's own app writes them.
for (const [key, info] of Object.entries(PEOPLE)) {
  const id = person(key);
  const have = (await social.profiles([id])).get(id);
  if (have?.name === info.name) continue;
  const args = { ...profileArgs({ name: info.name, about: info.about }), ...followArgs(info.follows.map(person)) };
  const hash = await writeSocial(loadAccount(id), args);
  log(`profile for ${id}: ${hash}`);
}
{
  // The contract's own profile says it is automated, as near.social asks of automated accounts.
  const have = (await social.profiles([d.contract])).get(d.contract);
  if (have?.name !== CONTRACT_PROFILE.name) {
    const hash = await writeSocial(loadAccount(d.contract), profileArgs({ ...CONTRACT_PROFILE, website: d.site || undefined }));
    log(`profile for ${d.contract}: ${hash}`);
  }
}
const landed = await waitForKeys(person("rosa"), ["profile/name"], 60_000);
log(landed ? "profiles are served by FastData" : "profiles were sent but FastData is not serving them yet");

// 2. One finished quest, so Bea has a record when the demo starts.
const bea = await view(d.contract, "get_record", { dao: d.dao, account: person("bea") });
if (bea.points === 0) {
  const title = "Find a van for Saturday's market run";
  // A run stopped right after opening the quest left it open with nobody on it: carry on with it.
  const open = (await view(d.contract, "list_quests", { dao: d.dao, from_index: 0, limit: 100 })).find(
    (q) => q.title === title && q.status === "Open" && q.links === 0
  );
  const quest = open
    ? { id: open.id }
    : await act.openQuest(d, noor, {
        title,
        brief: "Ours is in the garage until Tuesday. We need a van and a driver from 6 to 10 on Saturday morning to carry the stall to the market and back.",
        // Bea's share of this one is 0.25 NEAR, countersigned. That is what later lets a share of
        // that size reach her at once: nobody is paid at once more than a second steward has approved.
        reward: "1",
        withPost: true,
      });
  log(`${open ? "carrying on with" : "opened"} quest ${quest.id}`);
  await act.passOn(d, person("bea"), quest.id, null, { withPost: true, note: "Our van is off the road. Does anyone know someone with a van who is free on Saturday morning?" });
  await act.claim(d, person("dev"), quest.id, person("bea"), "I can do 6 to 10. Bea told me about it.", { withPost: true });
  const accepted = await act.accept(d, noor, quest.id, person("dev"));
  if (!accepted.ok) throw new Error(`accept failed: ${accepted.failures.join("; ")}`);
  for (const id of accepted.value) {
    const res = await act.countersign(d, tomas, id);
    if (!res.ok) throw new Error(`countersign failed: ${res.failures.join("; ")}`);
  }
  const settled = await act.settle(d, d.people.keeper, quest.id, { onStep: (s) => log(`  ${s}`) });
  for (const p of settled.payouts) log(`  ${p.payee} ${toNear(p.amount)} NEAR: ${p.phase}`);
} else {
  log(`Bea already has a record of ${bea.points}`);
}
