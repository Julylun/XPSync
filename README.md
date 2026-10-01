# XPSync

Đồng bộ công việc theo nhóm giữa các bản cài **Super Productivity**, với server Node.js/TypeScript, SQLite, WebSocket và dashboard quản trị bằng tiếng Việt.

## Chạy nhanh

Yêu cầu Node.js **22.13+** (đã kiểm thử trên Node.js 24) và npm. Chạy tại thư mục gốc:

```sh
npm ci
npm run setup
npm run build
npm start
```

Mở **http://127.0.0.1:3001/admin/**. Đọc `SETUP_TOKEN` trong `server/.env`, nhập token và tạo tài khoản admin với mật khẩu tối thiểu 12 ký tự. Không có tài khoản hay mật khẩu mặc định. Token thiết lập chỉ sử dụng được khi chưa có admin; có thể xóa `SETUP_TOKEN` khỏi `.env` sau đó.

`npm run setup` tạo secret ngẫu nhiên và không ghi đè `.env` có sẵn. Khi phát triển dùng `npm run dev`. Nếu đang đứng trong `server/`, có thể dùng `npm run dev`, `npm test`, `npm run build` và `npm start` trực tiếp.

## Chạy bằng Docker Compose

Yêu cầu Docker Engine hoặc Docker Desktop đang chạy, kèm Docker Compose v2. Tại thư mục gốc:

```sh
node server/setup.mjs
docker compose up -d --build
docker compose ps
```

Lệnh setup tạo `server/.env` với secret ngẫu nhiên nếu chưa có file; không cần cài npm dependencies trên máy chủ. Mở **http://localhost:3001/admin/** và dùng `SETUP_TOKEN` trong `server/.env` để tạo admin đầu tiên. Nếu đã có `.env`, kiểm tra `JWT_SECRET` là giá trị ngẫu nhiên hợp lệ.

Compose đọc `server/.env`, đặt `HOST=0.0.0.0`, cổng trong container là `3001` và lưu SQLite trong named volume `xpsync-data`. Dữ liệu vẫn còn khi tạo lại container hoặc chạy `docker compose down`. `docker compose down -v` sẽ xóa volume và toàn bộ dữ liệu trong đó. Database cũ ở `server/data/` không tự được nhập vào volume.

Mặc định cổng được mở trên mọi địa chỉ của máy chủ để phục vụ LAN. Có thể đặt `XPSYNC_PORT=3002` để đổi cổng ngoài, hoặc `XPSYNC_BIND_ADDRESS=127.0.0.1` khi dùng reverse proxy trên cùng máy. Đặt các biến này trong môi trường shell hoặc file `.env` ở thư mục gốc; cấu hình ứng dụng và secret vẫn nằm trong `server/.env`. Triển khai Internet cần reverse proxy HTTPS hỗ trợ WebSocket như hướng dẫn bên dưới.

```sh
docker compose logs -f xpsync
docker compose down
```

Sau khi sửa mã nguồn, chạy lại `docker compose up -d --build`. Sau khi sửa `server/.env`, chạy `docker compose up -d --force-recreate`. Image chỉ chứa server và dashboard; đóng gói plugin trên máy phát triển bằng `npm ci` rồi `npm run build -w plugin` để lấy `plugin/xpsync.zip`.

Để sao lưu volume, dừng dịch vụ bằng `docker compose stop xpsync` trước khi sao chép database, rồi chạy lại bằng `docker compose start xpsync`; lưu cả cấu hình `server/.env` ở nơi an toàn.

## Kết nối Super Productivity

