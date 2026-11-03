# Bắt buộc nghiệm thu cả bốn giao thức

Trạng thái: đang triển khai. MQTT, Modbus TCP, OPC UA và HTTP API đều là điều kiện hoàn tất; không giao thức nào được xem là xong chỉ vì mở được socket. Tài liệu này bổ sung các ca E07–E15 của [plan chính](2026-11-02-collector-review2.md), theo yêu cầu của người dùng ngày 02/11/2026.

Mỗi ca phải kiểm tra xuyên suốt: giá trị nhập trên form → request API → cấu hình đã lưu → snapshot/revision Edge đã áp dụng → trao đổi thực với nguồn → observation/latest → giá trị, quality và thời gian hiển thị. Reload không được đổi cấu hình. Test và Activate dùng cùng mapping; đổi bất kỳ tham số nguồn hoặc mapping phải thử lại. Bằng chứng ghi rõ loại test, không dùng unit test để thay cho E2E/computer use.

## Các ca dùng chung

| Ca | Tình huống | Kết quả bắt buộc |
|---|---|---|
| COM-01 | Tạo connection hợp lệ, nhập nhiều mapping | Test đọc được từng mapping và xác thực kiểu; không ghi signal trước Activate |
| COM-02 | Sai host/cổng, nguồn không hoạt động | Thất bại có bước/lý do; có timeout; UI không treo và không mở khóa Activate |
| COM-03 | Sai thông tin xác thực | Lỗi auth rõ ràng; không tự chuyển sang anonymous |
| COM-04 | Mẫu đọc được nhưng sai address/path/type | Test thất bại tại đọc/mapping/validation; Network Passed không đủ |
| COM-05 | Đổi cấu hình hoặc mapping sau Passed, kể cả khi test đang chạy | Kết quả cũ mất hiệu lực; không kích hoạt cấu hình khác với cấu hình đã test |
| COM-06 | Test không có mapping trên connection mới | Không Passed; hướng dẫn khai báo mapping |
| COM-07 | Job hết hạn, Edge mất kết nối, gửi kết quả trễ/đúp | Center chốt timeout, từ chối kết quả cũ và không thay đổi kết quả đã chốt |
| COM-08 | Sửa endpoint/security/address khi đang thu thập | Revision mới được xác nhận; connector cũ đóng; dữ liệu đến từ nguồn mới |
| COM-09 | Pause/Resume/Archive/Restore | Pause dừng đọc; Resume phục hồi; trạng thái và latest/freshness tách biệt |
| COM-10 | Nguồn chậm cùng với nguồn nhanh | Nguồn nhanh và heartbeat vẫn chạy đúng; không để một nguồn chặn toàn Edge |
| COM-11 | Center mất kết nối rồi phục hồi | Outbox có giới hạn; retry/ack không trùng latest; backlog giảm; dữ liệu cũ không ghi đè mới |
| COM-12 | Giá trị 0/false/null/chuỗi rỗng/chuỗi có số 0 đầu | Giữ nguyên giá trị theo kiểu đã khai báo; không dùng truthiness để xác định missing |
| COM-13 | Missing và dữ liệu lỗi | Phân biệt thiếu, explicit null, decode lỗi, type lỗi; giữ last-good; hiển thị lý do |
| COM-14 | Source timestamp, receive timestamp, timezone, clock lệch | Giữ nguồn gốc thời gian; không xóa giá trị hợp lệ khi quality UNCERTAIN; không dùng clock nguồn làm bằng chứng quyền sở hữu mapping |
| COM-15 | Bí mật và lỗi upstream | Password/private key chỉ trong secret store; không xuất hiện ở GET config, preview, export, audit, log, screenshot |
| COM-16 | Archive một asset dùng chung connection | Chỉ mappings của asset đó dừng; asset khác tiếp tục; Restore giữ cấu hình |
| COM-17 | Điều hướng/reload/offline/concurrent edit | Không báo Saved giả; giữ bản nháp; conflict có cách phục hồi; không tạo draft mồ côi |

