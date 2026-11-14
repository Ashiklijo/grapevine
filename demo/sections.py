"""The cut list. Each section's narration sets its length; clips are squeezed or held to fit.

`from` and `to` are moments in a recorded shot: an event name, optionally plus or minus seconds.
No `to` means real time. A clip with `seconds` takes exactly that long, and the other clips in the
section share what is left, by `weight`.
"""

LIVE = "Live on NEAR testnet. Test tokens. Waits for blocks are shortened."

SECTIONS = [
    # The first frame becomes the thumbnail on X, so start once the card has finished fading in.
    {"name": "asha", "lines": ["01"], "lead": 0.3, "tail": 0.5, "video": [{"shot": "story", "from": "asha+0.95", "to": "chain-0.1"}]},
    {"name": "chain", "lines": ["02"], "tail": 0.7, "video": [{"shot": "story", "from": "chain", "to": "end"}]},
    {"name": "title", "lines": ["03", "04"], "tail": 0.4, "note": LIVE, "video": [{"shot": "board", "from": "hero", "to": "form"}]},
    {
        "name": "open",
        "lines": ["05"],
        "tail": 0.6,
        "note": LIVE,
        "video": [
            {"shot": "board", "from": "form", "to": "sent", "weight": 3},
            {"shot": "board", "from": "sent", "to": "opened", "seconds": 0.8},
            {"shot": "board", "from": "opened", "to": "opened+2.6", "weight": 2},
        ],
    },
    {
        "name": "first",
        "lines": ["06"],
        "tail": 0.5,
        "note": LIVE,
        "video": [
            {"shot": "first", "from": "panel", "to": "clicked", "weight": 4},
            {"shot": "first", "from": "clicked", "to": "onvine", "seconds": 0.9},
            {"shot": "first", "from": "onvine", "to": "onvine+2.6", "weight": 1.5},
        ],
    },
    {
        "name": "middle",
        "lines": ["07"],
        "tail": 0.5,
        "note": LIVE,
        "video": [
            {"shot": "middle", "from": "panel", "to": "clicked", "weight": 2},
            {"shot": "middle", "from": "clicked", "to": "onvine", "seconds": 0.8},
            {"shot": "middle", "from": "onvine", "to": "onvine+2.4", "weight": 1},
        ],
    },
    {
        "name": "doer",
        "lines": ["08"],
        "tail": 0.6,
        "note": LIVE,
        "video": [
            {"shot": "doer", "from": "panel", "to": "clicked", "weight": 3},
            {"shot": "doer", "from": "clicked", "to": "claimed", "seconds": 0.8},
            {"shot": "doer", "from": "claimed", "to": "claimed+3", "weight": 1.5},
        ],
    },
    {"name": "saturday", "lines": ["09"], "lead": 0.2, "tail": 0.9, "video": [{"shot": "saturday", "from": "title", "to": "end"}]},
    {
        "name": "accept",
        "lines": ["10"],
        "tail": 0.5,
        "note": LIVE,
        "video": [
            {"shot": "accept", "from": "claims", "to": "split", "seconds": 1.6},
            {"shot": "accept", "from": "split", "to": "clicked", "weight": 4},
            {"shot": "accept", "from": "clicked", "to": "accepted", "seconds": 0.8},
            {"shot": "accept", "from": "accepted", "to": "accepted+1.5", "weight": 1},
        ],
    },
    {
        "name": "pays",
        "lines": ["11"],
        "tail": 0.6,
        "note": LIVE,
        "video": [
            {"shot": "accept", "from": "firstPaid-2", "to": "firstPaid+3", "weight": 2},
            {"shot": "second", "from": "ready", "to": "sign2+1", "weight": 2},
            {"shot": "second", "from": "allPaid-3", "to": "allPaid+1.4", "weight": 1.2},
        ],
    },
    {
        "name": "transfer",
        "lines": ["12"],
        "tail": 0.5,
        "note": LIVE,
        "video": [{"shot": "proposal", "from": "ready", "to": "shown+4.5"}],
    },
    {"name": "records", "lines": ["13"], "tail": 0.5, "note": LIVE, "video": [{"shot": "records", "from": "table", "to": "detail+3.5"}]},
    {
        "name": "cheat",
        "lines": ["14"],
        "tail": 0.6,
        "note": LIVE,
        "video": [
            {"shot": "cheat", "from": "page", "to": "try1", "weight": 1.2},
            {"shot": "cheat", "from": "try1", "to": "refused1+1.3", "weight": 2},
            {"shot": "cheat", "from": "try2-0.8", "to": "refused2+1.8", "weight": 2},
        ],
    },
    {"name": "social", "lines": ["15"], "tail": 0.5, "note": LIVE, "video": [{"shot": "social", "from": "posts", "to": "end"}]},
    {"name": "paid", "lines": ["16"], "lead": 0.2, "tail": 0.7, "note": LIVE, "video": [{"shot": "second", "from": "vine", "to": "end"}]},
    {"name": "close", "lines": ["17"], "lead": 0.3, "tail": 2.6, "video": [{"shot": "close", "from": "mark", "to": "end"}]},
]