1. Trong dashboard chọn **Tạo dự án**, nhập tên và mô tả, sao chép API key. Key chỉ được hiển thị lúc tạo/đổi; server lưu SHA-256 của key, không lưu key gốc.
2. File cài đặt được tạo tại **`plugin/xpsync.zip`**. Trong Super Productivity mở **Settings → Plugins → Choose Plugin File** và chọn ZIP.
3. Bật plugin, bấm nút **XPSync** trên header. Nhập URL gốc của server (`http://192.168.1.100:3001` hoặc `https://sync.example.com`) và tên của bạn.
4. Chọn **Thêm mapping**, chọn dự án cục bộ, nhập API key. Có thể tạo dự án cục bộ ngay trong form.
5. Chọn **Lưu & Kết nối**. Chờ trạng thái **Đã kết nối** và hàng đợi về 0. Lặp lại trên máy khác với cùng API key và tên thành viên khác.
6. Tạo/sửa/hoàn thành/xóa task trong dự án được ghép nối. Các client khác nhận cập nhật và dashboard hiển thị task, người sửa, lịch sử, thành viên online.

Lần kết nối đầu hợp nhất các task hiện có ở hai phía. Hai task khác ID nhưng cùng tiêu đề vẫn là hai task riêng. Mỗi dự án cục bộ chỉ ghép một dự án server; không ghép cùng dự án server vào nhiều dự án trên cùng thiết bị. Bỏ mapping dừng đồng bộ và giữ dữ liệu cục bộ. Đổi API key trên dashboard ngắt ngay những kết nối đang dùng key cũ; nhập key mới rồi lưu cấu hình trên từng máy.

Plugin dùng API hiện tại của Super Productivity: `setSecret/getSecret`, `onMessage`, `getArchivedTasks`, `batchUpdateForProject`. `minSupVersion` theo mốc plugin 14.0.0 trong kế hoạch; mốc này **không bảo đảm** bản SP cũ có đủ các API mới. Nếu thấy thông báo thiếu API, cập nhật Super Productivity. Chưa kiểm thử cài đặt trực tiếp trong ứng dụng SP thật; đã kiểm thử engine với API mô phỏng hợp đồng hiện tại và hai kết nối WebSocket thật.

Để chỉ đóng gói lại plugin:

```sh
cd plugin
node build.js
```

ZIP có đúng bốn file ở thư mục gốc: `manifest.json`, `plugin.js`, `index.html`, `icon.svg`. HTML chứa CSS/JS nội tuyến để tương thích iframe `srcdoc`; không tải CDN. Sửa mã trong `plugin/src/`, không sửa các file build sinh ra.

## Dữ liệu và quy tắc đồng bộ

| Dữ liệu                                                                 | Cách xử lý                                                                               |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `title`, `isDone`, `notes`                                              | Patch từng trường                                                                        |
| `timeSpent`, `timeEstimate`                                             | Số mili giây, LWW cho từng trường; không cộng thời gian của các thành viên               |
| Subtasks                                                                | Đồng bộ task riêng và `parentId`; ánh xạ sang ID cục bộ, duy trì liên kết bằng API batch |
| Xóa task                                                                | Tombstone bền vững, xóa kèm cây con; không hồi sinh ID đã xóa                            |
| Tags, reminders, attachments, ngày đến hạn, nhật ký thời gian từng ngày | Giữ riêng trên máy, không truyền qua server                                              |
| Task đã archive                                                         | Giữ cục bộ; không coi thao tác archive là xóa task của nhóm                              |

