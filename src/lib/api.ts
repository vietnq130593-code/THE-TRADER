/** Tiny client-side fetch helpers (relative URLs only). */

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Không tải được dữ liệu (${res.status})`);
  }
  return (await res.json()) as T;
}

export async function apiPost<T>(path: string): Promise<T> {
  const res = await fetch(path, { method: "POST" });
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) {
    throw new Error(body?.error ?? `Yêu cầu thất bại (${res.status})`);
  }
  return body as T;
}

/** POST với JSON body (watchlist toggle, news ingest, …). */
export async function apiPostJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || data == null) {
    throw new Error(data?.error ?? `Yêu cầu thất bại (${res.status})`);
  }
  return data;
}

/** PATCH với JSON body — K3 #94 (sửa/tạm dừng/tiếp tục nhiệm vụ định kỳ). */
export async function apiPatchJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || data == null) {
    throw new Error(data?.error ?? `Yêu cầu thất bại (${res.status})`);
  }
  return data;
}

/** DELETE — K3 #94 (xoá nhiệm vụ). */
export async function apiDelete<T>(path: string): Promise<T> {
  const res = await fetch(path, { method: "DELETE" });
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || data == null) {
    throw new Error(data?.error ?? `Yêu cầu thất bại (${res.status})`);
  }
  return data;
}

