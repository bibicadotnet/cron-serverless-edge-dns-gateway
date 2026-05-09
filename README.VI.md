# Hướng dẫn cấu hình Cron DNS Gateway (Tiếng Việt)

[English Version](README.md)

Script chạy trên Cloudflare Workers nhằm mục đích **tối ưu hóa hạn mức 100,000 requests/ngày** của gói Free bằng cách tự động thay đổi bản ghi DNS giữa nhiều tài khoản Cloudflare Pages khác nhau.

### Cơ chế hoạt động:
*   **Dàn đều tải (Load Balancing)**: Cứ mỗi 5 phút, hệ thống kiểm tra toàn bộ tài khoản phụ và luôn chọn tài khoản có **số lượng request thấp nhất** trong ngày để cập nhật vào DNS. Điều này giúp các tài khoản được sử dụng đồng đều.
*   **Thông báo & Báo cáo**: Cảnh báo qua Telegram khi tài khoản chạm ngưỡng 80,000 requests và gửi báo cáo tổng kết sử dụng vào 23:00 UTC hàng ngày.

### Hướng dẫn cấu hình cron.js

Tất cả cấu hình nằm trong file `cron.js`, phần `// ================= CONFIGURATION =================`.

#### 1. Telegram
*   **TELEGRAM_BOT_TOKEN**: Token từ [@BotFather](https://t.me/botfather).
*   **TELEGRAM_CHAT_ID**: ID từ [@userinfobot](https://t.me/userinfobot).

#### 2. Cloudflare (Quản lý domain)
Đây là tài khoản đang giữ quyền quản lý DNS của tên miền.
*   **CF_API_TOKEN**: [API Tokens](https://dash.cloudflare.com/profile/api-tokens) > Tạo token quyền **Zone.DNS**.
*   **CF_ZONE_ID**: Lấy tại mục **Overview** của tên miền.
*   **CF_RECORD_ID**: Chạy lệnh dưới đây để lấy ID của subdomain cần luân chuyển (ví dụ: `serverless-edge-dns-gateway-v2.bibica.net`):

```bash
# Thay CF_ZONE_ID và CF_API_TOKEN của bạn vào
curl -s -X GET "https://api.cloudflare.com/client/v4/zones/CF_ZONE_ID/dns_records?name=serverless-edge-dns-gateway-v2.bibica.net" \
     -H "Authorization: Bearer CF_API_TOKEN" \
     -H "Content-Type: application/json" | jq -r '.result[0].id'
```
*Kết quả có định dạng kiểu: `b7f08f1db45f1abb23cc71c04bfc9782`*

#### 3. Danh sách TOKENS (Các tài khoản Cloudflare Pages phụ)
Danh sách Token để hệ thống theo dõi lượng request trong ngày. Tài khoản nào có số lượng request ít nhất sẽ được tự động lấy ra để sử dụng.
*   Mỗi tài khoản phụ tạo 1 token với các quyền:
    1.  `Account.Account Analytics: Read`
    2.  `Account.Account Settings: Read`
    3.  `Cloudflare Pages: Read`
*   **Mẹo:** Có thể tạo nhanh bằng cách dùng template **Read all resources**.
*   Dán danh sách các Token này vào biến `TOKENS` trong `cron.js` (mỗi dòng 1 token).

#### 4. Ngưỡng cảnh báo
*   `WARNING_LIMIT`: Mặc định `80000`. Khi đạt ngưỡng này, hệ thống sẽ tự động loại bỏ tài khoản khỏi danh sách sử dụng và thông báo qua Telegram.

---
### 5. Triển khai (Đồng bộ hóa)
Dự án được thiết kế để tự động đồng bộ với Cloudflare Workers.
1.  Truy cập Dashboard Cloudflare -> **Workers & Pages**.
2.  Chọn Worker của bạn -> **Settings** -> **Deployment**.
3.  Kết nối với kho lưu trữ GitHub/GitLab của bạn.
4.  Sau khi kết nối, mọi thay đổi bạn thực hiện và push lên (đặc biệt là file `cron.js`) sẽ được Cloudflare tự động cập nhật.

---
> [!NOTE]
> Hệ thống hoàn toàn tự động. Sau khi lưu cấu hình và sync, Worker sẽ tự khởi tạo Database D1 và chạy chu kỳ mỗi 5 phút.