- Xung đột dùng cặp **`(timestamp, mutationId)`** cho từng trường. Hai người sửa hai trường khác nhau đều được giữ; cùng trường thì cặp lớn hơn thắng. Mutation đến muộn không ghi đè trường mới hơn. Đồng hồ client vượt server quá 5 phút bị từ chối. Nên bật đồng bộ giờ của hệ điều hành.
- Plugin lưu hàng đợi trước khi gửi và chỉ loại mutation sau ACK. Hàng đợi, baseline và ánh xạ ID nằm trong `localStorage` của host, riêng theo server + dự án server + dự án cục bộ. Giữ nguyên ID mutation khi gửi lại; server xử lý idempotent trong transaction SQLite.
- Khi mất mạng, plugin thử lại với exponential backoff tối đa khoảng 30 giây. Khi khởi động lại, plugin so dữ liệu hiện tại với baseline trước khi nhận snapshot, giữ các patch offline chưa ACK. Thay đổi khi plugin không chạy được ghi nhận lúc plugin chạy lại, không thể biết chính xác thời điểm chỉnh sửa trước đó.
- Chống echo dùng hàng xử lý tuần tự, đánh dấu task đang áp dụng trong 2 giây và so giá trị baseline. Không bỏ toàn bộ thay đổi người dùng trong cửa sổ 2 giây đó. Đối soát bổ sung mỗi 10 giây phòng hook bị bỏ lỡ.
- `addTask()` của SP tự sinh ID. Plugin lưu ID trả về; không cố ép ID remote vào task cục bộ. Quan hệ subtasks được đổi qua `batchUpdateForProject`, không ghi thẳng `parentId/subTaskIds` bằng `updateTask`.
- **Sync ngay bây giờ** yêu cầu snapshot và gửi tiếp hàng đợi. Nó hợp nhất patch đang chờ với snapshot; không xóa hàng đợi offline để ép ghi đè.
- API key chỉ dùng Secret Storage cục bộ, không đi vào cấu hình synced, ZIP, URL, activity hay localStorage. Secret Storage của SP hiện không mã hóa tại chỗ; nhập lại key trên từng thiết bị.

## Cấu hình và triển khai

| Biến             | Mặc định / yêu cầu                                                 |
| ---------------- | ------------------------------------------------------------------ |
| `HOST`           | `127.0.0.1`; dùng `0.0.0.0` để phục vụ LAN                         |
| `PORT`           | `3001`                                                             |
| `DB_PATH`        | `./data/xpsync.db`, tính từ thư mục `server/` khi dùng npm scripts |
| `JWT_SECRET`     | Bắt buộc, tối thiểu 32 ký tự ngẫu nhiên                            |
| `SETUP_TOKEN`    | Token ngẫu nhiên cho thiết lập admin đầu tiên                      |
| `CLIENT_ORIGINS` | `*`, hoặc danh sách origin phân cách bằng dấu phẩy                 |

Cho LAN: đổi `HOST=0.0.0.0`, cho phép cổng trên firewall, rồi dùng IP của máy chạy server. HTTP phù hợp mạng nội bộ tin cậy. Cho Internet: đặt reverse proxy HTTPS trước server và dùng WSS; ứng dụng SP trên HTTPS không kết nối được tới HTTP/WS do mixed content. Client dùng WebSocket/fetch của host renderer, chịu CSP và chính sách mạng của bản SP đang chạy.

Ví dụ Nginx trong `server` HTTPS đã có certificate:

```nginx
location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 90s;
}
```

Chạy **một process server** với database nằm trên ổ đĩa cục bộ. Room/presence nằm trong bộ nhớ; chưa hỗ trợ nhiều process/VPS chung một DB. Các API admin yêu cầu Bearer JWT hết hạn sau 8 giờ. Dashboard giữ token trong `sessionStorage`, hết phiên khi đóng tab. Không có CORS cho admin REST; các origin client chỉ áp dụng cho `/api/client/*` và WebSocket. Mỗi API key cấp toàn quyền đọc/ghi cho một dự án; username là tên tự khai báo, không phải tài khoản người dùng có xác thực riêng.

Sao lưu: dừng server sạch trước khi copy `server/data/xpsync.db` cùng cấu hình `.env`, hoặc dùng SQLite online backup. Nếu copy database khi còn chạy thì phải xử lý cả WAL đúng chuẩn SQLite. Khôi phục DB và giữ nguyên JWT secret nếu muốn duy trì token admin cũ. Không xóa file localStorage của plugin khi còn mutation chờ gửi.

### Giới hạn của bản 1.0

