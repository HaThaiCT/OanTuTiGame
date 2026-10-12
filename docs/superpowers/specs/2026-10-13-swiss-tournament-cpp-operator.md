# Thiết Kế Kỹ Thuật: Hệ Thống Giải Đấu Thụy Sĩ (Swiss System), Bot C++20 & Bảng Điều Khiển Trình Chiếu

> **Tài liệu Thiết kế Kỹ thuật (Design Document)**  
> **Dự án:** OanTuTi Arena (Tournament Operator & C++ IDE)  
> **Ngày lập:** 2026-10-13  
> **Trạng thái:** Chờ phê duyệt (Pending Approval)

---

## 1. Mục Đích & Bối Cảnh (Intent & Why)

Sau khi hoàn thiện giao diện Cyberpunk Neon và hệ thống xác thực người dùng, dự án cần hoàn thiện nốt khâu tổ chức giải đấu thực tế theo đúng yêu cầu:
- Thí sinh có thể viết và nộp bot bằng **Python, TypeScript và C++20** trực tiếp trên Web.
- Ban tổ chức có thể chốt danh sách thí sinh, khởi tạo giải đấu theo **Hệ Thụy Sĩ (Swiss System)** chuẩn quốc tế.
- Ban tổ chức chủ động bấm nút **"Trận đấu tiếp theo (Next Match)"** để tuần tự chiếu từng trận lên màn hình lớn cho khán giả theo dõi, cập nhật bảng điểm qua từng vòng và vinh danh Nhà vô địch khi giải đấu kết thúc.

---

## 2. Mục Tiêu & Ranh Giới (Goals & Non-Goals)

### 2.1. Mục Tiêu (Goals)
1. **Thuật toán ghép cặp Hệ Thụy Sĩ (Swiss System) chuẩn:**
   - Số vòng đấu tiêu chuẩn: $R = \lceil \log_2(N) \rceil$ hoặc do người tổ chức chỉ định.
   - Vòng 1: Xếp cặp ngẫu nhiên giữa các bot tham gia.
   - Vòng $k \ge 2$: Phân nhóm các bot có cùng số điểm (Score Groups, ví dụ nhóm 3.0 điểm, 1.5 điểm, 0 điểm). Trong mỗi nhóm, ghép cặp các bot chưa từng đối đầu với nhau trong các vòng trước.
   - Xử lý số lượng bot lẻ: Tự động cấp một vé miễn đấu (Bye) cộng 3 điểm cho bot chưa từng nhận Bye.
2. **Hỗ trợ C++20 trên Monaco Editor Web:**
   - Tab ngôn ngữ `C++` bên cạnh `Python` và `TypeScript`.
   - Template mã nguồn chuẩn C++20 (`#include "oantuti.hpp"`).
   - Tích hợp với API server để lưu phiên bản và biên dịch tự động bằng `g++ -std=c++20 -O3`.
3. **Bảng điều khiển Người tổ chức (Tournament Operator Console):**
   - Hiển thị tiến trình các vòng đấu: Vòng $1 \to 2 \dots \to R$.
   - Danh sách trận đấu của vòng hiện tại với trạng thái `Đang chờ`, `Đang chiếu`, `Đã xong`.
   - Nút bấm nổi bật **"Trận đấu tiếp theo (Next Match)"**: Người tổ chức bấm để chuyển trận tiếp theo lên bàn cờ Canvas 2D chính.
   - Bàn cờ tự động chiếu hoạt ảnh trận đấu, cập nhật kết quả và điểm số.
4. **Màn hình Vinh Danh Nhà Vô Địch (Champion Trophy Ceremony):**
   - Khi hoàn thành tất cả các vòng đấu của giải, hiển thị bảng vinh danh Quán quân với cúp vàng 🏆, pháo hoa ăn mừng Confetti và bảng tổng sắp huy chương.
### 3.1. Thuật Toán Ghép Cặp Swiss Trong `tournament-service.ts`
1. **Mô hình ghép cặp & thực thi:**
   - Server thực thi các vòng đấu của giải đấu theo từng vòng tuần tự (Round 1 hoàn thành $\to$ cập nhật bảng điểm $\to$ tự động sinh lịch ghép cặp Round 2 $\to \dots$).
   - Điểm số chuẩn: Thắng = **3.0 điểm**, Hòa = **1.0 điểm**, Thua = **0.0 điểm**. Tie-breaker: Tổng điểm $\to$ Số trận thắng $\to$ Điểm ELO.
   - Xử lý số bot lẻ: Bot điểm thấp nhất chưa từng nhận Bye sẽ được nhận 1 vé Bye (+3.0 điểm, không tạo match đối kháng).
2. **Cấu trúc dữ liệu trong `config_json`:**
   Lưu danh sách các vòng đấu `rounds`, danh sách `pairings` từng vòng kèm trạng thái và bảng xếp hạng điểm `standings`.

### 3.2. Nâng Cấp `BotEditor.tsx` Hỗ Trợ C++20
1. Thêm tab `[C++]` vào bộ chọn ngôn ngữ bên cạnh `[Python]` và `[TypeScript]`.
2. Export `CPP_BOT_TEMPLATE` trong `templates.ts` với mã nguồn mẫu kế thừa `oantuti::Bot`.
3. Monaco Editor chuyển language mode sang `cpp`.
4. Khi bấm **Run Test** hoặc **Save**, server lưu mã nguồn đuôi `.cpp`. Runner biên dịch bằng `g++ -std=c++20 -O3 -I sdk/cpp`. Nếu có lỗi biên dịch, `stderr` được bắt và hiển thị rõ ràng trên thông báo của Bot Editor.

### 3.3. Giao Diện Người Vận Hành & Trình Chiếu Trận Đấu (`LeaderboardView.tsx`)
1. **Hàng đợi trình chiếu (Broadcast Queue):**
   - Bảng điều khiển giải đấu theo dõi danh sách tất cả các trận đấu từ Vòng 1 đến Vòng cuối.
   - Nút nổi bật **"Trận đấu tiếp theo (Next Match)"**: Người tổ chức bấm để chuyển trận tiếp theo trong hàng đợi lên bàn cờ Canvas 2D chính.
   - Bàn cờ tự động chiếu hoạt ảnh, phát âm thanh và cập nhật kết quả.
2. **Lễ Trao Cúp & Vinh Danh Nhà Vô Địch (Trophy Ceremony):**
   - Khi tất cả các trận đấu của vòng cuối kết thúc, hệ thống hiển thị màn hình vinh danh Quán quân với cúp vàng 🏆 lấp lánh, hiệu ứng pháo hoa Confetti rực rỡ và danh sách top 3 tuyển thủ đạt giải.
---

## 4. Kế Hoạch Xác Minh & Nghiệm Thu

1. **Kiểm thử tự động:**
   - Viết unit test cho thuật toán ghép cặp Swiss trong `tournament.test.ts`.
   - Viết integration test chạy hoàn chỉnh một giải đấu Swiss 4 bot qua 2 vòng đấu.
   - Viết unit test cho template C++20 trên runner.
   - Toàn bộ suite `npm test` giữ vững trạng thái 100% green.
2. **Kiểm thử giao diện trực tiếp (Browser Verification):**
   - Soạn code bot C++ trên Web Editor, bấm Run Test và xem kết quả chạy thật.
   - Tạo giải đấu Hệ Thụy Sĩ, bấm "Trận tiếp theo" để tuần tự chiếu các trận lên màn hình Canvas 2D.
   - Xác nhận xuất hiện màn hình vinh danh Nhà vô địch khi giải đấu kết thúc.
