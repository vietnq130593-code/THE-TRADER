/**
 * tests/market-rules.test.ts — Task 144-P1 Tier 1 (docs/SECURITY.md §5).
 *
 * Unit test CỔNG LUẬT VI MÔ src/lib/exec/market-rules.ts — đường TIỀN đi
 * qua: execRuleFor / isForeignMarket / isTradableSandboxInstrument /
 * execUnitLabel / foreignPriceUnitValueVND (toàn bộ hàm thuần — KHÔNG đụng
 * DB; db import lazy theo PrismaClient constructor). Chính sách VN-only
 * #108 (COUNCIL_STEWARDSHIP_BLUEPRINT v2.2 §5) là trọng tâm nghiệm thu.
 */
import { describe, test, expect } from "bun:test";
import {
  execRuleFor,
  isForeignMarket,
  isTradableSandboxInstrument,
  execUnitLabel,
  foreignPriceUnitValueVND,
  NOTIONAL_UNIT_VND,
  HKD_USD_PEG,
  MIN_QTY,
  BOND_DURATION,
  type InstrumentLite,
} from "@/lib/exec/market-rules";

/** instrument HOSE điển hình (FPT — cp thật, luật lot 100). */
const hoseStock: InstrumentLite = { symbol: "FPT", market: "HOSE", type: "STOCK" };
const hnxStock: InstrumentLite = { symbol: "SHB", market: "HNX", type: "STOCK" };
const upcomStock: InstrumentLite = { symbol: "BSR", market: "UPCOM", type: "STOCK" };
const hoseEtf: InstrumentLite = { symbol: "FUEVFVND", market: "HOSE", type: "ETF" };
/** INDEX trên HOSE (VNINDEX) — #108: INDEX LUÔN null kể cả sàn VN. */
const hoseIndex: InstrumentLite = { symbol: "VNINDEX", market: "HOSE", type: "INDEX" };
const usStock: InstrumentLite = { symbol: "AAPL", market: "US", type: "STOCK" };
const hkStock: InstrumentLite = { symbol: "0700.HK", market: "HK", type: "STOCK" };
const usBond: InstrumentLite = { symbol: "US10Y", market: "BOND", type: "BOND" };
const forex: InstrumentLite = { symbol: "EURUSD=X", market: "FOREX", type: "FX" };
const vndUsd: InstrumentLite = { symbol: "VND=X", market: "FOREX", type: "FX" };
const commodity: InstrumentLite = { symbol: "GC=F", market: "COMMODITY", type: "CMDTY" };

describe("hằng số mô hình (bộ định giá VND)", () => {
  test("NOTIONAL_UNIT_VND = 1.000.000₫/đv danh nghĩa", () => {
    expect(NOTIONAL_UNIT_VND).toBe(1_000_000);
  });
  test("HKD_USD_PEG = 7,8 (peg cố định — chỉ định giá lịch sử)", () => {
    expect(HKD_USD_PEG).toBe(7.8);
  });
  test("MIN_QTY chỉ còn VN lot 100 (chính sách #108 v2.2)", () => {
    expect(MIN_QTY.VN).toBe(100);
    expect(Object.keys(MIN_QTY)).toEqual(["VN"]);
  });
  test("BOND_DURATION theo tenor (US5Y 4,5 · US10Y 8 · US30Y 17)", () => {
    expect(BOND_DURATION["US5Y"]).toBe(4.5);
    expect(BOND_DURATION["US10Y"]).toBe(8);
    expect(BOND_DURATION["US30Y"]).toBe(17);
  });
});

