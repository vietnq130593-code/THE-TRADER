// ============================================================
// front.js — Lời nói đầu (front matter) + Giới thiệu giáo trình (body)
// ============================================================
const { Paragraph, TextRun, AlignmentType } = require("docx");
const H = require("./helpers");

// ------------------------------------------------------------
// PHẦN FRONT MATTER — LỜI NÓI ĐẦU (đánh số La Mã riêng)
// ------------------------------------------------------------
const loiNoiDau = [
  H.h1("Lời nói đầu", { pageBreak: false }),
  H.lead([
    "Python hiện là ngôn ngữ được chọn nhiều nhất cho các công việc backend, tự động hoá, xử lý dữ liệu và xây dựng dịch vụ web. Ngôn ngữ này có cú pháp ngắn gọn, gần với ngôn ngữ tự nhiên, nên rất phù hợp để người mới bước vào lập trình; đồng thời hệ sinh thái thư viện của nó lại đủ mạnh để xây dựng các hệ thống chạy thật (production). Tuy nhiên, học Python để ",
    { b: "làm dịch vụ thực tế" },
    " — tức là gọi được API của bên khác, tự viết được API, đọc ghi được database — đòi hỏi một lộ trình có thứ tự, trong đó mỗi cấp độ đều phải được luyện tay qua ví dụ và bài tập.",
  ]),
  H.p([
    "Giáo trình này được biên soạn theo đúng tinh thần đó: toàn bộ nội dung được tổ chức thành ",
    { b: "bảy cấp độ" },
    ", đi từ nền tảng cốt lõi nhất (cài đặt môi trường, biến, vòng lặp) đến các kỹ năng phục vụ service thực tế (FastAPI, SQL, SQLAlchemy, async, logging, đọc tài liệu Swagger). Mỗi chương trình bày đầy đủ lý thuyết cần thiết, kèm ",
    { b: "ví dụ mã nguồn chạy được" },
    ", ",
    { b: "bảng tra cứu" },
    " và ",
    { b: "bài tập thực hành" },
    " có gợi ý. Người học hoàn thành xong cấp độ 7 sẽ đủ khả năng tự xây dựng một dịch vụ CRUD hoàn chỉnh: nhận request, validate dữ liệu, lưu vào database, ghi log và được kiểm thử qua Swagger.",
  ]),
  H.p([
    "Đối tượng của giáo trình là người mới bắt đầu hoàn toàn hoặc người đã biết ngôn ngữ khác nhưng muốn chuyển sang Python theo hướng thực chiến. Với người đã có nền tảng, có thể dùng bảng lộ trình ở phần Giới thiệu để nhảy nhanh đến cấp độ mình còn thiếu. Toàn bộ ví dụ được viết và kiểm tra trên ",
    { b: "Python 3.12" },
    ", tuy nhiên mã nguồn vẫn chạy tốt trên các phiên bản Python 3.10 trở lên.",
  ]),
  ...H.callout("tip", "Cách học cho hiệu quả", [
    ["Gõ lại từng dòng mã ví dụ thay vì copy — thao tác gõ giúp tay và đầu nhớ cú pháp nhanh hơn nhiều lần chỉ đọc. Sau khi chạy được ví dụ, hãy tự biến tấu: đổi dữ liệu vào, thêm điều kiện, cố tình gây lỗi rồi đọc traceback. Khi làm bài tập, chỉ mở phần gợi ý sau khi đã tự thử ít nhất 15 phút. Cuối mỗi cấp độ, hãy tự recap bằng cách trả lời: em vừa học được những cú pháp nào, và việc đó giúp làm được sản phẩm gì?"] ,
  ]),
  H.p([
    "Chúc người học kiên trì và nhiều niềm vui trên lộ trình bảy cấp độ phía trước.",
  ]),
];

