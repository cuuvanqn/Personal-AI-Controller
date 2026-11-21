import pkg from "../../package.json";

/**
 * Phiên bản duy nhất của Otter — đọc trực tiếp từ root package.json.
 * Chỉ cần sửa "version" trong package.json là toàn bộ daemon, server, web và extension tự cập nhật.
 */
export const OTTER_VERSION: string = pkg.version;
