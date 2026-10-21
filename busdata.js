/* ============================================================
   城巴实时班次 · 共享数据层
   bus.html（2D 点阵屏）与 citybus_gis.html（3D 版）共用这一份。
   取数、缓存、跨站配车、位置推算只有这一个主人。

   写成 classic script 而不是 ES module：file:// 页面加载相对路径的
   module 会被 CORS 挡掉，classic script 才可以在本地双击打开。
   ============================================================ */
(function (global) {
  'use strict';

  const API = 'https://rt.data.gov.hk/v2/transport/citybus';
  const ALL_ROUTES = ['B3A', 'B3X', 'B3'];
  let scope = ALL_ROUTES.slice();     // 本页关心的线路
  const DIRS = {O: 'outbound', I: 'inbound'};
  const DIR_LABEL = {O: '去程', I: '回程'};
  const POLL_MS = 20000;
  const SLOT_TTL = 25 * 60000;      // 槽位记忆时长
  const MATCH_TOL = 8 * 60000;      // 同一班车两次观测的容差
  const CACHE_KEY = 'citybus.busdata.v3';
  const OVERPASS_HOSTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
  ];

  /* ── 缓存 ───────────────────────────────────────────── */
  const cache = {
    index: {stops: {}, routes: {}},   // 站名坐标 + 每条线每方向的站序
    slots: {},                        // `${route}|${dir}|${stop}` -> 车辆槽位
    hist: {},                         // `${route}|${dir}|${stop}` -> 到站时间历史
    seg: {},                          // `${route}|${dir}` -> 逐段耗时样本
    geom: {},                         // `${route}|${dir}` -> 真实道路折线
    meta: {updatedAt: 0, lastOk: true, note: ''}
  };
  let cacheDirty = false;
  let cacheSize = 0;

  function loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      Object.assign(cache.index, d.index || {});
      Object.assign(cache.slots, d.slots || {});
      Object.assign(cache.hist, d.hist || {});
      Object.assign(cache.seg, d.seg || {});
      Object.assign(cache.geom, d.geom || {});
      cache.meta = Object.assign(cache.meta, d.meta || {});
      cacheSize = raw.length;
    } catch (e) { console.warn('缓存读取失败', e); }
  }
  function saveCache() {
    if (!cacheDirty) return;
    cacheDirty = false;
    try {
      const payload = JSON.stringify({
        index: cache.index, slots: cache.slots, hist: cache.hist, seg: cache.seg,
        geom: cache.geom, meta: cache.meta
      });
      localStorage.setItem(CACHE_KEY, payload);
      cacheSize = payload.length;
    } catch (e) { console.warn('缓存写入失败（可能超出配额）', e); cacheSize = 0; }
  }
  function clearCache() {
    try { localStorage.removeItem(CACHE_KEY); } catch (e) {}
    cacheSize = 0;
  }
  loadCache();

  /* ── 取数 ───────────────────────────────────────────── */
  async function getJson(url) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20000);
    try {
      const res = await fetch(url, {cache: 'no-store', signal: ac.signal});
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally { clearTimeout(timer); }
  }
  async function pool(items, limit, worker) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({length: Math.min(limit, items.length)}, async () => {
      while (i < items.length) { const k = i++; out[k] = await worker(items[k]); }
    }));
    return out;
  }
  async function overpass(q) {
    let last;
    for (const host of OVERPASS_HOSTS) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 50000);
      try {
        const res = await fetch(host + '?data=' + encodeURIComponent(q),
          {signal: ac.signal, headers: {accept: 'application/json'}});
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
      } catch (e) { last = e; }
      finally { clearTimeout(timer); }
    }
    throw last;
  }

  /* 站序 + 站名坐标 */
  async function ensureIndex() {
    const need = [];
    for (const r of scope) for (const d of ['O', 'I']) {
      if (!cache.index.routes[r] || !cache.index.routes[r][d]) need.push([r, d]);
    }
    if (need.length) {
      await pool(need, 4, async ([r, d]) => {
        try {
          const j = await getJson(`${API}/route-stop/ctb/${r}/${DIRS[d]}`);
          const raw = j.data.filter(s => s.dir === d).sort((a, b) => a.seq - b.seq);
          // 站序里偶尔有连续重复的同一个站（B3A 回程 003262 出现两次），
          // 留着会让「上一站→下一站」这一步算成零长度，去掉重复的那一条。
          const seq = [];
          for (const s of raw) if (!seq.length || seq[seq.length-1].stop !== s.stop)
            seq.push({seq: s.seq, stop: s.stop});
          cache.index.routes[r] = cache.index.routes[r] || {};
          cache.index.routes[r][d] = seq;
          cacheDirty = true;
        } catch (e) { console.warn('站序取數失敗', r, d, e.message); }
      });
    }
    const ids = new Set();
    for (const r of scope) for (const d of ['O', 'I'])
      for (const s of (cache.index.routes[r]?.[d] || [])) ids.add(s.stop);
    const missing = [...ids].filter(id => !cache.index.stops[id]);
    if (missing.length) {
      await pool(missing, 6, async id => {
        try {
          const j = await getJson(`${API}/stop/${id}`);
          const d = Array.isArray(j.data) ? j.data[0] : j.data;
          if (d) {
            cache.index.stops[id] = {zh: d.name_tc, en: d.name_en, lat: +d.lat, lon: +d.long};
            cacheDirty = true;
          }
        } catch (e) {}
      });
    }
  }

  /* 每个（线路, 站）的实时到站时间 */
  async function fetchEtas() {
    const jobs = [];
    for (const r of scope) {
      const seen = new Set();
      for (const d of ['O', 'I'])
        for (const s of (cache.index.routes[r]?.[d] || [])) seen.add(s.stop);
      for (const stop of seen) jobs.push({route: r, stop});
    }
    const out = [];
    await pool(jobs, 6, async j => {
      try { out.push([j, await getJson(`${API}/eta/ctb/${j.stop}/${j.route}`), null]); }
      catch (e) { out.push([j, null, String(e)]); }
    });
    return out;
  }

  /* ── 槽位：每站按到站时间排好的一列车 ───────────────── */
  /* 槽位：一班车在一个站的状态。
     班次的身份是接口给的到达次序 eta_seq（该站该方向的第几班），
     不是到站时间——到站时间是会移动的预测。
     早先拿「到站时间接近」当同一班车，预测一漂移就会把同一班车拆成两条记录，
     同一个分钟在看板上出现两次。 */
  function mergeSlots(key, buses, now) {
    const stop = key.split('|')[2];
    const prev = (cache.slots[key] || []).filter(s => now - s.seenAt < SLOT_TTL);
    const fresh = prev.filter(s => !s.stale);
    const next = [];
    const used = new Set();

    for (const b of buses) {
      let hit = -1;
      if (b.etaSeq != null) {
        for (let i = 0; i < fresh.length; i++){
          if (used.has(i) || fresh[i].etaSeq !== b.etaSeq) continue;
          hit = i; break;
        }
      }
      if (hit < 0) {
        // 沒有次序可對（接口沒給 eta_seq）才退回按時間配對
        let bestD = Infinity;
        for (let i = 0; i < fresh.length; i++){
          if (used.has(i)) continue;
          const d = Math.abs(fresh[i].etaMs - b.etaMs);
          if (d < bestD) { bestD = d; hit = i; }
        }
        if (bestD >= MATCH_TOL) hit = -1;
      }
      let base = null;
      if (hit >= 0) { used.add(hit); base = fresh[hit]; }
      next.push(Object.assign({}, base || {}, {
        eta: b.eta, etaMs: b.etaMs, dest: b.dest, destEn: b.destEn, rmk: b.rmk, rmkEn: b.rmkEn,
        etaSeq: b.etaSeq, seenAt: now, stale: false, stop
      }));
    }
    // 這一輪沒再出現的班次留作記憶（跨站配車時車可能已開過上游站），
    // 但不算數，看板與配對都不用它。
    fresh.forEach((s, i) => {
      if (!used.has(i)) next.push(Object.assign({}, s, {stale: true}));
    });
    next.sort((a, b) => a.etaMs - b.etaMs);
    cache.slots[key] = next;
    cacheDirty = true;
    return next;
  }

  /* ── 到站时间历史 ───────────────────────────────────────
     接口只列「还没到站」的车：一辆车开走上游站，它的到站时间就被接口丢掉了，
     于是「上游到站时间」配不出「下游到站时间」，任何一段都算不出在途的车。
     所以每个站留一份最近半小时的到站时间历史，
     配对时用「上游历史 + 下游当下」，在途车才算得出来。 */
  const HIST_MS = 30 * 60000;
  function noteHistory(key, buses, now) {
    let h = cache.hist[key];
    if (!h) h = cache.hist[key] = [];
    const stop = key.split('|')[2];
    for (const b of buses) {
      if (b.etaMs < now - HIST_MS) continue;
      h.push({etaMs: b.etaMs, dest: b.dest, destEn: b.destEn, rmk: b.rmk, rmkEn: b.rmkEn,
              etaSeq: b.etaSeq, stop: stop});
    }
    h.sort((a, b) => a.etaMs - b.etaMs);
    // 同一班车在多次轮询里会有一串相近的到站时间，保留最接近现在的那个即可
    const keep = [];
    for (const e of h) {
      const last = keep[keep.length - 1];
      if (last && e.etaMs - last.etaMs < 45000) { keep[keep.length - 1] = e; continue; }
      keep.push(e);
    }
    cache.hist[key] = keep.slice(-60);
    cacheDirty = true;
    return cache.hist[key];
  }

  /* 相邻两站之间怎么把班次对上。
     城巴每个站只给 1–2 班车的滑窗 ETA，而且每个站的窗口按各自的时间轴排：
     下游站会先出现上一班车的 ETA，所以「第 1 班车」在两个站往往不是同一班车。
     只按最近时间差配对会把车配错——长途段甚至会配出 1 分钟的假段
     （回程「深圳灣口岸→富泰商場」本该 16 分，配出来只有 2.5 分）。
     三个约束：
       1. 时间差不小于「站间直线距离 ÷ 最高车速」，物理上开不了这么快；
       2. 时间差不超过 25 分钟；
       3. 满足前两条的候选里取与该段典型耗时最接近的，没有典型耗时才取最小的。 */
  const VMAX = 25;                 // m/s，约 90 km/h
  const MAX_SEG_MS = 25 * 60000;
  const MIN_SEG_MS = 20000;

  function pairSegment(A, B, expectedMs, roadDist) {
    const out = [];
    if (!A || !B) return out;
    const minD = Math.max(MIN_SEG_MS, (roadDist || 0) / VMAX * 1000);
    const usedA = new Set();
    /* 逐個下游到站時間往回找上游：
       A 可以是歷史（車已經開走上游站），B 必須還在未來。 */
    for (let bi = 0; bi < B.length; bi++) {
      const b = B[bi];
      if (b.stale) continue;
      let best = -1, bestCost = Infinity;
      for (let ai = 0; ai < A.length; ai++) {
        if (usedA.has(ai)) continue;
        const a = A[ai];
        const d = b.etaMs - a.etaMs;
        if (d < minD || d > MAX_SEG_MS) continue;
        const cost = expectedMs ? Math.abs(d - expectedMs) : d;
        if (cost < bestCost) { bestCost = cost; best = ai; }
      }
      if (best >= 0) { usedA.add(best); out.push([A[best], B[bi]]); }
    }
    return out;
  }

  /* 把同一辆车在各站的出现串成链。
     车开过上游站就从上游列表里消失，所以要靠相邻两站配对把链接起来。 */
  function buildChains(lists, expected, straights) {
    const succ = new Map();
    for (let i = 0; i < lists.length - 1; i++) {
      for (const [a, b] of pairSegment(lists[i], lists[i+1],
                                       expected ? expected[i] : 0,
                                       straights ? straights[i] : 0))
        succ.set(a, b);
    }
    return succ;
  }

  /* 每段两站之间的直线距离（米） */
  function straightSegs(route, dir) {
    const seq = cache.index.routes[route]?.[dir] || [];
    const out = [];
    for (let i = 0; i < seq.length - 1; i++) {
      const a = cache.index.stops[seq[i].stop], b = cache.index.stops[seq[i+1].stop];
      out.push(a && b ? geoDist(a.lat, a.lon, b.lat, b.lon) : 0);
    }
    return out;
  }

  /* 配对时的先验：这一段通常要开多久。
     先用本页自己观测到的中位数，再用静态表里烘好的基线。 */
  function segPrior(route, dir) {
    const key = `${route}|${dir}`;
    const obs = cache.seg[key] || [];
    const stat = (global.BUSROUTES && global.BUSROUTES.segMs && global.BUSROUTES.segMs[key]) || null;
    const out = [];
    const n = Math.max(obs.length, stat ? stat.length : 0);
    for (let i = 0; i < n; i++) {
      if (obs[i] && obs[i].ms) out[i] = obs[i].ms;
      else if (stat && stat[i]) out[i] = stat[i];
      else out[i] = 0;
    }
    return out;
  }

  /* 每辆车现在在哪两站之间、走到几成 */
  function estimate(route, dir, now) {
    const seq = cache.index.routes[route]?.[dir] || [];
    if (!seq.length) return [];
    /* 上游用「历史 + 当下」：车开走上游站后接口就不给了，只剩历史里有它的到站时间；
       下游必须用当下的（还没到的）。 */
    const lists = seq.map(s => {
      const h = cache.hist[`${route}|${dir}|${s.stop}`] || [];
      const cur = cache.slots[`${route}|${dir}|${s.stop}`] || [];
      const seen = new Set();
      return h.concat(cur).filter(e => {
        if (seen.has(e.etaMs)) return false;
        seen.add(e.etaMs);
        return true;
      }).sort((a, b) => a.etaMs - b.etaMs);
    });
    /* 物理下限用「公路距離」而不是直線距離：
       高速段（紅橋→深圳灣口岸）直線只有 11.5 公里、公路 17.6 公里，
       用直線會把 9 分半的假配對放過去（112 km/h，物理上不可能）。 */
    const segs = segmentTable(route, dir);
    const roadDists = segs.map(s => s.distM);
    const succ = buildChains(lists, segPrior(route, dir), roadDists);
    const idx = new Map();
    seq.forEach((s, i) => idx.set(s.stop, i));
    const out = [];

    for (const [a, b] of succ) {
      if (now < a.etaMs || now >= b.etaMs) continue;   // 这一段不含当前时刻
      if (now - a.etaMs > 25 * 60000) continue;          // 太久没动静
      const dur = Math.max(60000, b.etaMs - a.etaMs);
      // 相邻两站才是一次可比的区间耗时，记进分段样本
      const ai = idx.get(a.stop), bi = idx.get(b.stop);
      if (ai != null && bi === ai + 1) noteSegment(route, dir, ai, dur);
      out.push({
        id: `${route}|${dir}|${a.etaMs}>${b.etaMs}`,
        route, dir,
        fromStop: a.stop, toStop: b.stop,
        fromEtaMs: a.etaMs, toEtaMs: b.etaMs,
        progress: (now - a.etaMs) / dur,
        conf: 'high',
        dest: b.dest || a.dest, rmk: b.rmk || a.rmk, rmkEn: b.rmkEn || a.rmkEn, etaSeq: b.etaSeq
      });
    }
    return out;
  }

  /* 一次拉全：所有线路、所有方向的在途车辆 */
  function buses(now) {
    const t = now || Date.now();
    const out = [];
    for (const r of scope) for (const d of ['O', 'I']) out.push(...estimate(r, d, t));
    return out;
  }

  /* ── 分段元数据 ────────────────────────────────────────
     每一段（两站之间）记一个典型耗时：每次相邻两站配上号就收一个样本，
     取最近若干个的中位数当作这一段的常态耗时（受塞车影响会缓慢更新）。
     里程优先用官方路网逐段长度，没有就用站间直线距离。 */
  function noteSegment(route, dir, i, ms){
    if (!(ms > 0) || ms > 30*60000) return;
    const key = `${route}|${dir}`;
    const arr = cache.seg[key] || (cache.seg[key] = []);
    const e = arr[i] || (arr[i] = {samples: []});
    e.samples.push(Math.round(ms));
    if (e.samples.length > 24) e.samples.shift();
    const s = [...e.samples].sort((a,b) => a-b);
    e.ms = s[Math.floor(s.length/2)];
    e.n = s.length;
    e.last = Date.now();
    cacheDirty = true;
  }
  function geoDist(lat1, lon1, lat2, lon2){
    const R0 = 6371008.8, rad = d => d*Math.PI/180;
    const dLat = rad(lat2-lat1), dLon = rad(lon2-lon1);
    const a = Math.sin(dLat/2)**2 +
      Math.cos(rad(lat1))*Math.cos(rad(lat2))*Math.sin(dLon/2)**2;
    return 2*R0*Math.asin(Math.min(1, Math.sqrt(a)));
  }
  function segmentTable(route, dir){
    const seq = cache.index.routes[route]?.[dir] || [];
    if (seq.length < 2) return [];
    const key = `${route}|${dir}`;
    const sm = cache.seg[key] || [];
    const off = (global.BUSROUTES && global.BUSROUTES.segments && global.BUSROUTES.segments[key]) || null;
    const src = (global.BUSROUTES && global.BUSROUTES.segSource && global.BUSROUTES.segSource[key]) || null;
    const meta = (global.BUSROUTES && global.BUSROUTES.routes[key]) || null;
    const stat = (global.BUSROUTES && global.BUSROUTES.segMs && global.BUSROUTES.segMs[key]) || null;

    const out = [];
    for (let i = 0; i < seq.length - 1; i++){
      const a = cache.index.stops[seq[i].stop], b = cache.index.stops[seq[i+1].stop];
      const straight = (a && b) ? geoDist(a.lat, a.lon, b.lat, b.lon) : 0;
      const official = off && off[i] != null ? off[i] : null;
      const s = sm[i];
      const staticMs = stat && stat[i] != null ? stat[i] : 0;
      out.push({
        i, fromStop: seq[i].stop, toStop: seq[i+1].stop,
        ms: s ? s.ms : staticMs, samples: s ? s.n : 0, staticMs,
        straight, distM: official != null ? official : straight,
        distKind: official != null ? (src || 'official') : 'straight'
      });
    }
    // 还没有实测也没有静态基线的段：按全线平均速度推算
    const known = out.filter(s => s.ms > 0 && s.distM > 0);
    const totD = known.reduce((a, s) => a + s.distM, 0);
    const totT = known.reduce((a, s) => a + s.ms, 0);
    const speed = totT ? totD / (totT / 1000) : 8;   // m/s，无观测时按市区巴士均速兜底
    for (const s of out){
      if (!s.ms) s.ms = Math.round(s.distM / speed * 1000);
      s.src = s.samples ? 'observed' : (s.staticMs ? 'static' : 'derived');
      s.speed = s.ms ? s.distM / (s.ms/1000) : 0;
    }
    let cm = 0, cd = 0;
    for (const s of out){ s.cumMs = cm; s.cumDist = cd; cm += s.ms; cd += s.distM; }
    for (const s of out){
      s.totalMs = cm; s.totalDist = cd;
      s.roadLen = meta ? meta.roadLen : null;
    }
    return out;
  }
  /* 车上位置在时间轴与里程轴上的比例 */
  function locate(route, dir, bus, now){
    const segs = segmentTable(route, dir);
    if (!segs.length) return null;
    const i = segs.findIndex(s => s.fromStop === bus.fromStop);
    if (i < 0) return null;
    const s = segs[i];
    const dur = Math.max(60000, bus.toEtaMs - bus.fromEtaMs);
    const p = Math.max(0, Math.min(1, ((now || Date.now()) - bus.fromEtaMs) / dur));
    const ms = s.cumMs + p * dur;
    const dm = s.cumDist + p * s.distM;
    return {
      seg: s, idx: i, p,
      timePos: s.totalMs ? ms / s.totalMs : 0,
      distPos: s.totalDist ? dm / s.totalDist : 0,
      msLeft: s.totalMs ? (s.totalMs - ms) / 60000 : null,
      mLeft: s.totalDist ? s.totalDist - dm : null
    };
  }
  /* 每个站在时间轴/里程轴上的位置 */
  function stopAxis(route, dir){
    const seq = cache.index.routes[route]?.[dir] || [];
    const segs = segmentTable(route, dir);
    if (!seq.length) return [];
    const out = [];
    for (let i = 0; i < seq.length; i++){
      const s = i < segs.length ? segs[i] : null;
      out.push({
        stop: seq[i].stop, seq: seq[i].seq,
        timePos: s ? (s.totalMs ? s.cumMs / s.totalMs : 0) : 1,
        distPos: s ? (s.totalDist ? s.cumDist / s.totalDist : 0) : 1
      });
    }
    return out;
  }

  /* 把选中的站解析到某个方向的站序里。
     同一地点在两个方向常是不同的站台：富泰邨 003261 只在去程，
     回程那一侧是富泰商場 003262，相距 55 m。
     方向里没有这个站时，就近找同位置的站顶替，并记下距离。 */
  const SUBST_MAX = 350;          // 顶替站的最大距离（米）
  function resolveStop(route, dir, stopId) {
    const seq = cache.index.routes[route]?.[dir] || [];
    if (!seq.length) return null;
    const i = seq.findIndex(s => s.stop === stopId);
    if (i >= 0) return {stop: stopId, idx: i, exact: true, dist: 0};
    const t = cache.index.stops[stopId];
    if (!t) return null;
    let best = null, bestD = Infinity;
    seq.forEach((s, k) => {
      const st = cache.index.stops[s.stop];
      if (!st) return;
      const dd = geoDist(t.lat, t.lon, st.lat, st.lon);
      if (dd < bestD) { bestD = dd; best = {stop: s.stop, idx: k, exact: false, dist: dd}; }
    });
    if (!best || bestD > SUBST_MAX) return null;
    return best;
  }

  /* 一段车程：从 board 到 alight，取该方向站序里的这一段。
     ctx 表示两端各多看几个站，让进度条上有点上下文。
     返回沿路各站在时间轴与里程轴上的位置、整段总耗时与总里程。 */
  function spanPlan(route, dir, board, alight, ctx) {
    const seq = cache.index.routes[route]?.[dir] || [];
    const segs = segmentTable(route, dir);
    const ib = seq.findIndex(s => s.stop === board);
    const ia = seq.findIndex(s => s.stop === alight);
    if (ib < 0 || ia < 0 || ib === ia || !segs.length) return null;
    const lo = Math.min(ib, ia), hi = Math.max(ib, ia);
    const c = ctx || 0;
    const wlo = Math.max(0, lo - c), whi = Math.min(seq.length - 1, hi + c);
    const axis = [];
    let t = 0, d = 0;
    for (let i = wlo; i <= whi; i++) {
      if (i > wlo) {
        const s = segs[i-1];
        t += s.ms; d += s.distM;
      }
      axis.push({stop: seq[i].stop, seq: seq[i].seq, tMs: t, dM: d,
                 board: i === ib, alight: i === ia, ride: i >= lo && i <= hi});
    }
    for (const a of axis) {
      a.timePos = t ? a.tMs / t : 0;
      a.distPos = d ? a.dM / d : 0;
    }
    const at = i => axis.find(a => a.stop === seq[i].stop) || null;
    const aLo = at(lo), aHi = at(hi);
    const rideMs = aLo && aHi ? aHi.tMs - aLo.tMs : 0;
    const rideDist = aLo && aHi ? aHi.dM - aLo.dM : 0;
    let observed = 0, staticSeg = 0, derived = 0, straight = 0, distKind = null;
    for (let i = lo; i < hi; i++){
      const sg = segs[i];
      if (!sg) continue;
      if (sg.src === 'observed') observed++;
      else if (sg.src === 'static') staticSeg++;
      else derived++;
      if (sg.distKind === 'straight') straight++;
      else if (!distKind) distKind = sg.distKind;
    }
    return {route, dir, lo, hi, wlo, whi, axis, seq, segs,
            totalMs: t, totalDist: d, rideMs, rideDist, segCount: hi - lo,
            observed, staticSeg, derived, straight, distKind,
            roadLen: segs[0] ? segs[0].roadLen : null};
  }

  /* 车在这段车程里的位置：时间轴 0~1 与里程轴 0~1。
     只算车确实在这段路区间内的情况，区间外的车不画。 */
  function spanLocate(route, dir, bus, now, plan) {
    if (!plan) return null;
    const seq = plan.seq;
    const iFrom = seq.findIndex(s => s.stop === bus.fromStop);
    if (iFrom < 0 || iFrom < plan.wlo || iFrom > plan.whi) return null;
    const segs = plan.segs && plan.segs.length ? plan.segs : segmentTable(route, dir);
    const dur = Math.max(60000, bus.toEtaMs - bus.fromEtaMs);
    const p = Math.max(0, Math.min(1, ((now || Date.now()) - bus.fromEtaMs) / dur));
    let t = 0, dm = 0;
    for (let i = plan.wlo; i < iFrom; i++) { t += segs[i].ms; dm += segs[i].distM; }
    const s = segs[iFrom];
    const timeMs = t + p * dur;
    const dist = dm + p * (s ? s.distM : 0);
    const clamp = v => Math.max(0, Math.min(1, v));
    return {
      timePos: plan.totalMs ? clamp(timeMs / plan.totalMs) : 0,
      distPos: plan.totalDist ? clamp(dist / plan.totalDist) : 0,
      p, segMs: s ? s.ms : dur, segDist: s ? s.distM : 0,
      msLeft: plan.totalMs ? (plan.totalMs - timeMs) / 60000 : null
    };
  }

  /* 车在整条线上的位置，以及到后面每个站还差多少时间与里程。
     时间用该段的典型耗时累计，里程用逐段里程累计。 */
  function busProgress(route, dir, bus, now) {
    const seq = cache.index.routes[route]?.[dir] || [];
    const segs = segmentTable(route, dir);
    const i = seq.findIndex(s => s.stop === bus.fromStop);
    if (i < 0 || i >= segs.length) return null;
    const dur = Math.max(60000, bus.toEtaMs - bus.fromEtaMs);
    const p = Math.max(0, Math.min(1, ((now || Date.now()) - bus.fromEtaMs) / dur));
    const s = segs[i];
    return {
      segIdx: i, p, seq, segs,
      cumMs: s.cumMs + p * dur,
      cumDist: s.cumDist + p * s.distM,
      segMs: s.ms, segDist: s.distM
    };
  }

  /* ── 路径：站坐标折线（有 OSM 实路时用实路） ─────────
     注意：這一層的幾何一律用 [緯度, 經度]（proj/stopPath/bboxOf 一貫）。
     外部來源若是 [經度, 緯度]（GeoJSON 慣例），塞進來之前要先換序。 */
  const R = 6378137;
  let lat0 = 22.45, lon0 = 113.95;
  function proj(lat, lon) {
    return [R * (lon - lon0) * Math.PI / 180 * Math.cos(lat0 * Math.PI / 180),
            R * (lat - lat0) * Math.PI / 180];
  }
  function distM(a, b) {
    const dx = a[0] - b[0], dy = a[1] - b[1];
    return Math.sqrt(dx * dx + dy * dy);
  }
  function stopPath(route, dir) {
    const pts = [];
    for (const s of (cache.index.routes[route]?.[dir] || [])) {
      const st = cache.index.stops[s.stop];
      if (st) pts.push([st.lat, st.lon]);
    }
    return pts;
  }
  function setOrigin(bbox) {
    lat0 = (bbox.north + bbox.south) / 2;
    lon0 = (bbox.west + bbox.east) / 2;
  }
  function bboxOf() {
    // 初始值要是全球范围：北半球的纬度最大 90，最小 -90。
    // 早先写成 n=90 / s=22（南半球的习惯），香港在北半球时 n 永远是 90，
    // 投影原点会落到北纬 56 度，车标会画到西伯利亚去。
    let n = -90, s = 90, w = 180, e = -180;
    const scan = list => list.forEach(p => {
      n = Math.max(n, p[0]); s = Math.min(s, p[0]); w = Math.min(w, p[1]); e = Math.max(e, p[1]);
    });
    for (const r of scope) for (const d of ['O', 'I']) {
      const g = cache.geom[`${r}|${d}`];
      if (g && g.length) scan(g); else scan(stopPath(r, d));
    }
    return {north: n, south: s, west: w, east: e};
  }
  function nearestOnPath(path, p) {
    let best = 0, bestD = Infinity;
    for (let i = 1; i < path.pts.length; i++) {
      const a = path.pts[i-1], b = path.pts[i];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const len2 = dx * dx + dz * dz;
      if (!len2) continue;
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / len2));
      const qx = a[0] + dx * t, qz = a[1] + dz * t;
      const d = (qx - p[0]) * (qx - p[0]) + (qz - p[1]) * (qz - p[1]);
      if (d < bestD) { bestD = d; best = path.cum[i-1] + Math.sqrt(len2) * t; }
    }
    return best;
  }
  function buildPath(route, dir) {
    const g = cache.geom[`${route}|${dir}`];
    const raw = (g && g.length > 2 ? g : stopPath(route, dir));
    const pts = raw.map(p => proj(p[0], p[1]));
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i-1] + distM(pts[i-1], pts[i]));
    const path = {pts, cum, total: cum[cum.length-1] || 0, offset: {}, stopIndex: {}};
    const seq = cache.index.routes[route]?.[dir] || [];
    seq.forEach((s, i) => {
      path.stopIndex[s.stop] = i;
      const st = cache.index.stops[s.stop];
      if (st) path.offset[s.stop] = nearestOnPath(path, proj(st.lat, st.lon));
    });
    return path;
  }
  const paths = {};
  function buildPaths() {
    for (const r of scope) for (const d of ['O', 'I']) paths[`${r}|${d}`] = buildPath(r, d);
  }
  function pointAtDistance(path, d) {
    const {pts, cum} = path;
    if (!pts.length) return null;
    const dd = Math.max(0, Math.min(path.total, d));
    let lo = 0, hi = cum.length - 1;
    while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= dd) lo = mid; else hi = mid; }
    const j = Math.min(lo + 1, pts.length - 1);
    const a = pts[lo], b = pts[j];
    const seg = cum[j] - cum[lo];
    const t = seg > 0 ? (dd - cum[lo]) / seg : 0;
    return {x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t,
            head: Math.atan2(b[0] - a[0], b[1] - a[1])};
  }
  /* 车在两站之间的位置：沿路径按里程插值 */
  function busPosition(b, now) {
    const path = paths[`${b.route}|${b.dir}`];
    if (!path) return null;
    const d0 = path.offset[b.fromStop], d1 = path.offset[b.toStop];
    if (d0 == null || d1 == null) return null;
    const p = Math.max(0, Math.min(1.05,
      (now - b.fromEtaMs) / Math.max(60000, b.toEtaMs - b.fromEtaMs)));
    return pointAtDistance(path, d0 + p * (d1 - d0));
  }
  /* 车在整条线路上的里程位置（0~1），用来在进度条上摆标记 */
  function busDistance(b, now) {
    const path = paths[`${b.route}|${b.dir}`];
    if (!path || !path.total) return null;
    const d0 = path.offset[b.fromStop], d1 = path.offset[b.toStop];
    if (d0 == null || d1 == null) return null;
    const t = now || Date.now();
    const p = Math.max(0, Math.min(1.05,
      (t - b.fromEtaMs) / Math.max(60000, b.toEtaMs - b.fromEtaMs)));
    return (d0 + p * (d1 - d0)) / path.total;
  }

  /* 某辆车到某个站的预计到站时间：在该站的车列里找时间最接近的一个 */
  function etaAtStop(route, dir, stop, refMs, forward) {
    const list = cache.slots[`${route}|${dir}|${stop}`] || [];
    let best = null, bestD = Infinity;
    for (const s of list) {
      const d = s.etaMs - refMs;
      if (forward ? d < -60000 : d > 60000) continue;
      if (Math.abs(d) < bestD) { bestD = Math.abs(d); best = s; }
    }
    return best ? best.etaMs : null;
  }
  /* 两站之间隔着几个站 */
  function stopsBetween(route, dir, fromStop, toStop) {
    const path = paths[`${route}|${dir}`];
    if (!path) return null;
    const a = path.stopIndex[fromStop], b = path.stopIndex[toStop];
    if (a == null || b == null) return null;
    return Math.abs(b - a) - 1;
  }

  /* ── 拉一次全量 ─────────────────────────────────────── */
  async function pull() {
    const now = Date.now();
    const res = await fetchEtas();
    const byKey = new Map();
    let ok = 0, fail = 0;
    for (const [j, body, err] of res) {
      if (!body) { fail++; continue; }
      ok++;
      for (const b of body.data) {
        if (!b.eta) continue;
        const key = `${j.route}|${b.dir}|${b.stop}`;
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push({eta: b.eta, etaMs: Date.parse(b.eta), dest: b.dest_tc,
                             destEn: b.dest_en, rmk: b.rmk_tc, rmkEn: b.rmk_en, etaSeq: b.eta_seq});
      }
    }
    for (const [key, list] of byKey) {
      list.sort((a, b) => a.etaMs - b.etaMs);
      mergeSlots(key, list, now);
      noteHistory(key, list, now);
    }
    cache.meta.updatedAt = now;
    cache.meta.lastOk = fail === 0;
    cacheDirty = true;
    saveCache();
    return {ok, fail, at: now};
  }

  /* ── OSM 实路与建筑（3D 版用，2D 版只用实路做里程） ── */
  async function loadGeometry() {
    for (const r of scope) {
      for (const d of ['O', 'I']) {
        const key = `${r}|${d}`;
        if (cache.geom[key] && cache.geom[key].length) continue;
        try {
          const q = `[out:json][timeout:60];relation["type"="route"]["route"="bus"]["ref"="${r}"];out geom;`;
          const j = await overpass(q);
          const rel = j.elements.find(e => e.type === 'relation' && (e.tags?.ref === r));
          if (!rel) continue;
          const pts = [];
          for (const m of rel.members || []) {
            if (m.type !== 'way' || !m.geometry) continue;
            for (const p of m.geometry) pts.push([p.lat, p.lon]);
          }
          if (pts.length > 2) { cache.geom[key] = pts; cacheDirty = true; }
        } catch (e) { console.warn('Overpass 路径失败', r, d, e.message); }
      }
    }
    saveCache();
  }
  async function loadBuildings() {
    const pts = [];
    for (const r of scope) for (const d of ['O', 'I']) {
      const g = cache.geom[`${r}|${d}`] || stopPath(r, d);
      for (let i = 0; i < g.length; i += 3) pts.push(g[i]);
    }
    if (!pts.length) return [];
    const around = pts.map(p => `${p[0].toFixed(5)},${p[1].toFixed(5)}`).join(',');
    try {
      const q = `[out:json][timeout:120];way["building"](around:260,${around});out geom;`;
      const j = await overpass(q);
      const list = j.elements.filter(e => e.type === 'way' && e.geometry && e.geometry.length > 2)
        .map(e => ({pts: e.geometry.map(p => [p.lat, p.lon]),
                    h: +(e.tags?.['building:levels'] || e.tags?.height || 0)}));
      if (list.length) { cache.buildings = list; cacheDirty = true; saveCache(); }
      return list;
    } catch (e) { console.warn('Overpass 建筑失败', e.message); return []; }
  }

  global.CB = {
    API, ALL_ROUTES, DIRS, DIR_LABEL, POLL_MS, CACHE_KEY,
    get ROUTES() { return scope.slice(); },
    setScope(list) { scope = (list && list.length ? list : ALL_ROUTES).slice(); },
    cache, paths,
    get cacheSize() { return cacheSize; },
    loadCache, saveCache, clearCache,
    ensureIndex, fetchEtas, pull, mergeSlots, buildChains, estimate, buses,
    stopPath, buildPath, buildPaths, setOrigin, bboxOf, proj, distM,
    noteSegment, geoDist, segmentTable, locate, stopAxis,
    resolveStop, spanPlan, spanLocate, busProgress, SUBST_MAX,
    pairSegment, straightSegs, segPrior, VMAX,
    pointAtDistance, nearestOnPath, busPosition, busDistance, etaAtStop, stopsBetween,
    loadGeometry, loadBuildings, overpass, getJson, pool
  };
})(window);
