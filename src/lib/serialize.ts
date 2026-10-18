/**
 * BigInt values are not JSON-serializable (Prisma Postgres uses BigInt for
 * VND money columns). Recursively convert any BigInt to Number before
 * passing payloads to NextResponse.json().
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * F-114 (audit 19-b): thêm guard circular reference (WeakSet) + chuyển
 * Map/Set thành plain object/array — tránh RangeError "Maximum call stack"
 * khi serialize object tự tham chiếu hoặc payload chứa Map/Set.
 */
export function toPlain<T>(value: T, seen: WeakSet<object> = new WeakSet()): any {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return value.toISOString();
  // Guard circular ở ĐẦU hàm — áp cho mọi object (kể cả mảng/Map/Set)
  if (typeof value === "object" && value !== null) {
    if (seen.has(value as object)) return "[Circular]";
    seen.add(value as object);
    try {
      if (value instanceof Map) return toPlain(Object.fromEntries(value), seen);
      if (value instanceof Set) return toPlain(Array.from(value), seen);
      if (Array.isArray(value)) return value.map((v) => toPlain(v, seen));
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = toPlain(v, seen);
      }
      return out;
    } finally {
      // AUDIT 137 D2 — "seen" nay là NGĂN XẾP ĐƯỜNG ĐI (path-based), không còn
      // visited-set toàn cục: xoá khỏi stack sau khi xử lý xong nhánh → object
      // DÙNG CHUNG (DAG — config chuẩn hoá, hằng số, mảng rỗng singleton) được
      // serialize ĐÚNG ở mọi occurrence thay vì bị thay "[Circular]" ở lần thứ
      // 2. Chu kỳ THẬT (tổ tiên đang mở trên đường đệ quy) vẫn còn trong stack
      // → vẫn bắt "[Circular]" như F-114. WeakSet tạo qua tham số mặc định của
      // MỖI lời gọi toPlain gốc (không dùng biến module-level — mỗi payload một
      // stack riêng, tránh rò stack giữa các request). try/finally đảm bảo xoá
      // dù đệ quy con ném exception.
      seen.delete(value as object);
    }
  }
  return value;
}