## MQTT — CR-Q01…Q04, Q06…Q10

| Ca | Kiểm tra |
|---|---|
| MQ-01 | MQTT 3.1.1 và 5.0: đo protocol level trong CONNECT; UI 5.0 được chuẩn hóa đúng |
| MQ-02 | QoS 0/1/2: đối chiếu SUBSCRIBE tại broker; 0 không bị đổi thành 1 |
| MQ-03 | Client ID người dùng, ID mặc định, xung đột ID; commissioning dùng ID riêng và không ngắt collector đang chạy |
| MQ-04 | Keepalive gồm 0, clean session/clean start, MQTT 5 session expiry; đối chiếu gói CONNECT |
| MQ-05 | Anonymous, username/password đúng/sai, CONNACK/SUBACK từ chối, reconnect sau lỗi auth |
| MQ-06 | TLS với CA hệ thống/CA riêng; mTLS; CA sai/hết hạn/hostname sai/key không khớp đều bị từ chối; không tắt xác minh |
| MQ-07 | Exact topic, +, #, topic rỗng/malformed, $SYS và empty topic level hợp lệ; lỗi tại form/API trước Activate |
| MQ-08 | Wildcard 36 topic × 1 Hz: tách theo topic/address; Line production và machine fields không làm nhau BAD |
| MQ-09 | Nhiều message cùng topic giữa hai chu kỳ: lấy mới nhất; topic khác không mất; giá trị cũ đến trễ không thay mới |
| MQ-10 | Giới hạn số topic/bytes; payload lớn, invalid JSON, overflow; counter thật và bộ nhớ không tăng vô hạn |
| MQ-11 | Capture trả topic + payload + thời gian; mapping chọn topic đã thấy; không dùng toàn bộ payload chỉ để báo Mapping Passed |
| MQ-12 | String/Integer/Number/Bool/JSON, nullable, source_timestamp và JSONPath timestamp tùy chọn; không ép String thành số |
| MQ-13 | Một connection → nhiều asset cùng Site; tên/code/path model đổi không tự thay topic nguồn |
| MQ-14 | So sánh read-only với broker lab ≥30 phút và soak ≥1 giờ; báo độ trễ/drop/coalesce thực đo |

## Modbus TCP — CR-Q02, Q06, Q11

| Ca | Kiểm tra |
|---|---|
| MB-01 | Host/port, unit ID 0–247, timeout, retries gồm 0: tham số đến thư viện thật |
| MB-02 | Coil/Discrete Input/Holding Register/Input Register: kiểm tra function code 01/02/03/04 tại server |
| MB-03 | Offset 0, giới hạn 65535, span vượt vùng, số register đúng theo kiểu; phân biệt offset với ký hiệu 40001 |
| MB-04 | Int16/UInt16/Int32/UInt32/Float32/Float64/Bool; âm, min/max, zero và false |
| MB-05 | Word order và byte order độc lập; đối chiếu các byte/word mẫu được tính thủ công |
| MB-06 | Scale/offset, gồm scale 0, offset âm; không mất tham số do `or`/truthiness |
| MB-07 | Kế hoạch gộp block không trộn unit/area/order; chia block theo giới hạn register/bit; không đọc dư địa chỉ gây lỗi nguồn |
| MB-08 | Modbus exception, short response, disconnect giữa frame, unit không tồn tại, timeout/retry; chỉ field/block liên quan BAD |
| MB-09 | Commissioning phải đọc đúng các register đã khai báo và decode; TCP connect thành công nhưng read lỗi vẫn Failed |
| MB-10 | Edit/Pause/Resume thay connector và đóng socket; nhiều connection cùng endpoint không lẫn cấu hình |
| MB-11 | Đối chiếu latest/UI với server kiểm thử và chứng minh không phát function code ghi |

## OPC UA — CR-Q06, Q12, SRC-05

