/* Solar Idle — vanilla JS idle/clicker
   - Energy storage (kWh)
   - Production (kW) with day/night curve + clouds
   - Sell energy at PPA price, limited by inverter throughput
   - Buy panels/inverters/trackers/batteries
   - Upgrades, achievements, autosave, offline progress, import/export
*/

(() => {
  "use strict";

  // ---------- Helpers ----------
  const $ = (id) => document.getElementById(id);

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const fmt = {
    money(v){
      const abs = Math.abs(v);
      if (abs >= 1e9) return `$${(v/1e9).toFixed(2)}B`;
      if (abs >= 1e6) return `$${(v/1e6).toFixed(2)}M`;
      if (abs >= 1e3) return `$${(v/1e3).toFixed(2)}K`;
      return `$${v.toFixed(2)}`;
    },
    num(v){
      const abs = Math.abs(v);
      if (abs >= 1e9) return `${(v/1e9).toFixed(2)}B`;
      if (abs >= 1e6) return `${(v/1e6).toFixed(2)}M`;
      if (abs >= 1e3) return `${(v/1e3).toFixed(2)}K`;
      return `${v.toFixed(2)}`;
    },
    int(v){
      return `${Math.floor(v).toLocaleString()}`;
    },
    kwh(v){
      const abs = Math.abs(v);
      if (abs >= 1e6) return `${(v/1e6).toFixed(2)} GWh`;
      if (abs >= 1e3) return `${(v/1e3).toFixed(2)} MWh`;
      return `${v.toFixed(2)} kWh`;
    },
    kw(v){
      const abs = Math.abs(v);
      if (abs >= 1e6) return `${(v/1e6).toFixed(2)} GW`;
      if (abs >= 1e3) return `${(v/1e3).toFixed(2)} MW`;
      return `${v.toFixed(2)} kW`;
    },
    pct(v){
      return `${Math.round(v*100)}%`;
    }
  };

  const now = () => Date.now();

  function safeParseJSON(str){
    try { return JSON.parse(str); } catch { return null; }
  }

  function encodeSave(obj){
    // compact-ish base64
    const json = JSON.stringify(obj);
    return btoa(unescape(encodeURIComponent(json)));
  }

  function decodeSave(b64){
    try {
      const json = decodeURIComponent(escape(atob(b64.trim())));
      return JSON.parse(json);
    } catch {
      return null;
    }
  }
   
let els = null;          // ✅ exists immediately (no TDZ)
let pendingEventMsg = ""; // buffer messages before UI is ready

  // ---------- Game Data ----------
  const VERSION = 1;
  const SAVE_KEY = "solarIdleSave_v1";

  // Core economic knobs (tweak for balance)
  const ECON = {
    ppaPrice: 0.12,            // $/kWh
    co2KgPerKWh: 0.4,          // kg CO2 avoided per kWh (rough)
    dayLengthSec: 360,         // 6 minutes per full day cycle
    cloudChancePerSec: 0.012,  // chance to start a cloud event each second
    cloudDurationSec: [12, 26],
    cloudFactor: [0.45, 0.75], // sun multiplier during clouds
    offlineCapSec: 8 * 3600
  };

  // Hardware base stats
  const HW = {
    panelKW: 0.30,             // each panel peak kW (at full sun)
    inverterKW: 3.0,           // sell throughput capacity per inverter (kW)
    trackerSunBonus: 0.06,     // additive sun factor boost per tracker (diminishing later)
    batteryKWh: 20,            // storage capacity per battery
    clickKWhBase: 0.05         // manual energy per click
  };

  // Costs scale exponentially
  function costFor(base, count, scale){
    return Math.floor(base * Math.pow(scale, count));
  }

  // Upgrades (one-time purchases)
  const UPGRADE_DEFS = [
    {
      id: "cleaning",
      name: "Robotic Cleaning",
      desc: "+10% panel output (less soiling loss).",
      cost: 250,
      apply: (s) => s.mods.panelMult *= 1.10
    },
    {
      id: "bifacial",
      name: "Bifacial Modules",
      desc: "+15% panel output.",
      cost: 900,
      req: (s) => s.hardware.panels >= 15,
      apply: (s) => s.mods.panelMult *= 1.15
    },
    {
      id: "stringopt",
      name: "String Optimization",
      desc: "+12% inverter throughput (better clipping management).",
      cost: 1200,
      req: (s) => s.hardware.inverters >= 4,
      apply: (s) => s.mods.inverterMult *= 1.12
    },
    {
      id: "forecast",
      name: "AI Forecast Dispatch",
      desc: "+15% revenue (sell timing & storage dispatch).",
      cost: 2500,
      req: (s) => s.hardware.batteries >= 2,
      apply: (s) => s.mods.revenueMult *= 1.15
    },
    {
      id: "advancedtrack",
      name: "Backtracking Algorithm",
      desc: "Trackers become more effective (+50% tracker bonus).",
      cost: 3200,
      req: (s) => s.hardware.trackers >= 5,
      apply: (s) => s.mods.trackerMult *= 1.50
    },
    {
      id: "clickboost",
      name: "Crew On Call",
      desc: "+0.05 kWh per click.",
      cost: 800,
      apply: (s) => s.mods.clickAdd += 0.05
    },
    {
      id: "dcbonus",
      name: "Domestic Content Bonus",
      desc: "+8% revenue multiplier.",
      cost: 4000,
      req: (s) => s.lifetimeSoldKWh >= 5000,
      apply: (s) => s.mods.revenueMult *= 1.08
    },
    {
      id: "gridscale",
      name: "Grid Expansion Interconnect",
      desc: "+25% max storage (better interconnect & controls).",
      cost: 6500,
      req: (s) => s.hardware.batteries >= 6,
      apply: (s) => s.mods.storageMult *= 1.25
    }
  ];

  const ACHIEVEMENTS = [
    { id:"firstClick", name:"First Electron", icon:"⚡", check: (s)=>s.stats.clicks>=1 },
    { id:"firstPanel", name:"Racked & Ready", icon:"🧱", check: (s)=>s.hardware.panels>=1 },
    { id:"tenPanels", name:"Rooftop Array", icon:"🏢", check: (s)=>s.hardware.panels>=10 },
    { id:"firstBattery", name:"Storage Online", icon:"🔋", check: (s)=>s.hardware.batteries>=1 },
    { id:"firstInverter", name:"Grid-Tied", icon:"🔌", check: (s)=>s.hardware.inverters>=1 },
    { id:"sell1mwh", name:"First MWh Sold", icon:"💰", check: (s)=>s.lifetimeSoldKWh>=1000 },
    { id:"sell50mwh", name:"Serious Developer", icon:"📈", check: (s)=>s.lifetimeSoldKWh>=50000 },
    { id:"cash100k", name:"Cashflow Positive", icon:"🏦", check: (s)=>s.cash>=100000 },
    { id:"cloudSurvivor", name:"Weathered the Storm", icon:"☁️", check: (s)=>s.stats.cloudEvents>=5 },
  ];

  // ---------- State ----------
  function defaultState(){
    return {
      version: VERSION,
      t: now(),

      // resources
      cash: 0,
      energyKWh: 0,

      // lifetime
      lifetimeSoldKWh: 0,
      lifetimeRevenue: 0,

      // hardware
      hardware: {
        panels: 1,
        inverters: 1,
        trackers: 0,
        batteries: 0
      },

      // modifiers from upgrades
      mods: {
        panelMult: 1.0,
        inverterMult: 1.0,
        trackerMult: 1.0,
        storageMult: 1.0,
        revenueMult: 1.0,
        clickAdd: 0.0
      },

      // toggles
      autosell: true,
      reduceMotion: false,

      // time/cycle
      dayPhase: 0.25, // 0..1, 0.25 = morning-ish

      // events
      cloud: {
        active: false,
        endsAt: 0,
        factor: 1.0
      },

      // stats
      stats: {
        clicks: 0,
        totalGeneratedKWh: 0,
        totalCurtailedKWh: 0,
        cloudEvents: 0,
        lastTickAt: now()
      },

      // upgrades purchased
      upgrades: {},

      // achievements
      ach: {}
    };
  }

  let S = loadOrInit();

  // ---------- Derived Calculations ----------
  function storageCapKWh(s){
    const base = s.hardware.batteries * HW.batteryKWh;
    return base * s.mods.storageMult;
  }

  function trackerSunBonus(s){
    // diminishing returns so trackers don’t explode
    const t = s.hardware.trackers;
    const diminishing = 1 - Math.exp(-t / 18);
    return (HW.trackerSunBonus * t) * diminishing * s.mods.trackerMult;
  }

  function sunFactor(s){
    // Smooth day curve: sin(pi * phase)^gamma (night = 0)
    // phase: 0 at midnight, 0.5 noon, 1 next midnight
    const phase = s.dayPhase;
    const raw = Math.sin(Math.PI * phase);
    const shaped = Math.pow(Math.max(0, raw), 1.55);

    // trackers boost sun capture (especially shoulders)
    const bonus = trackerSunBonus(s);

    let sf = clamp(shaped + bonus, 0, 1.25);

    // clouds
    if (s.cloud.active) sf *= s.cloud.factor;

    return clamp(sf, 0, 1.25);
  }

  function generationKW(s){
    // Panels produce at peak * sunFactor * panelMult
    return s.hardware.panels * HW.panelKW * sunFactor(s) * s.mods.panelMult;
  }

  function inverterSellCapKW(s){
    return s.hardware.inverters * HW.inverterKW * s.mods.inverterMult;
  }

  function clickKWh(s){
    return HW.clickKWhBase + s.mods.clickAdd;
  }

  // ---------- Economy / Store definitions ----------
  const STORE_ITEMS = [
    {
      id: "panels",
      name: "Solar Panel",
      desc: `Adds +${HW.panelKW.toFixed(2)} kW peak generation.`,
      baseCost: 25,
      scale: 1.12,
      buy: (s) => s.hardware.panels++,
      cost: (s) => costFor(25, s.hardware.panels, 1.12),
    },
    {
      id: "inverters",
      name: "Inverter",
      desc: `Increases sell throughput by +${HW.inverterKW.toFixed(1)} kW.`,
      baseCost: 90,
      scale: 1.15,
      buy: (s) => s.hardware.inverters++,
      cost: (s) => costFor(90, s.hardware.inverters, 1.15),
    },
    {
      id: "trackers",
      name: "Tracker",
      desc: "Improves sun capture (shoulders + midday). Diminishing returns.",
      baseCost: 140,
      scale: 1.17,
      req: (s) => s.hardware.panels >= 10,
      buy: (s) => s.hardware.trackers++,
      cost: (s) => costFor(140, s.hardware.trackers, 1.17),
    },
    {
      id: "batteries",
      name: "Battery",
      desc: `Adds +${HW.batteryKWh} kWh storage.`,
      baseCost: 220,
      scale: 1.16,
      req: (s) => s.hardware.inverters >= 2,
      buy: (s) => s.hardware.batteries++,
      cost: (s) => costFor(220, s.hardware.batteries, 1.16),
    }
  ];

  // ---------- UI Build ----------
  els = {
    cash: $("cash"),
    cashRate: $("cashRate"),
    energy: $("energy"),
    storage: $("storage"),
    gen: $("gen"),
    sun: $("sun"),
    ppa: $("ppa"),
    sellCap: $("sellCap"),
    curtail: $("curtail"),
    lifetimeSold: $("lifetimeSold"),
    co2: $("co2"),

    kpiPanels: $("kpiPanels"),
    kpiInverters: $("kpiInverters"),
    kpiTrackers: $("kpiTrackers"),
    kpiBatteries: $("kpiBatteries"),

    btnClick: $("btnClick"),
    clickHint: $("clickHint"),
    toggleAutosell: $("toggleAutosell"),
    toggleReduceMotion: $("toggleReduceMotion"),

    barStorage: $("barStorage"),
    storagePct: $("storagePct"),
    barDay: $("barDay"),
    timeOfDay: $("timeOfDay"),

    eventLine: $("eventLine"),
    store: $("store"),
    upgrades: $("upgrades"),
    stats: $("stats"),
    achievements: $("achievements"),

    btnSave: $("btnSave"),
    btnExport: $("btnExport"),
    btnImport: $("btnImport"),
    btnReset: $("btnReset"),

    modal: $("modal"),
    modalTitle: $("modalTitle"),
    modalBody: $("modalBody"),
    modalClose: $("modalClose"),
  };

function setEventLine(msg){
  pendingEventMsg = msg;                 // always remember last message
  if (els?.eventLine) els.eventLine.textContent = msg;  // only write if ready
}

  function openModal(title, bodyNode){
    els.modalTitle.textContent = title;
    els.modalBody.innerHTML = "";
    els.modalBody.appendChild(bodyNode);
    els.modal.classList.remove("hidden");
  }
  function closeModal(){
    els.modal.classList.add("hidden");
  }

  // store UI
  function buildStore(){
    els.store.innerHTML = "";
    for (const item of STORE_ITEMS){
      const row = document.createElement("div");
      row.className = "item";

      const left = document.createElement("div");
      left.className = "left";
      const name = document.createElement("div");
      name.className = "name";
      name.textContent = item.name;

      const desc = document.createElement("div");
      desc.className = "desc";
      desc.textContent = item.desc;

      const meta = document.createElement("div");
      meta.className = "meta";
      meta.id = `meta_${item.id}`;

      left.appendChild(name);
      left.appendChild(desc);
      left.appendChild(meta);

      const btn = document.createElement("button");
      btn.className = "btn";
      btn.id = `buy_${item.id}`;
      btn.textContent = "Buy";
      btn.addEventListener("click", () => buyItem(item.id));

      row.appendChild(left);
      row.appendChild(btn);
      els.store.appendChild(row);
    }
  }

  function buildUpgrades(){
    els.upgrades.innerHTML = "";
    for (const u of UPGRADE_DEFS){
      const row = document.createElement("div");
      row.className = "item";
      row.id = `up_${u.id}`;

      const left = document.createElement("div");
      left.className = "left";
      const name = document.createElement("div");
      name.className = "name";
      name.textContent = u.name;

      const desc = document.createElement("div");
      desc.className = "desc";
      desc.textContent = u.desc;

      const meta = document.createElement("div");
      meta.className = "meta";
      meta.id = `upmeta_${u.id}`;

      left.appendChild(name);
      left.appendChild(desc);
      left.appendChild(meta);

      const btn = document.createElement("button");
      btn.className = "btn";
      btn.id = `upbuy_${u.id}`;
      btn.textContent = "Buy";
      btn.addEventListener("click", () => buyUpgrade(u.id));

      row.appendChild(left);
      row.appendChild(btn);
      els.upgrades.appendChild(row);
    }
  }

  function buildAchievements(){
    els.achievements.innerHTML = "";
    for (const a of ACHIEVEMENTS){
      const badge = document.createElement("div");
      badge.className = "badge";
      badge.id = `ach_${a.id}`;
      badge.textContent = `${a.icon} ${a.name}`;
      els.achievements.appendChild(badge);
    }
  }

  buildStore();
  buildUpgrades();
  buildAchievements();

  // ---------- Actions ----------
  function buyItem(id){
    const item = STORE_ITEMS.find(x => x.id === id);
    if (!item) return;

    if (item.req && !item.req(S)){
      setEventLine("Requirement not met yet for that item.");
      return;
    }

    const c = item.cost(S);
    if (S.cash < c){
      setEventLine("Not enough cash.");
      return;
    }

    S.cash -= c;
    item.buy(S);
    setEventLine(`Purchased: ${item.name}.`);
    checkMilestones();
    render();
  }

  function buyUpgrade(id){
    const u = UPGRADE_DEFS.find(x => x.id === id);
    if (!u) return;
    if (S.upgrades[id]){
      setEventLine("Already purchased.");
      return;
    }
    if (u.req && !u.req(S)){
      setEventLine("You don't meet the requirement yet.");
      return;
    }
    if (S.cash < u.cost){
      setEventLine("Not enough cash.");
      return;
    }

    S.cash -= u.cost;
    S.upgrades[id] = true;
    u.apply(S);
    setEventLine(`Upgrade acquired: ${u.name}.`);
    render();
  }

  function doClick(){
    const add = clickKWh(S);
    const cap = storageCapKWh(S);

    // if no storage, we can still hold some "buffer" of 5 kWh so early game isn't harsh
    const effectiveCap = Math.max(cap, 5);

    const before = S.energyKWh;
    S.energyKWh = clamp(S.energyKWh + add, 0, effectiveCap);

    const curtailed = (before + add) - S.energyKWh;
    if (curtailed > 0){
      S.stats.totalCurtailedKWh += curtailed;
    }

    S.stats.clicks++;
    S.stats.totalGeneratedKWh += (S.energyKWh - before) + Math.max(0, curtailed);
    checkMilestones();
    render();
  }

  // ---------- Tick / Simulation ----------
  function tick(dt){
    // advance day phase
    const daySpeed = dt / ECON.dayLengthSec;
    S.dayPhase = (S.dayPhase + daySpeed) % 1;

    // maybe start/stop clouds
    handleClouds(dt);

    // generation -> energy storage
    const gen = generationKW(S); // kW
    const genKWh = gen * (dt / 3600); // convert to kWh per dt
    const cap = Math.max(storageCapKWh(S), 5);

    const beforeE = S.energyKWh;
    S.energyKWh = clamp(S.energyKWh + genKWh, 0, cap);
    const curtailed = (beforeE + genKWh) - S.energyKWh;
    if (curtailed > 1e-9){
      S.stats.totalCurtailedKWh += curtailed;
    }
    S.stats.totalGeneratedKWh += genKWh;

    // selling
    const sellCapKW = inverterSellCapKW(S);
    const sellCapKWh = sellCapKW * (dt / 3600);
    let sold = 0;

    if (S.autosell && sellCapKWh > 0){
      sold = Math.min(S.energyKWh, sellCapKWh);
      S.energyKWh -= sold;

      const revenue = sold * ECON.ppaPrice * S.mods.revenueMult;
      S.cash += revenue;
      S.lifetimeSoldKWh += sold;
      S.lifetimeRevenue += revenue;
    }

    // stats / achievements
    checkMilestones();
  }

  function handleClouds(dt){
    const t = now();

    if (S.cloud.active){
      if (t >= S.cloud.endsAt){
        S.cloud.active = false;
        S.cloud.factor = 1.0;
        setEventLine("Skies cleared. Back to full production.");
      }
      return;
    }

    // chance to start a cloud event
    const chance = ECON.cloudChancePerSec * dt;
    if (Math.random() < chance){
      const dur = randBetween(ECON.cloudDurationSec[0], ECON.cloudDurationSec[1]);
      const f = randBetween(ECON.cloudFactor[0], ECON.cloudFactor[1]);
      S.cloud.active = true;
      S.cloud.endsAt = t + dur * 1000;
      S.cloud.factor = f;
      S.stats.cloudEvents++;
      setEventLine(`Clouds rolling in… production reduced (${Math.round(f*100)}%) for ~${Math.round(dur)}s.`);
    }
  }

  function randBetween(a, b){
    return a + Math.random() * (b - a);
  }

  // ---------- Achievements ----------
  function checkMilestones(){
    for (const a of ACHIEVEMENTS){
      if (!S.ach[a.id] && a.check(S)){
        S.ach[a.id] = true;
        setEventLine(`Achievement unlocked: ${a.name}!`);
      }
    }
  }

  // ---------- Rendering ----------
  function render(){
    // Top stats
    els.cash.textContent = fmt.money(S.cash);
    els.energy.textContent = fmt.kwh(S.energyKWh);

    const cap = Math.max(storageCapKWh(S), 5);
    els.storage.textContent = `${fmt.kwh(S.energyKWh)} / ${fmt.kwh(cap)}`;

    const gen = generationKW(S);
    els.gen.textContent = fmt.kw(gen);

    const sf = sunFactor(S);
    els.sun.textContent = `Sun: ${fmt.pct(clamp(sf, 0, 1.0))}`;

    els.ppa.textContent = `$${ECON.ppaPrice.toFixed(2)}/kWh`;
    const sellCapKW = inverterSellCapKW(S);
    els.sellCap.textContent = fmt.kw(sellCapKW);

    const curtailRate = S.stats.totalGeneratedKWh > 0
      ? (S.stats.totalCurtailedKWh / S.stats.totalGeneratedKWh)
      : 0;
    els.curtail.textContent = `${Math.round(curtailRate*100)}%`;

    els.lifetimeSold.textContent = fmt.kwh(S.lifetimeSoldKWh);
    const co2t = (S.lifetimeSoldKWh * ECON.co2KgPerKWh) / 1000;
    els.co2.textContent = `${co2t.toFixed(2)} t`;

    // KPI
    els.kpiPanels.textContent = fmt.int(S.hardware.panels);
    els.kpiInverters.textContent = fmt.int(S.hardware.inverters);
    els.kpiTrackers.textContent = fmt.int(S.hardware.trackers);
    els.kpiBatteries.textContent = fmt.int(S.hardware.batteries);

    // Click hint
    els.clickHint.textContent = `(+${clickKWh(S).toFixed(2)} kWh)`;

    // Bars
    const pct = cap > 0 ? (S.energyKWh / cap) : 0;
    els.barStorage.style.width = `${clamp(pct, 0, 1) * 100}%`;
    els.storagePct.textContent = `${Math.round(clamp(pct, 0, 1)*100)}%`;

    const day = S.dayPhase;
    els.barDay.style.width = `${day * 100}%`;
    els.timeOfDay.textContent = dayLabel(day);

    // Cash rate estimate: compute at current sun factor (rough)
    const instantSellCap = sellCapKW;
    const instantSellKW = S.autosell ? Math.min(gen, instantSellCap) : 0;
    const cashPerSec = (instantSellKW / 3600) * ECON.ppaPrice * S.mods.revenueMult;
    els.cashRate.textContent = `+${fmt.money(cashPerSec)}/s`;

    // Store rows update
    for (const item of STORE_ITEMS){
      const c = item.cost(S);
      const meta = $(`meta_${item.id}`);
      const btn = $(`buy_${item.id}`);

      const reqOk = item.req ? item.req(S) : true;
      const ownedCount = getOwnedCount(item.id);

      meta.textContent = `Cost: ${fmt.money(c)} • Owned: ${fmt.int(ownedCount)}${reqOk ? "" : " • Locked"}`;
      btn.disabled = (!reqOk) || (S.cash < c);
      btn.textContent = reqOk ? `Buy (${fmt.money(c)})` : "Locked";
    }

    // Upgrades update
    for (const u of UPGRADE_DEFS){
      const meta = $(`upmeta_${u.id}`);
      const btn = $(`upbuy_${u.id}`);
      const owned = !!S.upgrades[u.id];
      const reqOk = u.req ? u.req(S) : true;

      if (owned){
        meta.textContent = "Purchased";
        btn.disabled = true;
        btn.textContent = "Owned";
      } else {
        meta.textContent = `Cost: ${fmt.money(u.cost)}${reqOk ? "" : " • Requirement not met"}`;
        btn.disabled = (!reqOk) || (S.cash < u.cost);
        btn.textContent = `Buy (${fmt.money(u.cost)})`;
      }
    }

    // Achievements update
    for (const a of ACHIEVEMENTS){
      const badge = $(`ach_${a.id}`);
      badge.classList.toggle("unlocked", !!S.ach[a.id]);
    }

    // Stats panel
    els.stats.innerHTML = "";
    const rows = [
      ["Clicks", fmt.int(S.stats.clicks)],
      ["Generated (lifetime)", fmt.kwh(S.stats.totalGeneratedKWh)],
      ["Curtailed (lifetime)", fmt.kwh(S.stats.totalCurtailedKWh)],
      ["Cloud events", fmt.int(S.stats.cloudEvents)],
      ["Panel multiplier", `${(S.mods.panelMult*100).toFixed(1)}%`],
      ["Inverter multiplier", `${(S.mods.inverterMult*100).toFixed(1)}%`],
      ["Revenue multiplier", `${(S.mods.revenueMult*100).toFixed(1)}%`],
      ["Storage multiplier", `${(S.mods.storageMult*100).toFixed(1)}%`],
      ["Tracker effectiveness", `${(S.mods.trackerMult*100).toFixed(1)}%`],
    ];

    for (const [k, v] of rows){
      const line = document.createElement("div");
      line.className = "mini-row";
      const a = document.createElement("span");
      a.className = "muted";
      a.textContent = k;
      const b = document.createElement("span");
      b.textContent = v;
      line.appendChild(a);
      line.appendChild(b);
      els.stats.appendChild(line);
    }

    // Motion
    document.body.classList.toggle("reduce-motion", S.reduceMotion);
    if (S.reduceMotion){
      // reduce animations by removing transitions
      els.barStorage.style.transition = "none";
      els.barDay.style.transition = "none";
    } else {
      els.barStorage.style.transition = "";
      els.barDay.style.transition = "";
    }
  }

  function getOwnedCount(id){
    switch(id){
      case "panels": return S.hardware.panels;
      case "inverters": return S.hardware.inverters;
      case "trackers": return S.hardware.trackers;
      case "batteries": return S.hardware.batteries;
      default: return 0;
    }
  }

  function dayLabel(phase){
    // 0 midnight, 0.25 morning, 0.5 noon, 0.75 evening
    if (phase < 0.08 || phase > 0.92) return "Night";
    if (phase < 0.25) return "Dawn";
    if (phase < 0.45) return "Morning";
    if (phase < 0.55) return "Noon";
    if (phase < 0.75) return "Afternoon";
    if (phase < 0.92) return "Dusk";
    return "Night";
  }

  // ---------- Save/Load ----------
  function sanitizeLoadedState(s){
    // Minimal defensive merging
    const base = defaultState();
    if (!s || typeof s !== "object") return base;

    const merged = { ...base, ...s };
    merged.hardware = { ...base.hardware, ...(s.hardware || {}) };
    merged.mods = { ...base.mods, ...(s.mods || {}) };
    merged.stats = { ...base.stats, ...(s.stats || {}) };
    merged.cloud = { ...base.cloud, ...(s.cloud || {}) };
    merged.upgrades = { ...(s.upgrades || {}) };
    merged.ach = { ...(s.ach || {}) };

    // Normalize toggles
    merged.autosell = !!merged.autosell;
    merged.reduceMotion = !!merged.reduceMotion;

    // Ensure numbers
    merged.cash = +merged.cash || 0;
    merged.energyKWh = +merged.energyKWh || 0;
    merged.lifetimeSoldKWh = +merged.lifetimeSoldKWh || 0;
    merged.lifetimeRevenue = +merged.lifetimeRevenue || 0;

    merged.dayPhase = clamp(+merged.dayPhase || 0, 0, 1);
    merged.t = +merged.t || now();

    // Re-apply upgrade effects (because code may change)
    merged.mods = { ...base.mods };
    for (const u of UPGRADE_DEFS){
      if (merged.upgrades[u.id]){
        u.apply(merged);
      }
    }

    // If cloud event was active but expired while away, clear it
    if (merged.cloud.active && now() >= merged.cloud.endsAt){
      merged.cloud.active = false;
      merged.cloud.factor = 1.0;
    }

    return merged;
  }

  function save(){
    S.t = now();
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(S));
      setEventLine("Saved.");
    } catch {
      setEventLine("Save failed (storage blocked?). Use Export as backup.");
    }
  }

  function loadOrInit(){
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw){
      const s = defaultState();
      s.stats.lastTickAt = now();
      return s;
    }
    const parsed = safeParseJSON(raw);
    const s = sanitizeLoadedState(parsed);
    applyOfflineProgress(s);
    s.stats.lastTickAt = now();
    return s;
  }

  function applyOfflineProgress(s){
    const last = s.t || s.stats?.lastTickAt || now();
    const deltaSec = Math.max(0, (now() - last) / 1000);
    const capped = Math.min(deltaSec, ECON.offlineCapSec);

    if (capped < 2) return;

    // Simulate in coarse steps (5s) for speed
    const step = 5;
    let remaining = capped;
    let earned = 0;
    let sold = 0;
    let curtailed = 0;

    while (remaining > 0){
      const dt = Math.min(step, remaining);

      // move day phase
      s.dayPhase = (s.dayPhase + dt / ECON.dayLengthSec) % 1;

      // No random clouds in offline; approximate with mild average derate
      const sf = clamp((Math.sin(Math.PI * s.dayPhase) > 0 ? Math.pow(Math.sin(Math.PI * s.dayPhase), 1.55) : 0) + trackerSunBonus(s), 0, 1.25);
      const sfDerated = sf * 0.92; // average weather derate

      const genKW = s.hardware.panels * HW.panelKW * sfDerated * s.mods.panelMult;
      const genKWh = genKW * (dt / 3600);

      const cap = Math.max(storageCapKWh(s), 5);
      const before = s.energyKWh;
      s.energyKWh = clamp(s.energyKWh + genKWh, 0, cap);
      const cur = (before + genKWh) - s.energyKWh;
      if (cur > 1e-9){
        curtailed += cur;
        s.stats.totalCurtailedKWh += cur;
      }

      earned += genKWh;
      s.stats.totalGeneratedKWh += genKWh;

      // sell
      if (s.autosell){
        const sellCap = inverterSellCapKW(s) * (dt / 3600);
        const kwhSold = Math.min(s.energyKWh, sellCap);
        s.energyKWh -= kwhSold;

        const rev = kwhSold * ECON.ppaPrice * s.mods.revenueMult;
        s.cash += rev;
        s.lifetimeSoldKWh += kwhSold;
        s.lifetimeRevenue += rev;
        sold += kwhSold;
      }

      remaining -= dt;
    }

    setEventLine(`Welcome back! Offline: +${fmt.kwh(earned)} generated, ${fmt.kwh(sold)} sold, ${fmt.kwh(curtailed)} curtailed.`);
  }

  function hardReset(){
    localStorage.removeItem(SAVE_KEY);
    S = defaultState();
    render();
    setEventLine("Reset complete.");
  }

  // ---------- Import/Export ----------
  function exportSave(){
    const payload = encodeSave({ ...S, t: now() });
    const wrap = document.createElement("div");
    wrap.innerHTML = `
      <p class="muted">Copy this code somewhere safe. You can import it later.</p>
    `;
    const ta = document.createElement("textarea");
    ta.value = payload;
    wrap.appendChild(ta);

    const btnRow = document.createElement("div");
    btnRow.style.display = "flex";
    btnRow.style.gap = "10px";
    btnRow.style.marginTop = "10px";

    const copyBtn = document.createElement("button");
    copyBtn.className = "btn primary";
    copyBtn.textContent = "Copy to clipboard";
    copyBtn.onclick = async () => {
      try{
        await navigator.clipboard.writeText(payload);
        setEventLine("Export copied to clipboard.");
      }catch{
        setEventLine("Could not access clipboard. Copy manually.");
      }
    };

    const closeBtn = document.createElement("button");
    closeBtn.className = "btn";
    closeBtn.textContent = "Close";
    closeBtn.onclick = closeModal;

    btnRow.appendChild(copyBtn);
    btnRow.appendChild(closeBtn);
    wrap.appendChild(btnRow);

    openModal("Export Save", wrap);
    ta.focus();
    ta.select();
  }

  function importSave(){
    const wrap = document.createElement("div");
    wrap.innerHTML = `
      <p class="muted">Paste an export code below. This will overwrite your current save.</p>
    `;
    const ta = document.createElement("textarea");
    ta.placeholder = "Paste export code here…";
    wrap.appendChild(ta);

    const btnRow = document.createElement("div");
    btnRow.style.display = "flex";
    btnRow.style.gap = "10px";
    btnRow.style.marginTop = "10px";

    const doBtn = document.createElement("button");
    doBtn.className = "btn primary";
    doBtn.textContent = "Import";
    doBtn.onclick = () => {
      const obj = decodeSave(ta.value);
      if (!obj){
        setEventLine("Import failed. Invalid code.");
        return;
      }
      S = sanitizeLoadedState(obj);
      S.stats.lastTickAt = now();
      save();
      render();
      closeModal();
      setEventLine("Import successful.");
    };

    const closeBtn = document.createElement("button");
    closeBtn.className = "btn";
    closeBtn.textContent = "Cancel";
    closeBtn.onclick = closeModal;

    btnRow.appendChild(doBtn);
    btnRow.appendChild(closeBtn);
    wrap.appendChild(btnRow);

    openModal("Import Save", wrap);
    ta.focus();
  }

  // ---------- Events / Wiring ----------
  els.btnClick.addEventListener("click", doClick);

  els.toggleAutosell.addEventListener("change", (e) => {
    S.autosell = !!e.target.checked;
    render();
    saveSoon();
  });
  els.toggleReduceMotion.addEventListener("change", (e) => {
    S.reduceMotion = !!e.target.checked;
    render();
    saveSoon();
  });

  els.btnSave.addEventListener("click", () => save());
  els.btnExport.addEventListener("click", exportSave);
  els.btnImport.addEventListener("click", importSave);
  els.btnReset.addEventListener("click", () => {
    const ok = confirm("Reset your save? This cannot be undone.");
    if (ok) hardReset();
  });

  els.modalClose.addEventListener("click", closeModal);
  els.modal.addEventListener("click", (e) => {
    if (e.target === els.modal) closeModal();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });

  // ---------- Main Loop ----------
  let last = performance.now();
  let accSave = 0;
  let saveQueued = false;

  function saveSoon(){
    saveQueued = true;
  }

  function loop(ts){
    const dt = Math.min(0.25, (ts - last) / 1000); // cap dt for stability
    last = ts;

    tick(dt);

    // autosave every ~15s or if queued
    accSave += dt;
    if (accSave > 15 || saveQueued){
      saveQueued = false;
      accSave = 0;
      // silent save (no spam)
      S.t = now();
      try { localStorage.setItem(SAVE_KEY, JSON.stringify(S)); } catch {}
    }

    render();
    requestAnimationFrame(loop);
  }

  // Initial UI state
  els.toggleAutosell.checked = !!S.autosell;
  els.toggleReduceMotion.checked = !!S.reduceMotion;
  render();
  setEventLine("Click to generate energy, then buy your first panel!");

  // Start
  requestAnimationFrame(loop);

  // Save on tab close
  window.addEventListener("beforeunload", () => {
    try{
      S.t = now();
      localStorage.setItem(SAVE_KEY, JSON.stringify(S));
    }catch{}
  });

})();
