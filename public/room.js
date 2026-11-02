"use strict";

// The visible restaurant: an isometric room drawn as SVG from the live state.
// Where each staff member stands shows what they are doing:
//   cooking at a stove = working on an order · at the pass = order ready for review
//   at the host stand with "!" = waiting for your approval · lounge = idle · "z" = hasn't checked in lately
window.Room = (() => {
  const TW = 64, TH = 32, ZH = 26; // tile width/height and one unit of height, in px
  const W = 11, D = 9, WALL = 3.2; // room size in tiles

  const P = (x, y, z = 0) => [((x - y) * TW) / 2, ((x + y) * TH) / 2 - z * ZH];
  const pts = (...corners) => corners.map((c) => P(...c).map((n) => n.toFixed(1)).join(",")).join(" ");
  const poly = (cls, ...corners) => `<polygon class="${cls}" points="${pts(...corners)}"/>`;
  const escX = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  /** A box with its visible top and two front faces. */
  function box(x, y, w, d, h, kind, z = 0) {
    const t = z + h;
    return (
      poly(`${kind} side-l`, [x, y + d, z], [x + w, y + d, z], [x + w, y + d, t], [x, y + d, t]) +
      poly(`${kind} side-r`, [x + w, y, z], [x + w, y + d, z], [x + w, y + d, t], [x + w, y, t]) +
      poly(`${kind} top`, [x, y, t], [x + w, y, t], [x + w, y + d, t], [x, y + d, t])
    );
  }

  // Everything placed on the floor has a footprint, used to draw back to front.
  const items = []; // { x0, y0, x1, y1, svg }
  const labels = [];
  const add = (x0, y0, x1, y1, svg) => items.push({ x0, y0, x1, y1, svg });
  const behind = (a, b) => (a.x1 <= b.x0 || a.y1 <= b.y0) && !(b.x1 <= a.x0 || b.y1 <= a.y0);
  const centre = (a) => a.x0 + a.x1 + a.y0 + a.y1;

  /** Back-to-front order: anything that must be behind another is drawn first (a topological sort). */
  function backToFront(list) {
    const left = [...list];
    const out = [];
    while (left.length) {
      // Pick the item nothing else must be drawn before; ties go to the one furthest back.
      const free = left.filter((a) => !left.some((b) => b !== a && behind(b, a)));
      const pool = free.length ? free : left; // a loop shouldn't happen, but never hang
      const next = pool.reduce((m, a) => (centre(a) < centre(m) ? a : m));
      out.push(next);
      left.splice(left.indexOf(next), 1);
    }
    return out;
  }

  function room() {
    let s = poly("r-wall-back", [0, 0, 0], [W, 0, 0], [W, 0, WALL], [0, 0, WALL]);
    s += poly("r-wall-side", [0, 0, 0], [0, D, 0], [0, D, WALL], [0, 0, WALL]);
    s += poly("r-floor", [0, 0, 0], [W, 0, 0], [W, D, 0], [0, D, 0]);
    // Kitchen tiles (checkerboard) behind the pass, wood floor in front
    for (let x = 0; x < W; x++) for (let y = 0; y < 3.5; y++) if ((x + y) % 2 === 0) s += poly("r-tile", [x, y, 0], [x + 1, y, 0], [x + 1, Math.min(y + 1, 3.5), 0], [x, Math.min(y + 1, 3.5), 0]);
    for (let y = 4; y < D; y += 1) s += `<line class="r-plank" x1="${P(0, y)[0]}" y1="${P(0, y)[1]}" x2="${P(W, y)[0]}" y2="${P(W, y)[1]}"/>`;
    // Sign on the back wall
    const [sx, sy] = P(5.5, 0, 2.55);
    s += `<g class="r-sign" transform="translate(${sx} ${sy}) skewY(26.565)"><rect x="-58" y="-13" width="116" height="26" rx="6"/><text y="5" text-anchor="middle">KITCHEN</text></g>`;
    // Door on the side wall
    s += poly("r-door", [0, 7.2, 0], [0, 8.4, 0], [0, 8.4, 2.2], [0, 7.2, 2.2]);
    return s;
  }

  function character(st, x, y, mood, extra) {
    const [cx, cy] = P(x, y);
    const hue = [...st.name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 0);
    const color = `hsl(${hue} 55% 48%)`;
    const chief = st.role === "chief";
    const hatH = chief ? 20 : 12;
    const q = st.quota;
    const battery = q == null ? "" :
      `<g transform="translate(14 -44)"><rect class="r-batt" width="14" height="7" rx="1.5"/><rect class="r-batt-fill ${q < 20 ? "low" : q < 50 ? "mid" : ""}" x="1" y="1" width="${Math.max(1, (12 * q) / 100).toFixed(1)}" height="5" rx="1"/></g>`;
    const bubble = {
      cook: `<text class="r-bubble-emoji" y="${-58 - hatH}">🍳</text>`,
      ask: `<g class="r-ask" transform="translate(0 ${-62 - hatH})"><circle r="10"/><text y="5" text-anchor="middle">!</text></g>`,
      sleep: `<text class="r-zzz" x="10" y="${-50 - hatH}">z z</text>`,
      ready: `<text class="r-bubble-emoji" y="${-58 - hatH}">🔔</text>`,
      read: `<text class="r-bubble-emoji" y="${-58 - hatH}">📄</text>`,
      idle: "",
    }[mood];
    const svg = `
      <g class="r-staff ${mood}" data-staff="${st.id}" transform="translate(${cx.toFixed(1)} ${cy.toFixed(1)})" tabindex="0" role="button" aria-label="${escX(st.name)}">
        <title>${escX(st.name)}: ${escX(extra)}</title>
        <ellipse class="r-shadow" rx="15" ry="6"/>
        <g class="r-body">
          <rect x="-11" y="-30" width="22" height="26" rx="9" fill="${color}"/>
          <rect class="r-apron" x="-7" y="-22" width="14" height="16" rx="3"/>
          <circle class="r-face" cy="-38" r="10"/>
          <circle class="r-eye" cx="-3.5" cy="-39" r="1.4"/><circle class="r-eye" cx="3.5" cy="-39" r="1.4"/>
          <rect class="r-hat" x="-8" y="${-47 - hatH}" width="16" height="${hatH + 1}" rx="2"/>
          <circle class="r-hat" cx="-6" cy="${-48 - hatH}" r="6"/><circle class="r-hat" cx="0" cy="${-51 - hatH}" r="7"/><circle class="r-hat" cx="6" cy="${-48 - hatH}" r="6"/>
          ${battery}
          ${bubble}
        </g>
      </g>`;
    // Names go on a top layer so furniture never hides them.
    labels.push(`<text class="r-name" data-staff="${st.id}" x="${cx.toFixed(1)}" y="${(cy + 18).toFixed(1)}" text-anchor="middle">${escX(st.name)}${chief ? " ★" : ""}</text>`);
    add(x - 0.2, y - 0.2, x + 0.2, y + 0.2, svg);
  }

  function render(S, el, selectedId) {
    items.length = 0;
    labels.length = 0;
    const now = Date.now();
    const open = (t) => t.status !== "done";
    const tasks = S.tasks.filter(open);
    const pendingApprovals = S.approvals.filter((a) => a.status === "pending");
    const unread = S.events.filter((e) => !e.read_at).length;
    const review = tasks.filter((t) => t.status === "review");
    const unclaimed = tasks.filter((t) => t.status === "todo" && !t.assignee_id);

    // --- Furniture ---
    const stoves = [[1, 0.3], [3.2, 0.3], [5.4, 0.3]];
    const busyStoves = new Set();
    // Decide where each staff member goes first, so stoves know if they're lit.
    const placed = [];
    const lounge = [[8.2, 2.2], [9.4, 2.4], [8.4, 3.2], [9.6, 3.3]];
    const host = [[8.2, 6.2], [8.9, 7.2], [7.6, 7.4]];
    const pass = [[2, 4.4], [3.4, 4.5], [4.8, 4.4], [6.2, 4.5]];
    let stoveI = 0, loungeI = 0, hostI = 0, passI = 0;
    for (const st of S.staff) {
      const mine = tasks.filter((t) => t.assignee_id === st.id);
      const doing = mine.find((t) => t.status === "doing");
      const todo = mine.find((t) => t.status === "todo");
      const ready = mine.find((t) => t.status === "review");
      const asking = pendingApprovals.some((a) => a.staff_id === st.id);
      const recent = st.last_seen && now - st.last_seen < 15 * 60 * 1000;
      let spot, mood, extra;
      if (asking && hostI < host.length) { spot = host[hostI++]; mood = "ask"; extra = "waiting for your approval"; }
      else if (doing && stoveI < stoves.length) { const s = stoves[stoveI]; busyStoves.add(stoveI++); spot = [s[0] + 0.6, s[1] + 1.55]; mood = "cook"; extra = `cooking order #${doing.id}: ${doing.title}`; }
      else if ((doing || todo) && passI < pass.length) { spot = pass[passI++]; mood = doing ? "cook" : "read"; extra = doing ? `working on #${doing.id}` : `has order #${todo.id} to start`; }
      else if (ready && passI < pass.length) { spot = pass[passI++]; mood = "ready"; extra = `order #${ready.id} is ready for you`; }
      else { spot = lounge[loungeI++ % lounge.length]; if (loungeI > lounge.length) spot = [spot[0] + 0.5, spot[1] + 0.9]; mood = recent ? "idle" : "sleep"; extra = recent ? "free for work" : st.last_seen ? "resting (hasn't checked in lately)" : "hasn't checked in yet"; }
      placed.push([st, spot, mood, extra]);
    }

    stoves.forEach(([x, y], i) => {
      let s = box(x, y, 1.6, 1, 1.1, "r-stove");
      const lit = busyStoves.has(i);
      const [bx, by] = P(x + 0.8, y + 0.5, 1.1);
      s += `<ellipse class="r-burner ${lit ? "lit" : ""}" cx="${bx}" cy="${by}" rx="13" ry="6"/>`;
      if (lit) s += `<g class="r-steam" transform="translate(${bx} ${by - 6})"><path d="M-6 0 q-5 -10 0 -18 q5 -8 0 -16"/><path d="M6 -4 q-5 -10 0 -18 q5 -8 0 -16"/></g>`;
      add(x, y, x + 1.6, y + 1, `<g data-go="orders"><title>Stove: ${lit ? "someone is cooking" : "free"}</title>${s}</g>`);
    });

    // Fridge and shelf on the back wall
    add(7.6, 0.2, 8.6, 1.1, `<g><title>Fridge</title>${box(7.6, 0.2, 1, 0.9, 2.4, "r-fridge")}</g>`);

    // Bookshelf (recipe book) against the side wall
    {
      const n = S.recipes.length;
      let s = box(0.1, 4.3, 0.6, 2, 2.4, "r-shelf");
      const colors = ["#c2410c", "#2563eb", "#15803d", "#9333ea", "#ca8a04", "#db2777"];
      for (let i = 0; i < Math.min(n, 12); i++) {
        const row = Math.floor(i / 6), col = i % 6;
        const y0 = 4.45 + col * 0.3, z0 = 0.35 + row * 1.05;
        s += `<polygon fill="${colors[i % colors.length]}" points="${pts([0.7, y0, z0], [0.7, y0 + 0.22, z0], [0.7, y0 + 0.22, z0 + 0.8], [0.7, y0, z0 + 0.8])}"/>`;
      }
      const [lx, ly] = P(0.7, 5.3, 2.75);
      s += `<text class="r-label" x="${lx}" y="${ly}" text-anchor="middle">Recipes ${n}</text>`;
      add(0.1, 4.3, 0.7, 6.3, `<g data-go="recipes" class="r-clickable"><title>Recipe book: ${n} recipes</title>${s}</g>`);
    }

    // Pass counter with plates for orders ready for review
    {
      let s = box(1, 3.2, 6.6, 0.8, 1.2, "r-counter");
      review.slice(0, 6).forEach((t, i) => {
        const [px, py] = P(1.6 + i * 1.05, 3.6, 1.2);
        s += `<g><title>Ready for review: #${t.id} ${escX(t.title)}</title><ellipse class="r-plate" cx="${px}" cy="${py}" rx="14" ry="6"/><ellipse class="r-food" cx="${px}" cy="${py - 3}" rx="7" ry="4"/></g>`;
      });
      if (review.length > 6) { const [px, py] = P(7.3, 3.6, 1.2); s += `<text class="r-label" x="${px}" y="${py}">+${review.length - 6}</text>`; }
      const [lx, ly] = P(4.3, 4, 0.5);
      s += `<text class="r-label on-dark" x="${lx}" y="${ly}" text-anchor="middle">THE PASS · ${review.length} ready</text>`;
      add(1, 3.2, 7.6, 4, `<g data-go="orders" class="r-clickable"><title>The pass: ${review.length} orders ready for your review</title>${s}</g>`);
    }

    // Lounge sofa
    add(8, 1.3, 10.6, 2, `<g><title>Lounge</title>${box(8, 1.3, 2.6, 0.7, 0.6, "r-sofa")}${box(8, 1.3, 2.6, 0.25, 1.2, "r-sofa")}</g>`);

    // Dining tables with order tickets waiting to be claimed
    const tables = [[2.2, 6.2], [4.6, 6.4], [2.6, 8.1]];
    tables.forEach(([x, y], i) => {
      let s = box(x - 0.45, y - 0.45, 0.9, 0.9, 0.05, "r-table", 0.9) + box(x - 0.08, y - 0.08, 0.16, 0.16, 0.9, "r-leg");
      const mine = unclaimed.filter((_, k) => k % tables.length === i).slice(0, 3);
      mine.forEach((t, k) => {
        const [tx, ty] = P(x - 0.25 + k * 0.22, y - 0.1 + k * 0.08, 0.96);
        s += `<g><title>Unclaimed order #${t.id}: ${escX(t.title)}</title><rect class="r-ticket" x="${tx - 6}" y="${ty - 8}" width="12" height="15" rx="1.5" transform="rotate(${-12 + k * 9} ${tx} ${ty})"/></g>`;
      });
      add(x - 0.45, y - 0.45, x + 0.45, y + 0.45, `<g data-go="orders" class="r-clickable">${s}</g>`);
    });

    // Host stand (your spot) with the approval bell
    {
      const n = pendingApprovals.length;
      let s = box(9.3, 5.4, 1, 0.8, 1.5, "r-host");
      const [bx, by] = P(9.8, 5.8, 1.5);
      s += `<g class="r-bell ${n ? "ringing" : ""}" transform="translate(${bx} ${by})"><path d="M-8 0 a8 8 0 0 1 16 0 z"/><rect x="-10" y="0" width="20" height="2.5" rx="1"/></g>`;
      if (n) s += `<g class="r-count" transform="translate(${bx + 14} ${by - 16})"><circle r="9"/><text y="4" text-anchor="middle">${n}</text></g>`;
      const [lx, ly] = P(9.8, 6.2, 0.6);
      s += `<text class="r-label on-dark" x="${lx}" y="${ly}" text-anchor="middle">YOU</text>`;
      add(9.3, 5.4, 10.3, 6.2, `<g data-go="approvals" class="r-clickable"><title>Host stand: ${n} approval${n === 1 ? "" : "s"} waiting for you</title>${s}</g>`);
    }

    // Mailbox by the door (notifications)
    {
      let s = box(0.15, 6.6, 0.5, 0.5, 0.9, "r-post") + box(0.05, 6.5, 0.7, 0.7, 0.55, "r-mailbox", 0.9);
      const [fx, fy] = P(0.75, 6.85, 1.2);
      s += `<g class="r-flag ${unread ? "up" : ""}" transform="translate(${fx} ${fy})"><rect x="0" y="-2" width="3" height="18"/><rect x="0" y="-2" width="13" height="8" rx="1"/></g>`;
      if (unread) s += `<g class="r-count" transform="translate(${fx + 22} ${fy - 6})"><circle r="9"/><text y="4" text-anchor="middle">${unread}</text></g>`;
      add(0.05, 6.5, 0.75, 7.2, `<g data-go="inbox" class="r-clickable"><title>Mailbox: ${unread} new notification${unread === 1 ? "" : "s"}</title>${s}</g>`);
    }

    for (const [st, [x, y], mood, extra] of placed) character(st, x, y, mood, extra);

    el.innerHTML = `<svg class="room-svg" viewBox="-298 -95 660 425" role="img" aria-label="Your restaurant">${room()}${backToFront(items).map((i) => i.svg).join("")}${labels.join("")}</svg>`;
    if (selectedId != null) el.querySelector(`[data-staff="${selectedId}"]`)?.classList.add("selected");
    return placed.map(([st, , mood, extra]) => ({ id: st.id, mood, extra }));
  }

  return { render };
})();
