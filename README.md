# Switch Acc Codex

Web tool local để lưu nhiều profile đăng nhập Codex và đổi nhanh account active.

## Codex đang lưu đăng nhập ở đâu

Trên máy này, Codex CLI `0.122.0-alpha.1` đang dùng:

- `~/.codex/auth.json`: credential active hiện tại.
- `~/.codex/state_5.sqlite`: có bảng `remote_control_enrollments`, chứa state app-server gắn với `account_id`.
- `~/.codex/config.toml`: config model/profile, không phải nơi lưu danh sách account.

Ngoài ra binary Codex có chuỗi `It will be stored locally in auth.json.` cho API key login, và có hỗ trợ biến môi trường `CODEX_HOME`.

## Tool này làm gì

- Đọc account active từ `CODEX_HOME/auth.json` hoặc mặc định `~/.codex/auth.json`.
- Lưu mỗi account thành một profile riêng trong `storage/profiles/<profile-id>/auth.json`.
- Switch nhanh bằng cách ghi đè `auth.json` active.
- Có thể khởi chạy `codex login --device-auth` từ web, mở trang đăng nhập chính chủ, rồi tự import auth mới thành profile sau khi login xong.
- Sau khi switch, xóa bảng `remote_control_enrollments` trong `state_5.sqlite` để giảm rủi ro metadata app-server cũ bị giữ lại.
- Backup `auth.json` cũ vào `storage/backups/` trước mỗi lần switch.
- Sau khi switch, backend gọi `codex login status` để ép Codex CLI đọc lại auth mới và xác nhận login state.
- Hiển thị tình trạng JWT còn hạn bao lâu và thời điểm subscription hết hạn cho account active lẫn các profile đã lưu.
- Ưu tiên lấy usage thật từ Codex OAuth API `https://chatgpt.com/backend-api/wham/usage` bằng token trong `auth.json`, tương tự hướng của CodexBar.
- Nếu OAuth usage không lấy được thì mới fallback sang CLI probe cũ hoặc metadata local.
- Có chế độ `Manual+ Rotation`: theo dõi usage của account active, tự gợi ý account tốt nhất để chuyển sang, rồi hỏi xác nhận trước khi switch.
- Có thể gửi Linux desktop notifications từ backend bằng `notify-send`, kể cả khi tab web không nằm foreground, miễn là container nhìn thấy DBus session bus của desktop host.
- Có thêm tab `GPT Accounts` để lưu email, mật khẩu và ghi chú các account GPT cục bộ trong `storage/gpt-accounts.json`.

## Chạy

```bash
npm start
```

Mở:

```text
http://127.0.0.1:3188
```

## Chạy nền trên host

Repo này có sẵn file service tại `systemd/switch-acc-codex.service`.

Nếu chạy bản host thay vì Docker, có thể cài user service:

```bash
install -Dm644 systemd/switch-acc-codex.service ~/.config/systemd/user/switch-acc-codex.service
systemctl --user daemon-reload
loginctl enable-linger "$USER"
systemctl --user enable --now switch-acc-codex.service
```

Kiểm tra:

```bash
systemctl --user status switch-acc-codex.service
```

## Chạy bằng Docker

1. Tạo file `.env`:

```bash
cp .env.example .env
```

2. Build và chạy container:

```bash
docker compose up -d --build
```

Image Docker có cài sẵn `codex` CLI để web login bằng `device-auth` và để backend chạy probe `codex login status` sau khi switch account.

3. Mở:

```text
http://127.0.0.1:3188
```

### Tự chạy khi bật máy

- `compose.yaml` đã dùng `restart: unless-stopped`, nên container sẽ tự lên lại sau reboot.
- Profiles đã import trong chế độ Docker được lưu trong named volume `switch-acc-codex-storage`.
- Điều kiện là Docker daemon phải được bật lúc boot:

```bash
sudo systemctl enable --now docker
```

- Xem log:

```bash
docker compose logs -f
```

- Dừng:

```bash
docker compose down
```

## Cách dùng

1. Đăng nhập vào một account Codex như bình thường.
2. Mở web tool, nhập tên profile, bấm `Import current auth`.
3. Lặp lại với các account khác.
4. Khi cần đổi account, bấm `Switch`.

Hoặc:

1. Mở web tool.
2. Ở mục `Login via Web`, nhập tên profile muốn lưu.
3. Bấm `Start device login`, đăng nhập trên trang OpenAI mở ra, nhập mã device code.
4. Chờ app tự import account vừa login thành profile mới.

## Lưu ý quan trọng

- `storage/` chứa refresh token hoặc API key thật. Không commit thư mục này.
- Container mount trực tiếp `${HOME}/.codex` từ host vào `/codex-home`, nên switch trong web sẽ đổi account Codex thật trên máy.
- App có gọi `codex login status` ngay sau mỗi lần switch để warm lại trạng thái login, nhưng session Codex/extension đang chạy từ trước vẫn có thể phải restart nếu còn giữ cache cũ.
- Tool này dựa trên cấu trúc local của Codex hiện tại; nếu OpenAI đổi format auth trong bản mới hơn, logic switch có thể phải cập nhật.
- OAuth access token được refresh khi `last_refresh` quá cũ và có `refresh_token`, theo cùng hướng mà CodexBar dùng.
- Với profile đã lưu, app sẽ thử dùng chính token của profile đó để lấy live usage; nếu thất bại mới dùng snapshot gần nhất đã cache.
- `Manual+ Rotation` chỉ gợi ý và hỏi trước khi đổi; chưa tự động switch hoàn toàn nếu bạn chưa xác nhận.
- Dữ liệu trong tab `GPT Accounts` hiện được lưu plain text vì tool này chỉ nhắm tới máy local đáng tin cậy của bạn.
- Browser notification và Linux desktop notification là hai lớp độc lập: browser notification cần bạn từng mở web và cấp quyền; Linux notification từ backend không cần quyền trình duyệt nhưng cần Docker mount được session bus của host.
