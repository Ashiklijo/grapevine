// The people in the demo community. Invented, and labelled as such wherever they appear.
// Their near.social profiles and follows are written to testnet by scripts/seed.mjs.

export const PEOPLE = {
  noor: {
    name: "Noor Rahman",
    role: "Council",
    about: "On the council at Riverside Food Co-op. Tuesdays on the till. (demo persona)",
    follows: ["tomas", "bea"],
  },
  tomas: {
    name: "Tomas Lind",
    role: "Council",
    about: "Treasurer at Riverside Food Co-op. I count the float so you do not have to. (demo persona)",
    follows: ["noor"],
  },
  bea: {
    name: "Bea Okafor",
    role: "Member",
    about: "Saturday shift lead at Riverside Food Co-op. Knows where the good crates are. (demo persona)",
    follows: ["noor", "kofi", "dev"],
  },
  kofi: {
    name: "Kofi Mensah",
    role: "Bea's friend",
    about: "Coach at the Deaf football league. I know every interpreter in this town. (demo persona)",
    follows: ["bea", "rosa"],
  },
  rosa: {
    name: "Rosa Delgado",
    role: "Interpreter",
    about: "Sign-language interpreter. Community meetings, clinics, weddings. (demo persona)",
    follows: ["kofi"],
  },
  dev: {
    name: "Dev Patel",
    role: "Driver",
    about: "Man with a van. Market runs and house moves. (demo persona)",
    follows: ["bea"],
  },
  mallory: {
    name: "Mallory",
    role: "Tries to cheat",
    about: "Here to test the rules. (demo persona)",
    follows: [],
  },
  sock: {
    name: "Mallory's second account",
    role: "Fake link",
    about: "Created five minutes ago. (demo persona)",
    follows: [],
  },
};

export const CONTRACT_PROFILE = {
  name: "Grapevine",
  about:
    "Automated account. A contract that posts quests, splits and payments for Sputnik DAOs that use Grapevine. Every post here was written by the contract itself, not by a person or a bot.",
};
