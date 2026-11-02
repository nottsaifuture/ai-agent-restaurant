// Room layout: every standing spot is unique, inside the picture, and overflow
// cannot walk off the frame or onto the bell and the door.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import vm from "node:vm";

const code = readFileSync(new URL("../public/room.js", import.meta.url), "utf8");
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const Room = sandbox.window.Room;

const { width: VW, height: VH } = Room.viewBox;

function staffMember(id, name = "Ada") {
  return { id, name: name + id, role: id === 1 ? "chief" : "helper", last_seen: Date.now(), quota: 80 };
}

function state(staff, extra = {}) {
  return {
    staff,
    tasks: extra.tasks ?? [],
    approvals: extra.approvals ?? [],
    events: extra.events ?? [],
    recipes: extra.recipes ?? [],
  };
}

function mount() {
  return { innerHTML: "", querySelector() { return { classList: { add() {} } }; } };
}

function feet(svg) {
  const out = [];
  const re = /class="r-staff[^"]*" data-staff="([^"]+)" transform="translate\(([-\d.]+) ([-\d.]+)\)"/g;
  let m;
  while ((m = re.exec(svg))) out.push({ id: m[1], x: Number(m[2]), y: Number(m[3]) });
  return out;
}

function assertInside(p) {
  assert.ok(p.x >= 0 && p.x <= VW, `x ${p.x} outside 0..${VW}`);
  assert.ok(p.y >= 0 && p.y <= VH, `y ${p.y} outside 0..${VH}`);
}

function assertSeparated(pts, sep) {
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
      assert.ok(d >= sep - 0.01, `${pts[i].id}@${pts[i].x},${pts[i].y} and ${pts[j].id}@${pts[j].x},${pts[j].y} are ${d.toFixed(1)}px apart`);
    }
  }
}

function assertClearOfObstacles(pts) {
  for (const p of pts) {
    for (const o of Room.obstacles) {
      const d = Math.hypot(p.x - o.x, p.y - o.y);
      assert.ok(d >= o.r, `${p.id} is ${d.toFixed(1)}px from ${o.name}`);
      const sx0 = p.x - 18, sy0 = p.y - 78, sx1 = p.x + 34, sy1 = p.y + 8;
      const [bx0, by0, bx1, by1] = o.sprite;
      const hit = sx0 < bx1 && sx1 > bx0 && sy0 < by1 && sy1 > by0;
      assert.equal(hit, false, `${p.id} covers the ${o.name}`);
    }
  }
}

test("base spots are unique, separated, and inside the viewBox", () => {
  const spots = Room.floorSpots;
  assert.ok(spots.length >= 8);
  const zones = new Set(spots.map((s) => s.zone));
  for (const z of ["stove", "pass", "host", "lounge"]) assert.ok(zones.has(z), z);
  for (const s of spots) assertInside(s);
  assertSeparated(spots.map((s, i) => ({ id: s.zone + i, ...s })), Room.minSep);
  assertClearOfObstacles(spots.map((s, i) => ({ id: "spot" + i, ...s })));
  const keys = spots.map((s) => `${s.x},${s.y}`);
  assert.equal(new Set(keys).size, keys.length, "duplicate coordinates");
});

test("a full dining room, including overflow, stays in bounds and apart", () => {
  const staff = Array.from({ length: 24 }, (_, i) => staffMember(i + 1));
  const el = mount();
  const placed = Room.render(state(staff), el, null);
  assert.equal(placed.length, staff.length);
  for (const row of placed) assert.deepEqual(Object.keys(row).sort(), ["extra", "id", "mood"]);
  const pts = feet(el.innerHTML);
  assert.equal(pts.length, staff.length);
  for (const p of pts) assertInside(p);
  assertSeparated(pts, Room.minSep);
  assertClearOfObstacles(pts);
});

