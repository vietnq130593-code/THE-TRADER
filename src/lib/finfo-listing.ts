/**
 * src/lib/finfo-listing.ts — DANH SÁCH TOÀN SÀN từ finfo v4 (UNIVERSE_TIERING §2).
 *
 * Phát hiện đo 2026-10-24: `api-finfo.vndirect.com.vn` resolve + 200 OK từ
 * sandbox (Task 181 probe sai cửa `finfo.vn` — bị chặn — còn api-finfo cùng
 * nhà dchart thì sống). Đây là endpoint danh-sách-toàn-sàn ĐÃ XÁC MINH thay
 * cho kết luận "không có" của Task 186; đồng thời mở cửa cho F-03b/F-02 Pha B
 * (để dành task sau — chỉ listing trong phạm vi tiering).
 *
 * Khác FINFO_BASE (finfo-api — quote realtime lastprice, vndirect.ts): host
 * api-finfo phục vụ truy vấn danh mục REST GET /v4/stocks?q=…&page=…&size=…
 *
 * Q-syntax đã verify: `floor:HOSE~status:LISTED~type:STOCK` (dấu ~ = AND).
 * Trả { data, currentPage, size, totalElements, totalPages } — size=0 bị
 * chối ("scroll context") nên luôn dùng size ≥ 1.
 */

export const FINFO_LISTING_BASE =
  process.env.FINFO_LISTING_BASE_URL ?? "https://api-finfo.vndirect.com.vn";

export interface FinfoStockRow {
  code: string;
  floor: string;
  type: string;
  shortName?: string | null;
  companyName?: string | null;
  listedDate?: string | null;
}

interface FinfoListingResponse {
  data: FinfoStockRow[];
  currentPage: number;
  size: number;
  totalElements: number;
  totalPages: number;
}

const PAGE_SIZE = 100;
const PAGE_TIMEOUT_MS = 20_000;
/** Lịch sự với nguồn công cộng — giống throttle dchart 300ms. */
const PAGE_GAP_MS = 300;

/** Tải TOÀN BỘ trang của một truy vấn finfo (đệ quy phân trang).
 *
 * Measured 2026-10-24: finfo chỉ trả {totalPages, totalElements} ở trang 1 —
 * trang 2+ trả null/undefined cả hai (đã curl đối chứng page=1,2,3) → phải
 * khoá totalPages từ trang ĐẦU và dừng theo (i) hết trang hoặc (ii) trang
 * trả 0 dòng. Trước fix, mọi query dừng sau trang 2 (200 dòng) — mất ~950 mã.
 */
export async function fetchFinfoListing(q: string): Promise<FinfoStockRow[]> {
  const out: FinfoStockRow[] = [];
  let page = 1;
  let totalPages: number | null = null;
  for (;;) {
    const url =
      `${FINFO_LISTING_BASE}/v4/stocks?q=${encodeURIComponent(q)}` +
      `&page=${page}&size=${PAGE_SIZE}` +
      `&_fields=code,floor,type,shortName,companyName,listedDate,status`;
    let attempt = 0;
    let body: FinfoListingResponse | null = null;
    for (;;) {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
        headers: { accept: "application/json" },
      }).catch(() => null as null);
      if (res && res.ok) {
        const parsed = (await res.json().catch(() => null)) as FinfoListingResponse | null;
        if (parsed && Array.isArray(parsed.data)) {
          body = parsed;
          break;
        }
      }
      if (attempt >= 2) {
        throw new Error(
          `finfo listing '${q}' trang ${page} lỗi sau ${attempt + 1} lần thử ` +
            `(HTTP ${res ? res.status : "network"})`
        );
      }
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      attempt++;
    }
    if (page === 1) {
      totalPages =
        body.totalPages ?? Math.ceil((body.totalElements ?? body.data.length) / PAGE_SIZE);
    }
    if (body.data.length === 0) break; // hết dữ liệu thật — thoát an toàn
    out.push(...body.data);
    if (totalPages !== null && page >= totalPages) break;
    page++;
    await new Promise((r) => setTimeout(r, PAGE_GAP_MS));
  }
  return out;
}