// ------------------------------------------------------------
// CHƯƠNG GIỚI THIỆU — mục tiêu, lộ trình, cách dùng giáo trình
// ------------------------------------------------------------
const gioiThieu = [
  H.h1("Giới thiệu giáo trình và lộ trình học", { pageBreak: false }),
  H.h2("Mục tiêu tổng quát"),
  H.lead([
    "Kết thúc giáo trình, người học cần đạt được năm mục tiêu: (1) đọc hiểu và tự viết script Python xử lý dữ liệu trong bộ nhớ; (2) tổ chức chương trình nhiều module với xử lý lỗi đầy đủ; (3) gọi API bên ngoài bằng ",
    { c: "requests" },
    " hoặc ",
    { c: "httpx" },
    " kèm xác thực, timeout và retry; (4) tự viết REST API bằng FastAPI với Pydantic validate dữ liệu; (5) đọc ghi database qua sqlite3 và SQLAlchemy, hoàn thiện một dịch vụ CRUD chạy thật kèm logging.",
  ]),
  H.p([
    "Năm mục tiêu này bám sát yêu cầu thực tế của các vị trí backend Python junior: ứng viên hiếm khi bị hỏi lý thuyết hàn lâm, mà được yêu cầu đọc code có sẵn, debug traceback, gọi API thử và viết endpoint mới. Vì vậy mọi chương của giáo trình đều kết thúc bằng bài tập mô phỏng công việc kiểu đó.",
  ]),

  H.h2("Lộ trình bảy cấp độ"),
  H.lead([
    "Bảng dưới đây tóm tắt toàn bộ giáo trình. Cấp độ 1–4 là ",
    { b: "bắt buộc" },
    " vì chúng là nền móng; cấp độ 5–7 chuyển sang kỹ năng service thực tế. Thời lượng gợi ý tính theo mức độ học 1–2 giờ mỗi ngày.",
  ]),
  ...H.dataTable(
    "Bảng 0.1 — Lộ trình 7 cấp độ của giáo trình",
    ["Cấp độ", "Trọng tâm", "Nội dung chính", "Kết quả đạt được", "Thời lượng"],
    [
      [["1"], ["Nền tảng cơ bản"], ["Cài đặt, venv, pip, requirements.txt, biến, kiểu dữ liệu, f-string, if/else, vòng lặp"], ["Viết được script nhỏ chạy độc lập"], ["1–2 tuần"]],
      [["2"], ["Cấu trúc dữ liệu và hàm"], ["list, dict, tuple, set, slicing, comprehension, hàm, lambda"], ["Lưu trữ và biến đổi dữ liệu trong bộ nhớ"], ["2 tuần"]],
      [["3"], ["Module, file và xử lý lỗi"], ["import, module riêng, đọc ghi file JSON, try/except, đọc traceback"], ["Chương trình nhiều file, chịu lỗi"], ["1 tuần"]],
      [["4"], ["OOP và dữ liệu thực tế"], ["class, kế thừa, dùng class của thư viện, datetime, None"], ["Mô hình hoá đối tượng, xử lý dữ liệu thực"], ["1–2 tuần"]],
      [["5"], ["Gọi và viết API"], ["requests/httpx, headers, auth, retry; FastAPI, Pydantic, REST"], ["Gọi API bên ngoài và tự viết API hoàn chỉnh"], ["2–3 tuần"]],
      [["6"], ["Database"], ["SQL cơ bản, sqlite3, SQLAlchemy ORM, CRUD đầy đủ"], ["Dịch vụ có lưu trữ dữ liệu bền vững"], ["2 tuần"]],
      [["7"], ["Nâng cao thực chiến"], ["async/await, pipenv/poetry/conda, logging, debug IDE, Swagger/Postman"], ["Dịch vụ gần chuẩn production"], ["2 tuần"]],
    ],
    [8, 18, 34, 26, 14],
  ),

  H.h2("Cách sử dụng giáo trình"),
  H.lead([
    "Trong toàn bộ giáo trình, ",
    { b: "mã nguồn" },
    " được trình bày trong khung nền nhạt với viền trái màu teal, ví dụ:",
  ]),
  ...H.codeBlock("Cấu trúc một khung mã nguồn", [
    "# Dòng bắt đầu bằng # là ghi chú (comment)",
    "tong = 1 + 2          # Python không cần khai báo kiểu",
    'print(f"Tong = {tong}")  # f-string giúp chèn biến vào chuỗi',
  ], { label: "Mẫu" }),
  H.p([
    "Khung mã có nhãn ",
    { b: "Terminal" },
    " là lệnh gõ vào dòng lệnh (CMD/PowerShell trên Windows, Terminal trên macOS/Linux), không phải mã Python; khung nhãn ",
    { b: "SQL" },
    " (chương 6) là câu truy vấn database; một số khung có nhãn riêng theo loại nội dung (file cấu hình, công cụ). Các ô màu là ",
    { b: "GHI NHỚ" },
    " (kiến thức cần thuộc), ",
    { b: "MẸO" },
    " (mẹo thực hành) và ",
    { b: "LƯU Ý" },
    " (cạm bẫy hay gặp). Cuối mỗi chương là ",
    { b: "bài tập thực hành" },
    " — hãy làm tối thiểu 80% số bài trước khi sang chương sau, vì kiến thức Python được xếp tầng: bài tập cấp độ dưới chính là câu trả lời cho cấp độ trên.",
  ]),
  ...H.callout("note", "Quy ước phiên bản", [
    ["Toàn bộ mã dùng Python 3.10+ (khuyến nghị 3.12). Các lệnh gọi Python trên Windows viết dạng python; trên macOS/Linux có thể phải dùng python3 — nếu lệnh nào báo không tìm thấy, hãy thử thêm số 3 vào cuối."],
  ]),
];

module.exports = { loiNoiDau, gioiThieu };
