# DeeDou QR Order

Trang order QR cho cửa hàng DeeDou, dựng theo đặc tả trong PDF:

- Khách vào `#/t/<token>` để order theo bàn.
- Menu song ngữ VI/EN, chia menu lớn `Đồ ăn` và `Đồ uống`; đồ ăn có `Combo`, `Món lẻ`, `Tráng miệng`; đồ uống có `Cà phê`, `Trà`, `Đặc trưng`.
- Giỏ hàng, ghi chú, gửi order, gọi nhân viên, yêu cầu thanh toán.
- Staff board tại `#/staff` để nhận, xác nhận và cập nhật trạng thái đơn.
- Bar tại `#/bar`, bếp tại `#/kitchen`, bánh/tráng miệng tại `#/dessert` để nhận món đã được nhân viên duyệt.
- Thu ngân tại `#/cashier` để xem sơ đồ bàn theo khu vực, chọn từng bàn để xem bill/order batches, kiểm tra món đã phục vụ/chưa phục vụ, gọi món tại quầy, pre-bill, split bill, void/refund và ghi nhận thanh toán.
- Admin tại `#/admin` để thêm/sửa/xóa món ăn, đồ uống, mô tả, giá, hình ảnh, khu chế biến chi tiết, khung giờ bán, trạng thái sold out và QR riêng từng bàn.

## Chạy thử

Mở file `index.html` trực tiếp trong trình duyệt, hoặc chạy một static server bất kỳ trong thư mục này.

Các link nhanh:

- Customer: `index.html#/t/beach-a01-47VLmz`
- Cashier POS: `index.html#/cashier`
- Staff: `index.html#/staff`
- Bar: `index.html#/bar`
- Kitchen: `index.html#/kitchen`
- Dessert: `index.html#/dessert`
- Admin: `index.html#/admin`

## Luồng vận hành

1. Admin vào `#/admin` để tạo món ăn/đồ uống, tải hình từ máy hoặc nhập link ảnh, chọn nhóm menu và station chế biến.
2. Khách quét QR bàn, chọn món và gửi order.
3. Thu ngân hoặc nhân viên vào `#/cashier`/`#/staff`, kiểm tra và bấm Accept.
4. Món đã duyệt tự xuất hiện ở `#/bar`, `#/kitchen` hoặc `#/dessert` theo station chi tiết như `BAR_COFFEE`, `BAR_TEA`, `KITCHEN_HOT`, `KITCHEN_BBQ`, `KITCHEN_COLD`.
5. Combo BBQ/lẩu được tách thành component để route sang đúng station, không gửi nguyên combo vào một station duy nhất.
6. Bar/bếp bấm Acknowledge, Start và Ready. Khi tất cả khu chế biến của order đã Ready, staff có thể Served.
7. Thu ngân bấm từng bàn trong sơ đồ để mở chi tiết bàn; các order batches, trạng thái món, đối soát phục vụ và thanh toán được gói trong bàn đó. Bấm bàn chỉ xem bàn, không tự tạo order.
8. Khi khách gọi tại quầy, thu ngân bấm `Gọi món tại quầy`, dùng ô tìm kiếm để tìm món nhanh, chọn món vào phiếu tạm, khách kiểm tra lại, rồi bấm `Khách xác nhận - Gửi bếp/bar`. Chỉ lúc này hệ thống mới tạo order batch và route món sang Bar/Bếp.
9. Thu ngân xử lý Pre-bill, Cash/Card/VNPAY/MoMo/ZaloPay, Split 2, Void hoặc Refund. Mọi thao tác quan trọng được ghi vào Audit history.

## Ghi chú kỹ thuật

Bản này là phiên bản frontend/local-first để bạn kiểm tra luồng nghiệp vụ nhanh. Dữ liệu menu, order, payment và audit được lưu trong `localStorage` của trình duyệt, có đồng bộ giữa các tab cùng trình duyệt bằng BroadcastChannel. Khi chuyển sang production theo DOCX nên nâng cấp thành TypeScript monorepo với backend NestJS, PostgreSQL, Redis/Socket.IO, worker/outbox, print edge-agent, auth/RBAC, idempotency, inventory và payment webhook thật.

Kiến trúc module dài hạn được ghi trong `docs/ARCHITECTURE.md`, `docs/MODULE_MAP.md` và `docs/MODULAR_ARCHITECTURE_AUDIT.md`. App hiện đã bắt đầu tách các public API nhỏ dưới `src/shared/*` và `src/features/*` nhưng vẫn giữ luồng static/local-first hiện tại.
