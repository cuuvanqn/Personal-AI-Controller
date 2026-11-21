# Otter Web — Landing Page App

Trang giới thiệu Otter dạng ứng dụng React 19 + Astryx (design system của Meta),
thay cho `landing-page.html` tĩnh trước đây.

## Tính năng

- **Trang chủ**: giới thiệu Otter, bảng nhóm MCP tools, cách hoạt động, cài đặt 1 lệnh
  (chọn Windows/macOS/Linux), so sánh, FAQ.
- **Đăng nhập**: Firebase Authentication (project `otter-aeccc`) — Google hoặc email/mật khẩu.
- **Thông báo & cập nhật**: lấy trực tiếp từ license server
  `GET https://license.gpt.io.vn/api/versions` (đổi bằng biến môi trường `VITE_LICENSE_API`).

## Chạy & build

```bash
npm install
npm run dev      # phát triển tại http://localhost:5173
npm run build    # xuất bản tĩnh vào dist/
```

Triển khai: phục vụ thư mục `dist/` như static site (điều hướng dùng hash `#/login`,
`#/updates` nên không cần cấu hình rewrite phía server).

## Kiểm tra giao diện

```bash
npx playwright install chromium   # một lần
npm run build && npx vite preview --port 4173 &
node scripts/shot.mjs http://127.0.0.1:4173/ /tmp/shot.png 1440
```

## Ghi chú

- Tiện ích Chrome là **tùy chọn phụ** — Otter mặc định điều khiển trình duyệt qua CDP.
- Cấu hình Firebase trong `src/firebase.ts` là web config công khai của project
  `otter-aeccc` (đã có trong landing-page.html cũ); bảo mật nằm ở Firebase Auth
  và Security Rules phía server.
