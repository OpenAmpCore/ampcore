// Static reference data for the builtin CVR amp catalogue — deliberately
// NOT round-tripped through Rust (see src-tauri/src/data/store.rs for the
// simple id/brand/model/channelCount entries that actually drive assignment
// logic). This is display-only data, keyed by model name.
//
// Only a prioritized subset of the full datasheet is modeled here (wattage
// @ 8/4/2Ω stereo + 8Ω bridge, gain, size, weight) — THD/IMD/DIM/crosstalk/
// damping factor/SNR/protections/power-input are intentionally omitted.
//
// Size/weight assumption: the source datasheet only gave two chassis
// size/weight pairs for all 12 models. The first six (lower power tier) are
// mapped to the smaller chassis, the last six to the larger one, matching
// the datasheet's own column order. Correct per-model if exact data exists.
export interface AmpSpecSheet {
  watts8ohm: number;
  watts4ohm: number;
  watts2ohm: number;
  wattsBridge8ohm: number;
  defaultGainDb: number;
  gainRangeDb: [number, number];
  sizeWxHxDmm: string;
  weightKg: number;
}

const CVR_SPEC_SHEETS: Record<string, AmpSpecSheet> = {
  "DSP-654": {
    watts8ohm: 650,
    watts4ohm: 1100,
    watts2ohm: 1870,
    wattsBridge8ohm: 2200,
    defaultGainDb: 19,
    gainRangeDb: [19, 37],
    sizeWxHxDmm: "483x45x376mm",
    weightKg: 9,
  },
  "DSP-802": {
    watts8ohm: 800,
    watts4ohm: 1360,
    watts2ohm: 2310,
    wattsBridge8ohm: 2720,
    defaultGainDb: 19,
    gainRangeDb: [19, 37],
    sizeWxHxDmm: "483x45x376mm",
    weightKg: 9,
  },
  "DSP-1002": {
    watts8ohm: 1000,
    watts4ohm: 1700,
    watts2ohm: 2890,
    wattsBridge8ohm: 3400,
    defaultGainDb: 21,
    gainRangeDb: [21, 39],
    sizeWxHxDmm: "483x45x376mm",
    weightKg: 9,
  },
  "DSP-1004": {
    watts8ohm: 1000,
    watts4ohm: 1700,
    watts2ohm: 2890,
    wattsBridge8ohm: 3400,
    defaultGainDb: 21,
    gainRangeDb: [21, 39],
    sizeWxHxDmm: "483x45x376mm",
    weightKg: 9,
  },
  "DSP-1502": {
    watts8ohm: 1500,
    watts4ohm: 2550,
    watts2ohm: 3570,
    wattsBridge8ohm: 5100,
    defaultGainDb: 23,
    gainRangeDb: [23, 41],
    sizeWxHxDmm: "483x45x376mm",
    weightKg: 9,
  },
  "DSP-2002": {
    watts8ohm: 2000,
    watts4ohm: 3400,
    watts2ohm: 4760,
    wattsBridge8ohm: 6800,
    defaultGainDb: 24,
    gainRangeDb: [24, 42],
    sizeWxHxDmm: "483x45x376mm",
    weightKg: 9,
  },
  "DSP-1504": {
    watts8ohm: 1500,
    watts4ohm: 2550,
    watts2ohm: 3570,
    wattsBridge8ohm: 5100,
    defaultGainDb: 23,
    gainRangeDb: [23, 41],
    sizeWxHxDmm: "483x45x465mm",
    weightKg: 13,
  },
  "DSP-2004": {
    watts8ohm: 2000,
    watts4ohm: 3400,
    watts2ohm: 4760,
    wattsBridge8ohm: 6800,
    defaultGainDb: 24,
    gainRangeDb: [24, 42],
    sizeWxHxDmm: "483x45x465mm",
    weightKg: 13,
  },
  "DSP-3002": {
    watts8ohm: 3000,
    watts4ohm: 5100,
    watts2ohm: 7140,
    wattsBridge8ohm: 10200,
    defaultGainDb: 25,
    gainRangeDb: [25, 43],
    sizeWxHxDmm: "483x45x465mm",
    weightKg: 13,
  },
  "DSP-3004": {
    watts8ohm: 3000,
    watts4ohm: 5100,
    watts2ohm: 8600,
    wattsBridge8ohm: 10200,
    defaultGainDb: 25,
    gainRangeDb: [25, 43],
    sizeWxHxDmm: "483x45x465mm",
    weightKg: 13,
  },
  "DSP-3302": {
    watts8ohm: 3300,
    watts4ohm: 5600,
    watts2ohm: 9530,
    wattsBridge8ohm: 11200,
    defaultGainDb: 25,
    gainRangeDb: [25, 43],
    sizeWxHxDmm: "483x45x465mm",
    weightKg: 13,
  },
  "DSP-4302": {
    watts8ohm: 4300,
    watts4ohm: 7300,
    watts2ohm: 12400,
    wattsBridge8ohm: 14600,
    defaultGainDb: 27,
    gainRangeDb: [27, 45],
    sizeWxHxDmm: "483x45x465mm",
    weightKg: 13,
  },
};

// Dante-networked counterparts share the same underlying spec sheet as their
// non-networked equivalent — same amp, same power section, just a "D"
// suffix on the model name to distinguish the network-connected variant.
const CVR_DANTE_SPEC_SHEETS: Record<string, AmpSpecSheet> = Object.fromEntries(
  Object.entries(CVR_SPEC_SHEETS).map(([model, spec]) => [`${model}D`, spec]),
);

// One entry per onboarded brand — add a new brand's spec table here, scoped
// under its own key, when it's added to the catalog. Scoping by brand (not
// one flat cross-brand map) avoids a different brand's model name silently
// colliding with a CVR key string.
const SPEC_SHEETS_BY_BRAND: Record<string, Record<string, AmpSpecSheet>> = {
  CVR: { ...CVR_SPEC_SHEETS, ...CVR_DANTE_SPEC_SHEETS },
};

export function getAmpSpecSheet(entry: { brand: string; model: string }): AmpSpecSheet | undefined {
  return SPEC_SHEETS_BY_BRAND[entry.brand]?.[entry.model];
}