describe("isForeignMarket", () => {
  test("US/HK/BOND/FOREX/COMMODITY là thị trường phi-VN", () => {
    expect(isForeignMarket("US")).toBe(true);
    expect(isForeignMarket("HK")).toBe(true);
    expect(isForeignMarket("BOND")).toBe(true);
    expect(isForeignMarket("FOREX")).toBe(true);
    expect(isForeignMarket("COMMODITY")).toBe(true);
  });
  test("HOSE/HNX/UPCOM không phải thị trường phi-VN", () => {
    expect(isForeignMarket("HOSE")).toBe(false);
    expect(isForeignMarket("HNX")).toBe(false);
    expect(isForeignMarket("UPCOM")).toBe(false);
  });
  test("market lạ/rỗng không tính là phi-VN (chỉ 5 hằng số là foreign)", () => {
    expect(isForeignMarket("")).toBe(false);
    expect(isForeignMarket("XYZ")).toBe(false);
  });
});

describe("execRuleFor — chính sách VN-only #108 v2.2", () => {
  test("HOSE/HNX/UPCOM (STOCK) → RULE_VN: lotStep 100 · feeRate 0,0015 · hasBand true", () => {
    for (const inst of [hoseStock, hnxStock, upcomStock]) {
      const rule = execRuleFor(inst);
      expect(rule).not.toBeNull();
      expect(rule!.sessionKind).toBe("VN");
      expect(rule!.assetKind).toBe("VN_PRICE");
      expect(rule!.lotStep).toBe(100);
      expect(rule!.minQty).toBe(100);
      expect(rule!.feeRate).toBe(0.0015);
      expect(rule!.hasBand).toBe(true);
    }
  });
  test("ETF HOSE cũng là VN_PRICE (ETF trong nước giao dịch lot 100)", () => {
    const rule = execRuleFor(hoseEtf);
    expect(rule).not.toBeNull();
    expect(rule!.lotStep).toBe(100);
  });
  test("INDEX → null KỂ CẢ trên HOSE (VNINDEX/VN30 chỉ tham chiếu)", () => {
    expect(execRuleFor(hoseIndex)).toBeNull();
    expect(execRuleFor({ symbol: "HNXINDEX", market: "HNX", type: "INDEX" })).toBeNull();
  });
  test("US/HK/BOND/FOREX/COMMODITY → null (tham chiếu, không đầu tư)", () => {
    expect(execRuleFor(usStock)).toBeNull();
    expect(execRuleFor(hkStock)).toBeNull();
    expect(execRuleFor(usBond)).toBeNull();
    expect(execRuleFor(forex)).toBeNull();
    expect(execRuleFor(vndUsd)).toBeNull();
    expect(execRuleFor(commodity)).toBeNull();
  });
  test("market lạ → null (default switch — không bịa luật)", () => {
    expect(execRuleFor({ symbol: "X", market: "TOKYO", type: "STOCK" })).toBeNull();
  });
  test("type INDEX thắng cả market hợp lệ (check order: type trước market)", () => {
    // INDEX US cũng null — nhưng quan trọng: INDEX lọt qua nhánh type trước khi
    // switch market nên HOSE INDEX null là chính sách, không phải quên thêm case.
    expect(execRuleFor({ symbol: "SPX", market: "US", type: "INDEX" })).toBeNull();
  });
});

describe("isTradableSandboxInstrument (map prompt sinh tín hiệu)", () => {
  test("đúng instrument HOSE/HNX/UPCOM → true", () => {
    expect(isTradableSandboxInstrument(hoseStock)).toBe(true);
    expect(isTradableSandboxInstrument(hnxStock)).toBe(true);
    expect(isTradableSandboxInstrument(upcomStock)).toBe(true);
    expect(isTradableSandboxInstrument(hoseEtf)).toBe(true);
  });
  test("INDEX + mọi mã phi-VN → false (tự loại khỏi map tín hiệu)", () => {
    expect(isTradableSandboxInstrument(hoseIndex)).toBe(false);
    expect(isTradableSandboxInstrument(usStock)).toBe(false);
    expect(isTradableSandboxInstrument(hkStock)).toBe(false);
    expect(isTradableSandboxInstrument(usBond)).toBe(false);
    expect(isTradableSandboxInstrument(forex)).toBe(false);
    expect(isTradableSandboxInstrument(commodity)).toBe(false);
  });
});

