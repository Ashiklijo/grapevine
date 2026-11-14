# Submission kit

Deadline: 14 November 2026, 23:59 UTC. Only a person can post and submit, so everything here is a draft for you to use. Re-read <https://nearhackathon.com/HACKATHON.md> before you submit: its rules can change.

## What only you can do

- [x] **Make the repository public** before the deadline, and check that no key is in its history. Done: https://github.com/Ashiklijo/grapevine is public, and nothing in it contains a key: the scripts read keys from `~/.near-credentials`.
- [ ] **Post on X** with the video attached. The draft is below.
- [ ] **Give your mainnet NEAR account** for the payout.
- [ ] **Submit** through <https://nearhackathon.com/#apply>, once, after the repository is public and the post is up. A submission cannot be edited.
- [x] **Host the site.** Done: GitHub Pages serves the repository, and https://ashiklijo.github.io/grapevine/ opens the read-only board. Keep it up through judging (2026-11-18). Optional: record its address on the board with one DAO proposal, so the contract's posts link to it (`update_board` with `site` set).

## Demo video

`demo/grapevine-demo.mp4`: 1 minute 37 seconds, 1920x1080, H.264 and AAC, 6.6 MB, captions burned in because X plays videos muted. A standard X account can attach up to 2 minutes 20 seconds. Checked frame by frame (no black frames or one-frame flashes) and by a speech recogniser against the script.

Everything on screen is the real site in demo mode against the live testnet contracts. Every click is a transaction. The cut squeezes the seconds spent waiting for blocks, and a note in the corner says so. The closing card says the tokens are test tokens, the people are invented, and the narration is an AI voice (Chatterbox, an open-source model, with its built-in voice). To use a person's voice, have them read the right-hand column and re-cut with `python demo/edit.py`.

| Section | On screen | Said |
|---|---|---|
| The problem | A calendar page: Saturday, 10:00, the vote on the new shop. Asha's card. "Nobody has booked an interpreter." | "Asha is deaf. On Saturday, her community votes on its future. Without an interpreter, she can't take part." |
| | The council on the left, an interpreter on the right, two unknown people between them | "Nobody on the council knows an interpreter. But somebody knows somebody who does." |
| The promise | The board | "This is Grapevine. The community's treasury pays whoever gets it done. And everyone who passed the word along." |
| One complete moment | Noor opens the quest | "Noor, on the council, posts the quest. The reward is 2 NEAR tokens, from the community's own Sputnik DAO." |
| | Bea's page suggests Kofi from the people she follows. She passes it on. | "Bea sees it. She doesn't know an interpreter. But her friend Kofi coaches a Deaf football team. So she passes it on." |
| | Kofi's page already knows Bea told him. He passes it on. | "Kofi knows exactly who to ask." |
| | Rosa claims it | "Rosa is an interpreter. She has never heard of this community. She says yes." |
| | Saturday | "Saturday comes. Rosa interprets the whole meeting. And Asha votes." |
| | Noor sees the split and accepts | "Noor accepts, and the reward splits itself. Half to Rosa. A quarter to Kofi. An eighth to Bea." |
| | Bea's payment turns Paid. Tomas countersigns the other two. | "Bea has been paid here before, so hers arrives at once. Rosa and Kofi are new, so a second council member signs off." |
| Anyone can check | A payment's proposal, read from the DAO | "Every payment is an ordinary transfer from the DAO's own treasury. Grapevine never holds the money." |
| | Records | "And each of them now has a record, tied to their NEAR account. Next time, they are trusted a little more." |
| Trying to cheat | Two refused transactions | "Can you cheat? Name yourself as the person who told you. Refused. Open a quest that pays you. Refused." |
| What NEAR does | The posts under the quest, one written by the contract | "Every pass is a signed post on near.social. Even the contract posts for itself. No bots. No server." |
| The close | The vine with three payments on it, then the closing card | "Three people who had never met just got paid for making sure Asha was heard. Grapevine. Someone you know knows someone." |

The video does not say it was built at NEAR HACKATHON. The rules need that sentence in the post, so keep it there.

How it was made is in [`demo/`](../demo): `record.mjs` drives the real site and records frames with their timestamps, `edit.py` cuts them to the narration using `sections.py`. The narration comes from `voice.py`, one line of `lines.json` at a time. `check_voice.py` transcribes every clip with a speech recogniser and flags a clip that misses words or stops early. Two lines were heard wrong in the first pass ("two NEAR" as "tune in", and "Grapevine" as "great fine"), so they were re-recorded with `python demo/retake.py demo/lines.json demo/out/takes 05,17 0,1,2,3`, and take `s3` of each, heard right, replaced the first one.

## X post

One post, nothing in reply. Attach `demo/grapevine-demo.mp4` to it. It is 277 of a standard account's 280 characters (X counts any link as 23), says it was built at NEAR HACKATHON, and tags @NEARProtocol and #NEARHackathon, as the rules ask.

> Nobody on the council knows a sign-language interpreter. Somebody knows somebody who does.
>
> Grapevine: the DAO posts a quest. Its Sputnik treasury on NEAR pays the doer and everyone who passed it on.
>
> Built at NEAR HACKATHON @NEARProtocol #NEARHackathon
> https://github.com/Ashiklijo/grapevine

## Submission fields

Keep these out of the repository once filled in, because they contain personal data.

| Field | Value |
|---|---|
| projectName | Grapevine |
| leadName | You decide |
| email | You decide. At most 2 submissions per email. |
| size | You decide |
| tracks | `social`. It also fits `open`. The rules say to list every track a project fits. |
| nearAddress | Your mainnet payout account |
| projectUrl | The public repository |
| demoUrl | Your X post |
| consent | Only after you agree to the contact notice |

**idea**, the answer to "What did you build?": the problem, what was built, and how NEAR fits in (925 characters, limit 2,000):

> Communities on NEAR keep their money in Sputnik DAOs, but a DAO's bounty only reaches people who already follow that DAO: of 215 bounties ever posted with Sputnik's built-in bounties on mainnet, 155 still have slots nobody was paid for. Grapevine is a word-of-mouth quest board for a DAO. A council member posts a quest with a reward, anyone can pass it on and record on chain who told them, and when the job is done the reward splits between the person who did it and everyone who carried the word to them. NEAR holds the trust and the money: each share is an ordinary Transfer proposal on the DAO's own Sputnik treasury, filed by our contract through a role that can only make transfers, and a named account's record of paid quests decides whether it is paid at once, needs a second council member, or goes to the DAO's normal vote. Quests, passes and payments are posts on near.social, and everything runs on NEAR testnet.

## Checklist

- [x] Contract rules tested (`cargo test -p grapevine-logic`, 42 tests)
- [x] Contract itself tested on near-sdk's mocked runtime (`cargo test -p grapevine`, 29 tests)
- [x] Independent review of the contract, two passes, findings fixed (README, "Security review")
- [x] Live deployment on testnet ([results](TESTNET.md))
- [x] End-to-end checks on testnet, 102 of 102 (`deployments/testnet-e2e.json`)
- [x] Demo video made (`demo/grapevine-demo.mp4`)
- [x] A hosted copy of the site, and its link in the README (https://ashiklijo.github.io/grapevine/)
- [x] Repository public, with no keys in its history (https://github.com/Ashiklijo/grapevine)
- [ ] Demo post live on X
- [ ] Your mainnet payout account
- [ ] Open the demo DAO in Trezu's local testnet mode and check a payment shows as a payment request (not done: the proposals use the description format Trezu's parser reads)
