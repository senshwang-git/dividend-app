// 숫자 포맷과 SVG 차트 (의존성 없음)

/* ---------- 포맷 ---------- */
export const nf = new Intl.NumberFormat("ko-KR");
export function man(v) {
  const a = Math.abs(v), s = v < 0 ? "-" : "";
  if (a >= 1e8) return `${s}${(a / 1e8).toFixed(a >= 1e10 ? 0 : 2)}억`;
  if (a >= 1e4) return `${s}${nf.format(Math.round(a / 1e4))}만`;
  return `${s}${nf.format(Math.round(a))}원`;
}
export const won = (v) => `${nf.format(Math.round(v))}원`;
export const manNum = (v) => nf.format(Math.round(v / 1e4));
export const pct = (v, d = 1) => `${(v * 100).toFixed(d)}%`;
export const cssVar = (name) => `var(${name})`;
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/* ---------- SVG 차트 ---------- */
export function niceTicks(max, count = 4) {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const ticks = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  if (ticks.at(-1) < max) ticks.push(ticks.at(-1) + step);
  return ticks;
}

// labels: x축 값, series: [{ name, color, values, dash, stack }], kind: line | bar
export function drawChart(el, { labels, series, kind = "line", xTick }) {
  el.innerHTML = "";
  const W = Math.max(280, el.clientWidth || 320), H = 220;
  const pad = { l: 46, r: 8, t: 10, b: 24 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const n = labels.length;
  let max = 0;
  if (kind === "bar") {
    for (let i = 0; i < n; i++) max = Math.max(max, series.reduce((a, s) => a + (s.values[i] || 0), 0));
  } else {
    for (const s of series) for (const v of s.values) max = Math.max(max, v);
  }
  const ticks = niceTicks(max);
  const top = ticks.at(-1) || 1;
  const y = (v) => pad.t + ih - (v / top) * ih;
  const band = iw / Math.max(1, n);
  const x = kind === "bar" ? (i) => pad.l + band * (i + 0.5) : (i) => pad.l + (n > 1 ? (iw * i) / (n - 1) : iw / 2);

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.map((s) => s.name).join(", "))}">`;
  for (const t of ticks) {
    svg += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}"/>`;
    svg += `<text class="axis" x="${pad.l - 6}" y="${y(t) + 3.5}" text-anchor="end">${t ? man(t) : "0"}</text>`;
  }
  // x 라벨: 겹치지 않을 만큼만
  const xIdx = labels.map((l, i) => i).filter((i) => xTick(labels[i], i));
  const minGap = 34;
  let lastX = -Infinity;
  for (const i of xIdx) {
    const px = x(i);
    if (px - lastX < minGap) continue;
    lastX = px;
    svg += `<text class="axis" x="${px}" y="${H - 6}" text-anchor="middle">${esc(xTick(labels[i], i))}</text>`;
  }
  if (kind === "bar") {
    const bw = Math.max(1.5, Math.min(28, band - Math.max(1, band * 0.25)));
    for (let i = 0; i < n; i++) {
      let acc = 0;
      const parts = series.map((s) => [s, s.values[i] || 0]).filter(([, v]) => v > 0);
      parts.forEach(([s, v], k) => {
        const y0 = y(acc), y1 = y(acc + v);
        acc += v;
        const h = Math.max(0, y0 - y1 - (k < parts.length - 1 && band > 6 ? 1.5 : 0));
        const isTop = k === parts.length - 1;
        const r = isTop && bw > 6 ? Math.min(3, h) : 0;
        const x0 = x(i) - bw / 2;
        svg += r
          ? `<path d="M${x0},${y1 + h} V${y1 + r} Q${x0},${y1} ${x0 + r},${y1} H${x0 + bw - r} Q${x0 + bw},${y1} ${x0 + bw},${y1 + r} V${y1 + h} Z" style="fill:${cssVar(s.color)}"/>`
          : `<rect x="${x0}" y="${y1}" width="${bw}" height="${h}" style="fill:${cssVar(s.color)}"/>`;
      });
    }
  } else {
    // 앞 시리즈가 위에 오도록 역순으로 그린다
    for (const s of [...series].reverse()) {
      const d = s.values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
      svg += `<path d="${d}" fill="none" style="stroke:${cssVar(s.color)}" stroke-width="2" stroke-linejoin="round" ${s.dash ? 'stroke-dasharray="5 4"' : ""}/>`;
      const lx = x(n - 1), ly = y(s.values[n - 1]);
      svg += `<circle cx="${lx}" cy="${ly}" r="3.5" style="fill:${cssVar(s.color)};stroke:var(--surface)" stroke-width="2"/>`;
    }
  }
  svg += `<line class="cross" id="cross" x1="0" x2="0" y1="${pad.t}" y2="${pad.t + ih}" visibility="hidden"/>`;
  svg += `<rect x="${pad.l}" y="0" width="${iw}" height="${H}" fill="transparent" class="hit"/></svg>`;
  el.innerHTML = svg + `<div class="tip" hidden></div>`;

  // 호버/터치 툴팁
  const svgEl = el.querySelector("svg"), tip = el.querySelector(".tip"), cross = el.querySelector("#cross");
  const show = (clientX) => {
    const rect = svgEl.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * W;
    let i = kind === "bar" ? Math.floor((px - pad.l) / band) : Math.round(((px - pad.l) / iw) * (n - 1));
    i = Math.max(0, Math.min(n - 1, i));
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
    const rowsHtml = series
      .filter((s) => kind !== "bar" || (s.values[i] || 0) > 0)
      .map((s) => `<div class="row"><span><i style="display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px;background:${cssVar(s.color)}"></i>${esc(s.name)}</span><span>${man(s.values[i] || 0)}</span></div>`)
      .join("");
    const total = kind === "bar" ? series.reduce((a, s) => a + (s.values[i] || 0), 0) : null;
    tip.innerHTML = `<b>${esc(labels[i])}</b>${rowsHtml || '<div class="row"><span>입금 없음</span></div>'}${total ? `<div class="row" style="border-top:1px solid currentColor;margin-top:3px;padding-top:3px"><span>합계</span><span>${man(total)}</span></div>` : ""}`;
    tip.hidden = false;
    const left = (x(i) / W) * rect.width;
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.min(Math.max(0, left - tw / 2), rect.width - tw)}px`;
    tip.style.top = `${-tip.offsetHeight - 6}px`;
  };
  const hide = () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); };
  svgEl.addEventListener("pointermove", (e) => show(e.clientX));
  svgEl.addEventListener("pointerdown", (e) => show(e.clientX));
  svgEl.addEventListener("pointerleave", hide);
}

export function legend(el, items) {
  el.innerHTML = items
    .map((s) => `<span><i class="${s.dash ? "dash" : ""}" style="background:${cssVar(s.color)}"></i>${esc(s.name)}</span>`)
    .join("");
}

