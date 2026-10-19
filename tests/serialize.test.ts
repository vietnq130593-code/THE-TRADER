/**
 * tests/serialize.test.ts — Task 144-P1 Tier 1 (docs/SECURITY.md §5).
 *
 * Unit test src/lib/serialize.ts — toPlain (BigInt VND → Number trước
 * NextResponse.json). Nghiệm thu: roundtrip serialize → JSON.parse,
 * guard circular (F-114), DAG dùng chung (AUDIT 137 D2 — "seen" là ngăn
 * xếp đường đi, object dùng chung phải serialize ĐÚNG ở mọi occurrence).
 */
import { describe, test, expect } from "bun:test";
import { toPlain } from "@/lib/serialize";

describe("toPlain — giá trị nguyên thuỷ", () => {
  test("number/string/boolean/null/undefined đi qua nguyên vẹn", () => {
    expect(toPlain(42)).toBe(42);
    expect(toPlain("hello")).toBe("hello");
    expect(toPlain(true)).toBe(true);
    expect(toPlain(false)).toBe(false);
    expect(toPlain(null)).toBeNull();
    expect(toPlain(undefined)).toBeUndefined();
  });
  test("bigint → number (tiền VND của Prisma Postgres)", () => {
    expect(toPlain(123n)).toBe(123);
    expect(toPlain(0n)).toBe(0);
    expect(toPlain(-456n)).toBe(-456);
  });
  test("Date → chuỗi ISO (chuẩn hoá qua wire)", () => {
    expect(toPlain(new Date("2026-01-05T03:00:00Z"))).toBe("2026-01-05T03:00:00.000Z");
  });
});

describe("toPlain — cấu trúc lồng nhau", () => {
  test("object lồng chứa bigint + Date biến đổi đúng từng tầng", () => {
    const out = toPlain({
      vnd: 987654321n,
      at: new Date("2026-01-05T03:00:00Z"),
      nested: { qty: 100n, label: "FPT" },
    });
    expect(out).toEqual({
      vnd: 987654321,
      at: "2026-01-05T03:00:00.000Z",
      nested: { qty: 100, label: "FPT" },
    });
  });
  test("mảng chứa bigint → mảng number", () => {
    expect(toPlain([1n, 2n, 3n])).toEqual([1, 2, 3]);
  });
  test("Map → plain object (giữ cặp key/value)", () => {
    const out = toPlain(new Map<string, unknown>([["a", 1n], ["b", 2]]));
    expect(out).toEqual({ a: 1, b: 2 });
  });
  test("Set → mảng (thứ tự chèn giữ nguyên)", () => {
    expect(toPlain(new Set([1n, 2, 3]))).toEqual([1, 2, 3]);
  });
  test("object rỗng / mảng rỗng", () => {
    expect(toPlain({})).toEqual({});
    expect(toPlain([])).toEqual([]);
  });
});

describe("toPlain — guard circular + DAG (F-114 · AUDIT 137 D2)", () => {
  test("chu kỳ THẬT → \"[Circular]\" (không RangeError stack)", () => {
    const obj: Record<string, unknown> = { name: "root" };
    obj.self = obj;
    const out = toPlain(obj) as Record<string, unknown>;
    expect(out.name).toBe("root");
    expect(out.self).toBe("[Circular]");
  });
  test("chu kỳ 2 tầng (a.b.c → a) vẫn bắt được", () => {
    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = { c: {} };
    a.b = b;
    (b.c as Record<string, unknown>).back = a;
    const out = toPlain(a) as { b: { c: { back: unknown } } };
    expect(out.b.c.back).toBe("[Circular]");
  });
  test("DAG — object DÙNG CHUNG serialize đúng ở MỌI occurrence (D2)", () => {
    const shared = { value: 10n };
    const out = toPlain({ x: shared, y: shared, list: [shared, shared] });
    // AUDIT 137 D2: trước khi vá, lần thứ 2 bị thay "[Circular]" sai
    expect(out).toEqual({
      x: { value: 10 },
      y: { value: 10 },
      list: [{ value: 10 }, { value: 10 }],
    });
  });
  test("mảng rỗng singleton dùng chung nhiều nơi vẫn là []", () => {
    const empty: unknown[] = [];
    const out = toPlain({ a: empty, b: empty });
    expect(out).toEqual({ a: [], b: [] });
  });
});

describe("toPlain — roundtrip serialize/deserialize cho NextResponse.json", () => {
  test("payload BigInt/Date/Map → JSON.stringify được → parse lại đủ số", () => {
    const payload = {
      vnd: 123456789n,
      at: new Date("2026-01-05T03:00:00Z"),
      items: [1n, 2n, 3n],
      meta: new Map<string, unknown>([["k", 99n]]),
    };
    const json = JSON.stringify(toPlain(payload));
    const back = JSON.parse(json) as {
      vnd: number;
      at: string;
      items: number[];
      meta: { k: number };
    };
    expect(back.vnd).toBe(123456789);
    expect(back.at).toBe("2026-01-05T03:00:00.000Z");
    expect(back.items).toEqual([1, 2, 3]);
    expect(back.meta.k).toBe(99);
  });
  test("không qua toPlain thì BigInt làm JSON.stringify ném TypeError", () => {
    // chứng minh nghịch — lý do tồn tại của module này
    expect(() => JSON.stringify({ vnd: 1n })).toThrow(TypeError);
  });
  test("payload lồng sâu + Mix Map/Set/Array vẫn roundtrip", () => {
    const payload = {
      rows: [
        { id: "a", mv: 1000n },
        { id: "b", mv: 2000n },
      ],
      tags: new Set(["x", "y"]),
    };
    const back = JSON.parse(JSON.stringify(toPlain(payload))) as {
      rows: { id: string; mv: number }[];
      tags: string[];
    };
    expect(back.rows).toEqual([
      { id: "a", mv: 1000 },
      { id: "b", mv: 2000 },
    ]);
    expect(back.tags).toEqual(["x", "y"]);
  });
});