| Ca | Kiểm tra |
|---|---|
| UA-01 | Endpoint, timeout, security policy/mode, anonymous/username/X.509: lưu và áp dụng đúng |
| UA-02 | Sign/SignAndEncrypt với trust/certificate/private key; sai trust/hostname/credential phải Failed; không âm thầm dùng None |
| UA-03 | Browse namespace/tree, search, chọn node, DataType và access level từ server; không bịa danh sách node |
| UA-04 | NodeId numeric/string/GUID/bytes và namespace; invalid/missing/không có quyền đọc hiện đúng lỗi |
| UA-05 | Read và Subscribe nhiều node; notification đảo thứ tự/lặp/một node cập nhật nhanh: ghép theo NodeId, không theo index |
| UA-06 | StatusCode Good/Uncertain/Bad và SourceTimestamp/ServerTimestamp; lấy từ DataValue thực |
| UA-07 | Native bool/int/float/string/date/array theo lựa chọn mapping; giá trị không đọc được không làm rơi node còn lại |
| UA-08 | Sampling/publishing interval, reconnect/recreate monitored items; không nhân đôi dữ liệu sau reconnect |
| UA-09 | Subscribe lỗi hoặc timeout: subscription/session được đóng; số phiên và bộ nhớ không tăng qua nhiều chu kỳ/test |
| UA-10 | Commissioning đọc NodeId trong mapping nháp, không yêu cầu `config.node_id` không tồn tại trên form |
| UA-11 | Đối chiếu Browse → Test → Activate → Catalog/Monitor qua computer use trên server kiểm thử; chứng minh không gọi Write |

## HTTP API — CR-Q06, Q13

| Ca | Kiểm tra |
|---|---|
| HT-01 | Base URL + Path + query: không bỏ Path khi đã nhập URL; quy tắc ghép được giải thích trên form |
| HT-02 | GET và POST phục vụ truy vấn đọc; request method/body đúng như đã cấu hình tại server kiểm thử |
| HT-03 | Headers, query, timeout, poll interval và mapping JSONPath; reload giữ nguyên |
| HT-04 | None/Basic/Bearer/API key header; đúng/sai/missing secret; username Basic không bị mất khi parse config |
| HT-05 | HTTPS CA/hostname đúng/sai; không tắt verification; URL không chứa credentials; redirect không vượt allowlist |
| HT-06 | 200 JSON object/array/scalar, nullable/0/false/empty; nhiều mappings; source_timestamp/timestamp JSONPath |
| HT-07 | 401/403/404/429/5xx/redirect, invalid JSON, timeout, connection reset, payload lớn; phân biệt bước lỗi và retry có giới hạn |
| HT-08 | JSONPath sai/missing/multiple matches/type mismatch: Test không Passed và hiển thị đúng hàng |
| HT-09 | Send test request có preview thật, che bí mật, không ghi signal trước Activate |
| HT-10 | Sửa URL/headers/auth/path khi đang chạy, Pause/Resume và nguồn chậm không chặn nguồn khác |
| HT-11 | Đối chiếu request server → Edge → latest → UI bằng automated test và computer use |

## Ghi nhận và tiêu chí đóng

Mỗi ca ghi: phiên bản nguồn và bundle chạy ở 8080, môi trường/fixture, input che bí mật, expected/actual, test command/exit code, thời gian đo, ảnh CU nếu có UI, issue review liên quan. Trạng thái dùng OPEN / IN PROGRESS / VERIFIED / DEFERRED (quyết định của người dùng). Không tự chuyển lỗi giao thức sang DEFERRED.

Một giao thức chỉ đóng khi các ca áp dụng đã có bằng chứng, cả lỗi và phục hồi đều qua, không còn tham số UI bị bỏ qua và E2E tại 8080 đã được thao tác lại bằng computer use. Các ca chưa chạy được vẫn OPEN, không dùng từ “hoàn hảo” thay cho kết quả đo.
