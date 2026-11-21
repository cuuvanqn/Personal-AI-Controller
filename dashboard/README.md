# Otter Dashboard (React + Astryx)

Giao diện quản lý của Otter daemon tại `/dashboard`, viết bằng React 19 + Astryx
(design system của Meta). Thay cho Dashboard HTML inline cũ trong
`src/daemon/routes/system-routes.ts` (bản cũ vẫn giữ làm dự phòng khi chưa có bản build).

## Tính năng

- **Tổng quan**: trạng thái daemon, bản quyền, mã thiết bị, bật/tắt Full Access.
- **Kết nối từ xa**: Cloudflare Quick Tunnel (bật/dừng/sao chép), Tailscale (sao chép URL/MCP).
- **Nhóm MCP Tools**: bật/tắt 16 nhóm + preset (Tất cả/Tối thiểu/Chỉ Code/Chỉ Facebook),
  tổng số tool và ước lượng token schema — áp dụng ngay qua `/api/tool-groups`.
- **Cập nhật Daemon**: trạng thái, kiểm tra, cập nhật ngay qua `/api/update/*`.
- **AI đã kết nối (OAuth)**: danh sách client + thu hồi qua `/api/oauth/*`.
- **Điểm cuối kết nối**: MCP/SSE/WebSocket + OpenAPI.

Xác thực: mạng tin cậy (localhost/LAN/Tailscale) không cần token khi chưa đặt
`OTTER_API_KEY`; truy cập từ Internet cần token — Dashboard nhận qua `?token=`
trên URL hoặc ô nhập token khi API trả 401.

## Build & triển khai

```bash
npm install
npm run build            # xuất vào dist/ (base /dashboard/)
cp -r dist/* ../deploy/dashboard/
```

Daemon phục vụ `deploy/dashboard/index.html` tại `/dashboard` và file tĩnh tại
`/dashboard/assets/*`. Nếu thư mục chưa có bản build, daemon tự dùng lại
Dashboard HTML inline cũ — không vỡ tương thích.

## Kiểm tra giao diện

```bash
npx playwright install chromium   # một lần
# chạy daemon rồi chụp:
node scripts/shot.mjs http://127.0.0.1:1993/dashboard /tmp/shot.png 1440
```
