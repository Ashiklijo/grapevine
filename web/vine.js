// Draws a quest's vine: who heard it from whom, who got it done, and what each of them was paid.
import { esc, near } from "./chain.js";

const COLORS = ["#5b3d8a", "#2f6b3a", "#a8551f", "#1f6f8b", "#8a3d5b", "#4d6b1f", "#3d4f8a", "#8a6a1f"];
export function colorOf(account) {
  let h = 0;
  for (const ch of account) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}
export const initials = (name) =>
  name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");

const COL = 150;
const ROW = 150;
const R = 25;
/** Room under a node for its name and tag, before a branch leaves it. */
const LABEL = 44;

/**
 * @param sponsor  the account at the root
 * @param links    [{account, via}] in the order people joined
 * @param nameOf   account -> display name
 * @param marks    {doer, claimed: Set, paid: Map(account -> {amount, phase, route}), leftOut: Set, me}
 */
export function drawVine({ sponsor, links, nameOf, marks }) {
  const children = new Map([[sponsor, []]]);
  for (const l of links) children.set(l.account, []);
  for (const l of links) (children.get(l.via ?? sponsor) ?? children.get(sponsor)).push(l.account);

  // A tidy tree: leaves take one column each, parents sit over the middle of their children.
  const pos = new Map();
  let nextLeaf = 0;
  let depthMax = 0;
  (function place(account, depth) {
    depthMax = Math.max(depthMax, depth);
    const kids = children.get(account);
    if (!kids.length) {
      pos.set(account, { x: nextLeaf++, depth });
      return;
    }
    for (const kid of kids) place(kid, depth + 1);
    const first = pos.get(kids[0]).x;
    const last = pos.get(kids[kids.length - 1]).x;
    pos.set(account, { x: (first + last) / 2, depth });
  })(sponsor, 0);

  const width = Math.max(nextLeaf, 1) * COL + 40;
  const height = depthMax * ROW + 44 + R + LABEL + 8;
  const px = (account) => 20 + COL / 2 + pos.get(account).x * COL;
  const py = (account) => 44 + pos.get(account).depth * ROW;

  // The accounts on the path from the doer up to the sponsor.
  const onPath = new Set();
  if (marks.doer) {
    const parent = new Map(links.map((l) => [l.account, l.via ?? sponsor]));
    for (let a = marks.doer; a && a !== sponsor; a = parent.get(a)) onPath.add(a);
  }

  const edges = links
    .map((l) => {
      const from = l.via ?? sponsor;
      if (!pos.has(from)) return "";
      const x1 = px(from);
      const y1 = py(from) + R + LABEL;
      const x2 = px(l.account);
      const y2 = py(l.account) - R - 3;
      const mid = (y1 + y2) / 2;
      const live = onPath.has(l.account);
      return `<path class="edge${live ? " edge-live" : ""}" d="M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}"/>`;
    })
    .join("");

  const node = (account) => {
    const name = nameOf(account);
    const x = px(account);
    const y = py(account);
    const isSponsor = account === sponsor;
    const isDoer = account === marks.doer;
    const paid = marks.paid.get(account);
    const classes = ["node", isSponsor && "node-sponsor", isDoer && "node-doer", marks.leftOut.has(account) && "node-out", account === marks.me && "node-me"]
      .filter(Boolean)
      .join(" ");
    const tag = isSponsor ? "posted it" : isDoer ? "got it done" : marks.claimed.has(account) ? "says: I can do this" : marks.leftOut.has(account) ? "left out" : "passed it on";
    const money = paid
      ? `<g class="money money-${paid.phase.toLowerCase()}" transform="translate(${x + R + 8},${y})">
           <rect x="0" y="-13" rx="11" ry="11" width="${near(paid.amount).length * 8 + 44}" height="22"/>
           <text x="9" y="3">${paid.phase === "Paid" ? "+" : ""}${near(paid.amount)} NEAR</text>
         </g>`
      : "";
    return `<g class="${classes}" data-account="${esc(account)}">
        <circle cx="${x}" cy="${y}" r="${R}" fill="${isSponsor ? "#1d1b16" : colorOf(account)}"/>
        ${isDoer ? `<circle class="ring" cx="${x}" cy="${y}" r="${R + 6}"/>` : ""}
        <text class="initials" x="${x}" y="${y + 6}">${esc(initials(name))}</text>
        <text class="name" x="${x}" y="${y + R + 18}">${esc(name)}</text>
        <text class="tag" x="${x}" y="${y + R + 34}">${tag}</text>
        ${money}
      </g>`;
  };

  return `<svg class="vine" viewBox="0 0 ${width} ${height}" style="max-width:${Math.max(width, 420)}px" role="img"
      aria-label="Who passed this quest to whom">
      ${edges}
      ${[...pos.keys()].map(node).join("")}
    </svg>`;
}
