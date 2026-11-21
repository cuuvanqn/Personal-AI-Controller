/** License server công khai của Otter — nguồn dữ liệu phiên bản/cập nhật. */
export const LICENSE_API =
  (import.meta.env.VITE_LICENSE_API as string | undefined) || "https://license.gpt.io.vn";

export interface VersionRecord {
  component: string;
  version: string;
  min_supported_version?: string | null;
  download_url?: string | null;
  changelog?: string | null;
  release_date?: string | null;
  sha256?: string | null;
}

export async function fetchVersions(): Promise<VersionRecord[]> {
  const res = await fetch(`${LICENSE_API}/api/versions`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const versions: VersionRecord[] = Array.isArray(data?.versions) ? data.versions : [];
  // Mới nhất trước: sắp theo release_date giảm dần, thiếu ngày thì xuống cuối.
  return versions.sort((a, b) => {
    const ta = a.release_date ? Date.parse(a.release_date) : 0;
    const tb = b.release_date ? Date.parse(b.release_date) : 0;
    return tb - ta;
  });
}

export const COMPONENT_LABELS: Record<string, string> = {
  daemon: "Otter Daemon",
  extension: "Tiện ích Chrome (tùy chọn)",
  app: "Ứng dụng Otter",
};

export function componentLabel(component: string): string {
  return COMPONENT_LABELS[component] || component;
}