test("mixed jobs never share a spot, and names paint after the figures", () => {
  const now = Date.now();
  const staff = Array.from({ length: 12 }, (_, i) => ({ ...staffMember(i + 1), last_seen: i % 2 ? now : 0 }));
  const tasks = [
    { id: 1, title: "Soup", status: "doing", assignee_id: 1 },
    { id: 2, title: "Tea", status: "doing", assignee_id: 2 },
    { id: 3, title: "Bun", status: "doing", assignee_id: 3 },
    { id: 4, title: "Rice", status: "doing", assignee_id: 4 },
    { id: 5, title: "Toast", status: "todo", assignee_id: 5 },
    { id: 6, title: "Milk", status: "review", assignee_id: 6 },
    { id: 7, title: "Eggs", status: "todo", assignee_id: null },
  ];
  const approvals = [
    { id: 1, staff_id: 7, status: "pending" },
    { id: 2, staff_id: 8, status: "pending" },
    { id: 3, staff_id: 9, status: "pending" },
  ];
  const el = mount();
  const placed = Room.render(state(staff, { tasks, approvals, recipes: Array.from({ length: 12 }, (_, i) => ({ id: i })) }), el, 1);
  const pts = feet(el.innerHTML);
  assert.equal(pts.length, staff.length);
  for (const p of pts) assertInside(p);
  assertSeparated(pts, Room.minSep);
  assertClearOfObstacles(pts);
  const moods = Object.fromEntries(placed.map((p) => [p.id, p.mood]));
  assert.equal(moods[7], "ask");
  assert.equal(moods[8], "ask");
  assert.ok(placed.some((p) => p.mood === "cook"));
  assert.ok(placed.some((p) => p.mood === "ready" || p.mood === "read"));

  const svg = el.innerHTML;
  const staffAt = [...svg.matchAll(/class="r-staff/g)].map((m) => m.index);
  const namesAt = svg.indexOf('class="r-names"');
  assert.ok(namesAt > Math.max(...staffAt), "names layer is after every figure");
  assert.match(svg, /paint-order="stroke"/);

  // Painter's order: figure y is non-decreasing, id breaks ties.
  let prev = null;
  for (const p of pts) {
    if (prev) {
      assert.ok(p.y > prev.y || (p.y === prev.y && String(p.id) >= String(prev.id)), `${p.id} painted before ${prev.id}`);
    }
    prev = p;
  }
});

test("count badges handle 0, 9 and 10+", () => {
  const el = mount();
  const recipes = (n) => Array.from({ length: n }, (_, i) => ({ id: i }));
  const unclaimed = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, title: "x", status: "todo", assignee_id: null }));
  Room.render(state([staffMember(1)], { recipes: recipes(0), tasks: unclaimed(0) }), el, null);
  assert.match(el.innerHTML, /Bookshelf, 0 recipes/);
  assert.match(el.innerHTML, /Counter, 0 unclaimed/);
  assert.match(el.innerHTML, /class="r-count zero"/);

  Room.render(state([staffMember(1)], { recipes: recipes(9), tasks: unclaimed(9) }), el, null);
  assert.match(el.innerHTML, />9</);
  assert.doesNotMatch(el.innerHTML, /class="r-count[^"]* wide[^"]*"/);

  Room.render(state([staffMember(1)], { recipes: recipes(10), tasks: unclaimed(12) }), el, null);
  assert.match(el.innerHTML, /Bookshelf, 10 recipes/);
  assert.match(el.innerHTML, /Counter, 12 unclaimed/);
  assert.match(el.innerHTML, /class="r-count wide"/);
  assert.match(el.innerHTML, />10</);
  assert.match(el.innerHTML, />12</);
  // A pill (rect), not a circle, holds two digits.
  assert.match(el.innerHTML, /class="r-count wide"[^>]*>\s*<rect/);

  Room.render(state([staffMember(1)], { recipes: recipes(120) }), el, null);
  assert.match(el.innerHTML, /Bookshelf, 120 recipes/);
  assert.match(el.innerHTML, />99\+</);
});

test("the picture declares its box, and the shipped file is the small one", () => {
  const el = mount();
  Room.render(state([]), el, null);
  assert.match(el.innerHTML, /class="room-fallback"/);
  assert.match(el.innerHTML, /class="room-bg"[^>]*width="660"[^>]*height="371\.67"[^>]*preserveAspectRatio="xMidYMid slice"/);
  assert.match(el.innerHTML, /\/cha-chaan-teng-1320\.jpg/);
  assert.doesNotMatch(el.innerHTML, /\/cha-chaan-teng\.jpg"/);

  const jpg = statSync(new URL("../public/cha-chaan-teng-1320.jpg", import.meta.url));
  const webp = statSync(new URL("../public/cha-chaan-teng-1320.webp", import.meta.url));
  assert.ok(jpg.size < 300 * 1024, `jpeg is ${jpg.size}`);
  assert.ok(webp.size < 300 * 1024, `webp is ${webp.size}`);
  assert.equal(statSync(new URL("../public/cha-chaan-teng.jpg", import.meta.url), { throwIfNoEntry: false }), undefined);
});

test("tap targets are buttons with names, and the photo ignores the pointer", () => {
  const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");
  assert.match(css, /\.room-bg\s*\{\s*pointer-events:\s*none/);
  assert.match(css, /paint-order:\s*stroke/);
  assert.match(css, /\.r-hit:focus-visible/);
  const el = mount();
  Room.render(state([staffMember(1)], { recipes: [{ id: 1 }], events: [{ read_at: null }] }), el, null);
  for (const go of ["recipes", "orders", "approvals", "inbox"]) {
    assert.match(el.innerHTML, new RegExp(`data-go="${go}"[^>]*role="button"[^>]*tabindex="0"[^>]*aria-label="`));
  }
  // 88 viewBox units is about 48px when the picture is shown at a 360px phone width (88 * 360/660).
  assert.match(el.innerHTML, /class="r-hit" x="146" y="90" width="92" height="102"/);
  assert.match(el.innerHTML, /class="r-hit" x="230" y="78" width="220" height="132"/);
  assert.match(el.innerHTML, /class="r-target" x="-44" y="-44" width="88" height="88"/);
});
