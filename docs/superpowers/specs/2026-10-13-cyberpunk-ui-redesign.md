# Thiết Kế Chi Tiết: Giao Diện Cyberpunk Neon & Trải Nghiệm Đấu Trường OanTuTi Arena

> **Tài liệu Thiết kế Kỹ thuật (Design Document)**  
> **Dự án:** OanTuTi Arena (Web Visualizer & UI Overhaul)  
> **Ngày lập:** 2026-10-13  
> **Trạng thái:** Chờ phê duyệt (Pending Approval)

---

## 1. Mục Đích & Bối Cảnh (Intent & Why)

Giao diện hiện tại của OanTuTi Arena đã hoàn thiện đầy đủ về logic (máy trạng thái, kết nối WebSocket trực tiếp, bảng log lượt đi, Monaco IDE, giải đấu), tuy nhiên mặt thị giác và cảm giác chơi (game feel) vẫn ở mức giao diện công cụ kỹ thuật đơn thuần (dashboard), chưa mang lại trải nghiệm hào hứng như một tựa game chiến thuật điện tử thực thụ.

Đợt nâng cấp này tái thiết kế toàn diện giao diện Web Visualizer theo phong cách **Cyberpunk Neon Battle Arena (Đấu Trường Tương Lai Viễn Tưởng)**, kết hợp âm thanh Synthwave sống động, hiệu ứng va chạm chiến đấu (screen shake, floating combat text, pháo hoa hạt confetti), màn hình đối đầu kịch tính (Versus Intro), và chế độ trình chiếu toàn màn hình (Theater Mode) phục vụ cả người chơi lẫn ban tổ chức giải đấu.

---

## 2. Mục Tiêu & Ranh Giới (Goals & Non-Goals)

### 2.1. Mục Tiêu (Goals)
1. **Phong cách thị giác Cyberpunk Neon:**
   - Gam màu chủ đạo: Nền tối vũ trụ / Dark Obsidian (`#060a12`), bàn cờ ma trận Hologram phát sáng với các đường lưới năng lượng.
   - Quân cờ Oẳn Tù Tì hình bàn tay (✊ Búa, ✌️ Kéo, ✋ Bao) được viền kim loại 3D, đổ bóng hào quang Neon Cyan (`#06b6d4` cho White) và Crimson (`#f43f5e` cho Black).
   - Hoàng Tòa ($T_W, T_B$) có vòng sáng xung nhịp năng lượng (pulse wave).
2. **Hiệu ứng chiến đấu (Juicy Game Feel):**
   - **Screen-Shake:** Khi xảy ra sự kiện ăn quân (`KILL`) hoặc chiếm cứ điểm (`BREACH`), toàn bộ bàn cờ rung chuyển nhẹ trong $250\text{ms}$ tạo cảm giác va chạm vật lý mạnh mẽ.
   - **Floating Combat Text:** Dòng chữ phát sáng neon bay lên và tan dần trên canvas tại tọa độ va chạm: `KILL!`, `THRONE BREACH!`, `EXTINCTION!`, `STALEMATE!`.
   - **Celebration Confetti:** Bắn pháo hoa ăn mừng khi trận đấu kết thúc.
3. **Hệ thống âm thanh Web Audio (Zero Asset Dependency):**
   - Tạo âm thanh điện tử trực tiếp bằng Web Audio API (Oscillator/Gain nodes), không tải file MP3/WAV ngoài, chạy 100% offline kể cả trong Docker sandbox.
   - Âm thanh: lướt cờ laser (`whoosh`), va chạm ăn quân (`impact/bass boom`), kèn chiến thắng Synthwave (`victory fanfare`), click nút tactile.
   - Có nút gạt Mute/Unmute âm thanh tiện lợi trên thanh Header.
4. **Màn hình đối đầu (Versus Splash Screen):**
   - Khi trận đấu khởi chạy, hiển thị overlay 2 thẻ Bot đối đầu phong cách game đối kháng (White vs Black, so sánh chỉ số ELO) trong $1.5\text{s}$ trước khi bắt đầu lượt đi đầu tiên.
5. **Chế độ trình chiếu toàn màn hình (Theater Mode):**
   - Nút bật/tắt Theater Mode: phóng to bàn cờ chiếm trọn khung hình, ẩn các panel phụ để phục vụ ban tổ chức chiếu lên máy chiếu hoặc màn hình livestream.
6. **Điều khiển bàn phím thuận tiện:**
   - Phím `Space`: Play / Pause.
   - Phím `ArrowLeft` / `ArrowRight`: Lùi 1 lượt / Tiến 1 lượt.

### 2.2. Non-Goals (Không nằm trong phạm vi)
- Không thay đổi luật game toán học $G = (V, E)$, ma trận khắc chế hay engine cốt lõi trong `packages/engine`.
- Không thay đổi giao thức nhị phân Protobuf hay cấu trúc tệp `.oantuti`.
- Không thêm các thư viện 3D cồng kềnh (Three.js/WebGL 3D nặng nề) — giữ nguyên Canvas 2D độ mượt 60 FPS siêu nhẹ.

---

## 3. Kiến Trúc Kỹ Thuật & Giải Pháp Chi Tiết