describe("execUnitLabel — nhãn đơn vị cho UI + prompt", () => {
  test("VN (HOSE/HNX/UPCOM) → \"cp\"", () => {
    expect(execUnitLabel(hoseStock)).toBe("cp");
    expect(execUnitLabel(hnxStock)).toBe("cp");
    expect(execUnitLabel(upcomStock)).toBe("cp");
    expect(execUnitLabel(hoseEtf)).toBe("cp");
  });
  test("BOND/COMMODITY → \"đv danh nghĩa 1tr₫\"", () => {
    expect(execUnitLabel(usBond)).toBe("đv danh nghĩa 1tr₫");
    expect(execUnitLabel(commodity)).toBe("đv danh nghĩa 1tr₫");
  });
  test("FOREX → \"đv tiền gốc\"", () => {
    expect(execUnitLabel(forex)).toBe("đv tiền gốc");
    expect(execUnitLabel(vndUsd)).toBe("đv tiền gốc");
  });
  test("US/HK stock → \"đv (0,01 cp)\"", () => {
    expect(execUnitLabel(usStock)).toBe("đv (0,01 cp)");
    expect(execUnitLabel(hkStock)).toBe("đv (0,01 cp)");
  });
});

describe("foreignPriceUnitValueVND — giá trị VND của 1 đv lệnh tài sản GIÁ", () => {
  test("US:STOCK — giá cents USD, 1 đv = 0,01 cp → (p/100)×fx/100", () => {
    // AAPL $100 (10.000 cents) · fx 25.000 → 0,01 cp = $1 = 25.000₫
    expect(foreignPriceUnitValueVND(usStock, 10_000, 25_000)).toBe(25_000);
  });
  test("US thiếu fx → null (không bịa tỷ giá)", () => {
    expect(foreignPriceUnitValueVND(usStock, 10_000, null)).toBeNull();
  });
  test("HK:STOCK — cents HKD qua peg 7,8: HK$780 (78.000 cents) → $100 → 25.000₫", () => {
    expect(foreignPriceUnitValueVND(hkStock, 78_000, 25_000)).toBe(25_000);
  });
  test("HK thiếu fx → null", () => {
    expect(foreignPriceUnitValueVND(hkStock, 78_000, null)).toBeNull();
  });
  test("FOREX VND=X — price×10⁴ = VND/USD, KHÔNG cần fx", () => {
    // 250.000.000 raw / 10⁴ = 25.000 VND/USD
    expect(foreignPriceUnitValueVND(vndUsd, 250_000_000, null)).toBe(25_000);
    expect(foreignPriceUnitValueVND(vndUsd, 250_000_000, 1)).toBe(25_000); // fx bị bỏ qua
  });
  test("FOREX khác — price×10⁴ = USD/đv gốc → ×fx (EURUSD 1,08 → $10.800 × ...)", () => {
    // 108.000 raw / 10⁴ = 10,8 USD/đv? theo comment: (price/10⁴)×fx = 10,8×2.500 = 27.000
    expect(foreignPriceUnitValueVND(forex, 108_000, 2_500)).toBe(27_000);
  });
  test("FOREX khác thiếu fx → null", () => {
    expect(foreignPriceUnitValueVND(forex, 108_000, null)).toBeNull();
  });
  test("price ≤ 0 → null (không định giá giá rác)", () => {
    expect(foreignPriceUnitValueVND(usStock, 0, 25_000)).toBeNull();
    expect(foreignPriceUnitValueVND(forex, -5, 25_000)).toBeNull();
  });
  test("BOND/COMMODITY → null (tài sản danh nghĩa đi nhánh idx riêng)", () => {
    expect(foreignPriceUnitValueVND(usBond, 4_500, 25_000)).toBeNull();
    expect(foreignPriceUnitValueVND(commodity, 2_000, 25_000)).toBeNull();
  });
});