- Phù hợp nhóm nhỏ và số lượng task vừa phải. Snapshot gửi toàn bộ dữ liệu; chưa có phân trang/delta sync. Activity log và receipt/tombstone được giữ trong DB, chưa có cơ chế dọn lịch sử.
- `localStorage` có quota theo trình duyệt. Lỗi lưu được hiển thị trong activity; mutation không được gửi khi chưa lưu được. Không dùng XPSync làm bản sao lưu duy nhất.
- Tombstone là kết thúc của một ID: muốn tạo lại task đã xóa hãy tạo task mới. Xóa project trên server ngắt kết nối nhưng không xóa dữ liệu trên máy thành viên.
- Archive là cục bộ: task đã archive không nhận cập nhật/xóa remote trong archive. Khi đưa về danh sách active, đối soát sẽ áp dụng trạng thái server.
- Dự án cục bộ chưa tải xong, đã xóa hoặc archive sẽ tạm dừng mapping, không chuyển thành xóa hàng loạt task server. Khi dự án sẵn sàng, bấm **Sync ngay bây giờ**.
- Không đồng bộ thứ tự kéo/thả giữa các subtasks; đồng bộ quan hệ và nội dung. Tránh dùng thêm một cơ chế đồng bộ nhóm khác cho cùng tập task khi chưa kiểm chứng tương tác.
- Khi đổi server/mapping, hàng đợi cũ được giữ theo namespace cũ và không gửi sang dự án khác. Ghép lại cấu hình cũ để tiếp tục gửi.
- API hiện tại của SP có thể biến đổi tiêu đề ngắn hoặc số liệu tổng hợp của task cha. Engine áp lại các trường chuẩn, nhưng cần smoke test trên phiên bản SP thực tế trước khi triển khai cho nhóm.

## Kiểm thử

```sh
npm run check
```

Lệnh trên chạy TypeScript typecheck, kiểm thử server/plugin và build ZIP. Bộ test dùng database tạm, API SP mô phỏng và WebSocket loopback thật. Kiểm tra: setup/login và JWT, validate API key, CRUD dự án, key rotation, phân tách room, ACK và idempotency, LWW từng trường, xóa/cascade, persistence sau restart, hai client đồng bộ hai chiều, offline replay, không echo, ánh xạ ID/subtask, trường riêng và archive.

Dashboard đã kiểm tra bằng trình duyệt với dữ liệu giả: tạo admin lần đầu, chọn dự án, danh sách task/activity, kết nối live và lọc trạng thái. Có fixture tạm để kiểm tra lại giao diện:

```sh
npm run build
node server/tests/preview.mjs
```

Fixture ở `http://127.0.0.1:3101/admin/`, dùng DB trong RAM, setup token `xpsync-preview-setup`. Không đưa fixture này ra Internet; tắt bằng Ctrl+C sau khi kiểm tra.

Kiểm tra nghiệm thu trong SP thật:

1. Cài ZIP ở hai profile SP khác nhau, ghép hai local project vào cùng server project.
2. Alice tạo task và subtask; Bob nhận đúng một bản, dashboard hiển thị tác giả.
3. Alice đổi tên trong khi Bob tích hoàn thành; cả hai thay đổi được giữ.
4. Ngắt mạng Bob, sửa notes, nối lại; notes được gửi và các trường khác giữ đúng.
5. Xóa task ở Alice khi Bob offline; Bob kết nối lại không hồi sinh task đã xóa.
6. Đợi thêm 10 giây, activity không tăng khi không ai chỉnh sửa.

## Mã nguồn và giao thức

```text
server/src/       cấu hình, SQLite, REST auth/projects, WebSocket hub
server/public/    dashboard HTML/CSS/JS
server/tests/     kiểm thử API, database, hai client và fixture UI
plugin/src/       engine, script nền, form cài đặt
plugin/tests/     kiểm thử offline/baseline và mock API SP
plugin/build.js   sinh plugin.js, index.html và xpsync.zip
docs/protocol.md  giao thức wire và quyết định kỹ thuật
```

Đối chiếu API với [hướng dẫn plugin chính thức](https://github.com/super-productivity/super-productivity/blob/master/docs/plugin-development.md), [định nghĩa API](https://github.com/super-productivity/super-productivity/blob/master/packages/plugin-api/src/types.ts), [task bridge](https://github.com/super-productivity/super-productivity/blob/master/src/app/plugins/plugin-bridge.service.ts) và [iframe bridge](https://github.com/super-productivity/super-productivity/blob/master/src/app/plugins/util/plugin-iframe.util.ts) ngày 27/09/2026.