### 3.1. Hệ Thống Âm Thanh Tổng Hợp (Web Audio Synthesizer)
Tạo mô-đun `packages/web/src/audio/sound-effects.ts` sử dụng `AudioContext`:
- `playMoveSound()`: Tần số lướt từ $400\text{Hz} \to 200\text{Hz}$ dạng sóng sine trong $0.15\text{s}$.
- `playCaptureSound()`: Xung âm thanh tần số thấp ($120\text{Hz} \to 40\text{Hz}$) dạng sóng sawtooth kết hợp bộ lọc low-pass tạo tiếng nổ "BAM!" uy lực.
- `playVictorySound()`: Hợp âm Synthwave 3 nốt (C-E-G / Đô-Mi-Sol) vươn cao trong $1.2\text{s}$.
- Quản lý trạng thái Mute lưu trong `localStorage`.

### 3.2. Hiệu Ứng Bàn Cờ Canvas 2D (`renderer.ts`)
- **Screen-Shake Transform:** Lưu trữ `shakeIntensity` và `shakeDecay`. Khi có va chạm, context được dịch chuyển ngẫu nhiên $(\Delta x, \Delta y) \in [-4, 4]\text{px}$ và giảm dần về 0.
- **Floating Combat Text Layer:** Mảng các đối tượng chữ `{ text, x, y, color, alpha, yOffset, life }`. Mỗi khung hình, chữ bay lên trên $1.5\text{px}$ và giảm dần độ mờ (fade out) trong $800\text{ms}$.
- **Holographic Grid Lines:** Vẽ các đường lưới bàn cờ với màu xanh neon mờ `#06b6d418` kèm chấm sáng giao điểm công nghệ cao.
### 3.3. Các Thành Phần Giao Diện React Mới
1. **`VersusOverlay.tsx`:** Màn hình đối đầu 1.5s với hoạt ảnh zoom-in hai thẻ đấu sĩ White & Black. Bấm chuột hoặc phím bất kỳ có thể bỏ qua ngay lập tức.
2. **`Header.tsx` (Cyberpunk Refit):**
   - Tích hợp nút bật/tắt Âm thanh (Volume / Mute).
   - Tích hợp nút phóng to toàn màn hình Theater Mode (Maximize / Minimize).
   - Thẻ tỷ số Neon viền kính mờ (Glassmorphism).
3. **`TheaterMode`:** State trong `App.tsx` điều khiển ẩn cột bên phải (`width: 0`), mở rộng Canvas chiếm trọn $100\%$ viewport, giữ Top HUD và Timeline deck.
4. **Phím tắt bàn phím (Global Keyboard Shortcuts):** Hook `useKeyboardControls` lắng nghe `Space` (Play/Pause), `ArrowLeft` / `ArrowRight` (Tua từng lượt), `KeyM` (Mute/Unmute), `KeyF` (Theater Mode).

### 3.4. Các Quyết Định Thiết Kế Chi Tiết (Architectural Decisions)
1. **Vòng đời Màn hình Đối đầu (Versus Overlay):**
   - Chỉ tự động kích hoạt khi bấm **`Launch Live Match`**, **`Run Test`** hoặc khi mới load file replay lần đầu. Không kích hoạt khi người dùng chỉ đơn thuần kéo timeline scrubber về Turn 0 để tránh cản trở việc tua lại trận đấu.
   - Cho phép người dùng bấm phím bất kỳ hoặc click chuột để **bỏ qua ngay lập tức (Skip instantly)** nếu không muốn đợi hết 1.5 giây.
   - Trong lúc hiển thị Versus Overlay, bộ đếm lượt tự động tạm dừng (pause); sau khi overlay biến mất, trận đấu bắt đầu trình chiếu mượt mà từ Turn 0.
2. **Hiển thị ELO khi xem Replay ngoại tuyến:**
   - Thẻ Bot hiển thị ELO nếu có trong metadata. Nếu xem file `.oantuti` tải từ ngoài vào không có ELO, hiển thị nhãn `UNRATED` tinh tế, không phụ thuộc vào API server.
3. **Phạm vi Theater Mode:**
   - Thu gọn cột điều khiển bên phải (`width: 0`), mở rộng Canvas chiếm tối đa không gian hiển thị, đồng thời giữ lại thanh Top HUD và thanh Timeline điều khiển ở chân trang để ban tổ chức vẫn thao tác được Play/Pause/Tua.
4. **Xử lý trận đấu kết thúc Hòa (Draw):**
   - Chỉ bắn pháo hoa Confetti và phát nhạc chiến thắng Synthwave khi có người chiến thắng rõ ràng (`winner !== undefined`).
   - Nếu trận đấu Hòa (`MAX_TURNS_DRAW` không có winner), chỉ hiển thị thông báo `MATCH DRAW` trang nhã với âm thanh kết thúc trận trung tính, không bắn pháo hoa.

---

## 4. Kế Hoạch Xác Minh & Tiêu Chí Nghiệm Thu

1. **Kiểm thử tự động:**
   - `npm run build --workspace=@oantuti/web` thành công không lỗi TypeScript/Vite.
   - Toàn bộ suite hiện tại **84/84 tests pass** (`npm test`).
2. **Kiểm thử trực tiếp trên trình duyệt (Browser Smoke Test):**
   - Mở giao diện trên trình duyệt, khởi chạy trận đấu.
   - Thấy màn hình đối đầu Versus Intro xuất hiện kịch tính trong 1.5s.
   - Quân cờ trượt có vệt sáng, khi ăn quân có hiệu ứng rung màn hình, chữ `KILL!` phát sáng bay lên và tiếng nổ âm thanh va chạm.
   - Nút Theater Mode phóng to toàn màn hình mượt mà; phím tắt `Space` và mũi tên điều khiển chuẩn xác.
