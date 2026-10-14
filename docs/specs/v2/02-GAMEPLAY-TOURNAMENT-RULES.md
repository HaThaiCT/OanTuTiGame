# 02 — Gameplay, thể thức và tính công bằng

> Baseline thiết kế trước triển khai chốt ngày2026-10-14. Các tham số kỹ thuật là lựa chọn designer, nay là hợp đồng triển khai; không giả là người dùng đã duyệt riêng từng tham số. Không tuyên bố scheduler v1 hoặc release đã chứng nhận; gates ở05 vẫn bắt buộc. PR-* tham chiếu [yêu cầu sản phẩm](01-PRODUCT-REQUIREMENTS.md).

## 1. Từ vựng và phiên bản

- **Game/ván:** một lần engine chạy với White và Black, tối đa 300 ply (mỗi ply là một nước một phía).
- **Encounter/cặp đấu:** đơn vị xếp lịch và tính điểm giữa hai đội, chứa số ván chẵn đổi màu.
- **Round/vòng:** tập encounters có barrier trước khi ghép vòng tiếp theo.
- **Stage:** Swiss, playoff, vòng tròn hoặc Elo trong giải.
- **Series:** encounter phân thắng bại của knockout. Không gọi 2 ván đổi màu là BO3.
- **Ruleset revision:** manifest bất biến gồm luật engine, IPC, map pool/digests, runtime digests, resource profile, tie-break và scheduler version. Entry gắn submission/artifact cụ thể; mọi game giữ manifest digest.

Giữ luật lõi để sinh viên không phải viết lại chiến thuật vì đổi sản phẩm. Bổ sung chứng nhận bản đồ, công bằng màu, provenance, giải và phân loại lỗi. Không thêm loại quân/skill/fog-of-war trong lần này.

## 2. Luật engine v2

### GP-01 — Bàn cờ và nước đi

Bàn cờ là tập tọa độ hợp lệ trong grid, không phải graph có portal/edge tùy ý. Hai ô kề nhau nếu khoảng cách Chebyshev bằng 1. Cho phép đi chéo giữa hai ô hợp lệ dù ô trực giao kề góc khuyết: đây là luật hiện có, phải có hình minh họa trong tutorial. Một nước chọn một quân sống thuộc phe đến lượt, đi sang ô kề hợp lệ, không vào đồng minh, đối thủ cùng loại hoặc đối thủ khắc chế mình. Rock ăn Scissors, Scissors ăn Paper, Paper ăn Rock. White đi trước.

### GP-02 — Kết thúc và precedence

Sau nước hợp lệ, precedence: extinction → throne breach → stalemate bên sắp đi → max300ply. Extinction xét các chủng loại mỗi phe có trong starting roster như engine v1; thiếu một loại từ đầu không tự xử extinction. PASS khi còn nước là illegal; hết nước xử stalemate thua. Map tự do có thể thiếu loại hoặc trạng thái đầu terminal: engine evaluate initial state trước TURN theo cùng precedence, xét các phe tại từng cấp; nếu cùng cấp cả hai cùng thua thì NO_CONTEST với reason INVALID_START_BOTH_SIDES, không rating, xử encounter theoTR-07. Nếu chỉ một phe thua tại cấp ưu tiên cao nhất thì phe kia thắng, không xét cấp thấp hơn. Initial stalemate chỉ xét White là bên sắp đi; không chặn chỉ vì imbalance. Cần regression trước implementation.

Tại ngưỡng: so số quân sống; nếu bằng, so proximity integer hiện có:

`sum(floor(25200 / (ChebyshevDistance(piece, enemyThrone) + 1)))`.

Bằng nữa là DRAW. Đây là **heuristic integer được chọn**, không tuyên bố tương đương chính xác với tổng hữu tỉ trên mọi map. Đổi WinReason v2 thành `MAX_TURNS_MATERIAL | MAX_TURNS_PROXIMITY | MAX_TURNS_DRAW`; không dùng chữ DRAW cho ván có winner. Không áp luật mới vào replay v1.

### GP-03 — Map pool

**Đã duyệt Admin tự do tạo map**, không bắt buộc đối xứng, quân số/loại cân bằng, connectivity hoặc đường đi giữa hai throne. Hard validation: width và height là integer3–64, tọa độ0≤x<width/0≤y<height;1–4096validcells không trùng; hai throne khác nhau thuộc validcells; piece IDs unique/type/owner hợp lệ; vị trí quân thuộc validcells không chồng nhau (tối đa sốvalidcells). Map JSON canonical và mỗi INIT/TURN request UTF-8 serialized tối đa256KiB theo IPC05; map vượt request cap bị reject dù chưa chạm cell cap. Không wrap/portal. Connectivity, imbalance, thiếu loại, throne bị chiếm và initial terminal là warnings/analysis, không fairness gate; engine cần initial evaluation an toàn. Optional mirror tool không tự sửa map. Bias chưa đo ghi UNMEASURED, không balanced certificate. Bounds/caps là lựa chọn kỹ thuật baseline, không bằng chứng performance.

Admin chọn existing/custom immutable map versions/pool. Hard schema/resource failures chặn execution; balance warnings không chặn, Admin xác nhận/audit. Bias benchmark tham khảo, không custom-map gate. Pool/policy pin trước mở đăng ký, không silent edit sau mở/lock; sửa map tạo version cho giải chưa mở. Visual editor dùng grid validcells/throne/piece tools, preview/warnings/save-version; không cần user quyết định thêm fairness policy.

**Đã duyệt Admin chọn mapPublicationPolicy cho mỗi giải trước mở đăng ký:** PUBLIC_BEFORE_SUBMISSION công bố toàn pool/version/preview/download và cho chạy thử; REVEAL_AFTER_BOT_LOCK giữ kín tới transaction khóa Bot hoàn tất sau drain. Pool và policy cố định trước intake để không chọn map theo source sinh viên; edit sau mở chỉ tạo draft map cho giải khác, không thay pool đã commit. Hidden commitment = SHA-256(random salt256bit + canonical pool manifest), không public map IDs/names/digests/metadata có thể suy ra topology trước reveal; salt/pool reveal sau lock để verify commitment. Public dùng digest thông thường. Nếu map đã public ở thư viện thì không thể tuyên bố secret; UI cảnh báo reuse/public-history, không hứa giữ kín dữ liệu đã công bố. Hidden policy không tiết lộ qua HTTP/WS/SSR/OG/export/storage/test responses; trước reveal test chỉ dùng map công khai riêng, không chạy Bot sinh viên trên hidden map vì replay/stdout/actions có thể lộ. Submission validation/INIT-smoke dùng fixture công khai cùng schema/profile, không hidden official map. Sau reveal mọi người xem/test pool; chính thức vẫn dùng Bot frozen. Salt/pool secret khác draw seed, không reveal sớm do GP-04. Reveal idempotent/durable, không cần admin tab; nếu giải không lock được thì map vẫn kín.

### GP-04 — Nguồn ngẫu nhiên và tái lập

Scheduler master seed CSPRNG256bit được commit SHA-256 lúc publish, reveal lúc lock; đội không chọn seed rated. Domain-separated HMAC-SHA256(master, domain || canonical fixed-field encoding) tạo draw stream và game seed, không nối chuỗi mơ hồ. Game fields gồm encounterId, mapIndex, pairIndex; lấy4byte đầu big-endian thành uint32. Hai game đảo màu cùng pair dùng cùng seed. Draw stream dùng HMAC counter blocks và rejection sampling Fisher–Yates (không modulo bias); domain DRAW khác GAME và map-secret salt. Pin encoding/PRNG version trong manifest, công bố test vectors trước mở đăng ký. SDK khởi tạo PRNG từ seed+side theo version công bố. Bot tự dùng randomness/time có thể khác khi re-execute; chỉ cam kết engine verification từ action trace, không byte-for-byte timing.

### GP-05 — Ngân sách

CPU active turn 100 ms, wall safety 1.000 ms/turn; startup wall 1.000 ms/bot, ngoài turn budget; tối đa 300 ply. Bot không được ponder khi đối thủ đi, bị suspend cả sandbox. CPU cả process tree được tính, không chỉ main PID. Chi tiết compile/memory/output/watchdog và phân loại worker overload ở [05](05-SECURITY-OPERATIONS-QUALITY.md). Resource profile và toolchain không đổi giữa giải. Đây là thay đổi so với wall timeout/grace 5ms của v1; SDK phải hiển thị đúng profile thực thi. Nếu cơ chế CPU+freeze chưa được chứng minh, không tự quay về timeout JS mà vẫn quảng cáo profile này.

## 3. Encounter mặc định và điểm

### TR-01 — Cặp đấu đổi màu

**Người dùng đã duyệt:** encounter Swiss/RR/Elo có2ván cùng map đổi White/Black; tổng hai ván xác định kết quả encounter. Cùng seed mỗi pair là default kỹ thuật baseline. Pool có thứ tự bất biến; map của round/epoch r là index `(r−1) mod poolSize`, áp dụng mọi encounter vòng đó; knockout dùng4map đầu theo thứ tự pool. Persist assignment trước dispatch. Mỗi epoch tối đa một rated encounter/đội.

**Đã duyệt điểm Swiss/RR: thắng3, hòa1, thua0 theo encounter**, không từng ván. Game score thắng1/hòa0,5/thua0; tổng2ván>1 thắngcặp,=1hòa,<1thua. Lưu game points riêng. Baseline bye3điểm cho Swiss, nhưng ghostbye RR/Elo0điểm; không game/Elo/winrate/encounter-win/game-points giả. Walkover Swiss/RR3điểm/knockout advance, Elo khôngrating; record unplayed riêng. Những default unplayed không phải user confirmation riêng.

**Đã duyệt:** knockout4game trên2map đổi màu; hòa thêm tối đa2mini-pairs, mỗi pair2game trênmap3/map4 đã khóa, dừng ở pair không hòa. Sau tối đa8game vẫn hòa ưu tiên seed index nhỏ hơn, verdict ADVANCED_ON_SEED không là thắng ván. Pool≥4map. Loại trực tiếp độc lập seed index là **chỉ số bốc thăm random** theoTR-02; playoffSwiss theo rankSwissSEALED. Không áp fallback cho double-forfeit/withdrawal/infra unresolved. Draw/seed và bracket công bố, khóa trước đấu, không đổi theo worker completion.

## 4. Bốn preset, không tạo bộ ghép luật tùy ý

| Preset | Stage | Nhà vô địch | Cấu hình được phép |
|---|---|---|---|
| SINGLE_ELIMINATION | Knockout | Winner chung kết | 2–500 đội; có/không trận hạng ba; không thay đổi độ dài series |
| SWISS_PLAYOFF |Swiss → knockout|Winner playoff|Tự tính R vòng/T suất từ N đội hợp lệ locked, không organizer override; auto policy v1 bên dưới|
| ROUND_ROBIN |League|Đứng đầu sau tie-break|**Cố định một lượt**, mỗi cặp2ván đổi bên; không tùy chọn hai lượt;500đội cần capacitygate|
| ELO_ARENA | Rating epochs | Rating cao nhất trong nhóm đủ điều kiện | Chạy liên tục, kết thúc sau `epochCount` đợt định trước; không dừng theo đồng hồ |

Không Double Elimination, không Swiss đơn lẻ có chức vô địch khác; vòng Swiss vẫn công bố best Swiss finisher, nhưng không gọi là champion toàn giải. Không cho giảng viên tự chọn Elo làm tie-break của Swiss live.

### TR-02 — Loại trực tiếp

**Người dùng đã duyệt tự động random ghép cặp cho loại trực tiếp độc lập.** Sau roster/Bot lock, hệ thống Fisher–Yates shuffle danh sách entry UUID canonical bằng draw seed đã commit trước giải và reveal khi khóa; PRNG/algorithm version pin, không modulo bias khi lấy index. Shuffle cấp drawIndex1…N, không dùng rating/thành tích trước hoặc giảng viên xếp thủ công. Dùng drawIndex như seed index để đặt bracket power-of-two;500đội→512slots,12byes trao drawIndex1…12 nên bye cũng random,499playedseries nếu không hạngba. Công bố permutation/seed/algorithm/bracket, persist bất biến và không reroll để chọn cặp ưa thích. Vòng sau theo nhánh thắng cố định, không random lại. Khi hòa hết8game, drawIndex nhỏ hơn đi tiếp theo luật đã duyệt, ghi rõ ưu tiên bốc thăm chứ không sức mạnh. Playoff Swiss vẫn seed theo bảng Swiss; Swiss/Elo giữ pairing theo điểm/rating, không đổi thành random toàn giải. Chỉ tạo vòng sau khi vòng trướcSEALED;withdrawal/EMPTY theoTR-07.

### TR-03 — Swiss → playoff

**Tự cấu hình đã được duyệt; công thức designer nay chốt `ArenaAutoFormat/v1`:** N=approved entries có frozen Bot hợp lệ sau drain,2≤N≤500. `R=min(ceil(log2(N)), N−1 nếu N chẵn, N nếu N lẻ)`; `T=min(N,max(2,2^floor(log2(isqrt(N)))))`, isqrt=floor(sqrt(N)). T luôn power-of-two trong miền này; N<2 không chạy. Cap R không vượt số lượt có thể gặp đối thủ khác, nhưng không bảo đảm mọi trạng thái pairing/withdrawal tránh được rematch. Publish policy/version, preview theo N hiện tại; lock persist N/R/T, không đổi do withdrawal. N2→R1/T2;3→2/2;4→2/2;5→3/2;10→4/2;16→4/4;500→9/16.

Seed ban đầu Swiss/RR/Elo là drawIndex1…N từ cùng canonical shuffle/version ởTR-02, không rating quá khứ/UUID sort làm ưu tiên thi đấu. Swiss seed cố định toàn stage. Mỗi round lấy active entries sau SEALED vòng trước; nếu lẻ, bye theo tuple `(byeCount asc, points asc, initialSeedIndex desc)`: ưu tiên chưa bye, ít điểm, rồi seed số lớn hơn. Không cấp bye cho withdrawn/DQ. Sau bye chọn minimum-weight perfect matching trên complete graph, cho phép rematch có cờ để không tự loại đối thủ; không greedy/split-half/random từng vòng. Lặp đối thủ chỉ khi mọi perfect matching có rematch; publish số rematch tối thiểu và inputs.

`ArenaSwiss/v2`: m=activeCountAfterBye/2; Smax=m×(maxInitialSeed−minInitialSeed), Pmax=m×3×(roundOrdinal−1), Wp=Smax+1, Wr=Pmax×Wp+Smax+1. Edge weight=rematchFlag×Wr+abs(pointsA−pointsB)×Wp+abs(initialSeedA−initialSeedB). Minimize tổng: rematch-count → point-gap → seed-gap; checked64-bit integer, mỗi cấp dominance trên tổng cấp thấp. Dùng exact general-graph minimum-weight perfect matching (Edmonds/blossom), không bipartite approximation. Trong các matching cùng trọng số chọn lexicographically smallest sorted list các canonical UUID pairs; manifest pin solver implementation/version/testvectors, không UUID penalty đổi objective. Timeout10giây/lỗi → BLOCKED_PAIRING, không fallback;0entries không gọi solver,2entries tạo pair duy nhất. Regression seeds1,2,100,101/points0,3,3,0 ghép(1,101),(2,100) trước gần seed.

Màu không là tiêu chí pairing vì mỗi encounter đủ hai phía. Chỉ dùng previous SEALED rounds, không live Elo. Standings: points desc → Buchholz desc → Sonneborn-Berger desc → game points desc → initialSeedIndex asc. BH=tổng sealed tournament points hiện tại/cuối stage của opponents trong encounters thực có result counting, kể cả Bot-forfeit nhưng không bye/walkover/double-forfeit/void. SB=tổng opponentPoints×encounterResult (win1/draw0,5/loss0), cùng tập opponents; lưu doubled-integer để tránh float. Đây là Arena variant, không virtual-opponent FIDE. Recompute sau mỗi seal, trong giải nhãn tạm tính; cutoff dùng toàn bộ tuple, không thêm trận.

Kết thúc Swiss lấy topT **active entries theo standings đã SEALED** rồi seed rank1…k, k=min(T,activeCount); không lấy topT gồm withdrawn rồi bỏ trống dù còn active ngoài cutoff. Nếu k<T, ranks k+1…T là EMPTY; nếu withdrawal sau playoff draw đã khóa thì giữ slot EMPTY, không refill/reseed. Standard bracket với T16:1v16,8v9,4v13,5v12,2v15,7v10,3v14,6v11. Không tính lại R/T. Swiss best-finisher riêng, champion chỉ từ playoff. UI lấy policy/N/R/T server, không input top16 cho10đội.

### TR-04 — Vòng tròn

**Người dùng đã duyệt vòng tròn một lượt:** mỗi cặp gặp một encounter gồm2ván đổi bên; không lượt gặp lại hoặc double-round option. Circle method, ghostbye nếu lẻ;500đội→499rounds×250encounters=124.750encounters/249.500ván. Đổi bên trong encounter không là lượt gặp thứhai.

Standings active entries: points desc → mini-table points desc → game points toàn giải desc → encounter wins desc → initialSeedIndex asc. Mini-table xét **một lần trên nhóm đồng tournament points ban đầu**, không recursive regroup; cộng counting encounter points trong nhóm, gồm walkover đã được award nhưng không bye. Encounter wins chỉ trận thực có verdict WIN, không unplayed. Không active entry thì NO_CHAMPION; còn một active entry vẫn phải kết thúc lịch/resolve blockers, không tự kết thúc sớm. Cuối cùng tie bằng seed ghi TIEBROKEN_ON_SEED. RR dispatch có thể pipeline theo lịch cố định nhưng seal/correction vẫn theo round dependencies. Công khai completion%/games còn lại; không tự thêm trận.

### TR-05 — Elo arena hữu hạn, chống farm điểm

**Đã duyệt Elo reset từng giải**, authority `(tournamentId, entryId)`; baseline `ArenaElo/v1` khởi điểm1200, K32. Không carry rating/điểm/seeding từ giải trước/cùng học phần/cùng Bot; season ở đây là giải đó. Archive rating lịch sử giữ nguyên;1200/K32 là lựa chọn designer, không xác nhận riêng của user.
**Đã duyệt tự tính E, không organizer override/hard clock cutoff.** Chốt `E=max(8,4×ceil(log2(N)))` cho2≤N≤500: N2→8;3→8;4→8;5→12;10→16;500→36epochs/9000encounters/18000games. Policy budget/cơ hội, không chứng minh hội tụ. Một encounter2ván/đội/epoch; snapshot→SEALED→ratingcommit→next, khôngE+1. Retry không tăng E; unresolvedinfra ngăn kết thúc. Publish policy trước đăng ký, pin N/E sau drain; withdrawal/worker chậm không giảm E. ETA dựa benchmark+reserved capacity, không hard deadline; thiếu evidence/resources BLOCKED_CAPACITY.

Mỗi encounter có `S = gameAggregate/2` trong [0,1]; `E_A = 1/(1+10^((R_B-R_A)/400))`; `delta_A = 32×(S-E_A)`, `delta_B = -delta_A`. Lưu decimal 6 chữ số, round half away from zero ở delta A rồi đảo dấu cho B để giữ zero-sum; UI hiển thị integer nhưng không dùng integer hiển thị cho tính toán.

Commit rating **sau SEALED epoch**, từ snapshot đầu epoch, không theo thứ tự worker hoàn thành. Một đội chỉ có một encounter nên không xung đột update trong epoch. Replay ledger epoch theo thứ tự ordinal khi void/rejudge. Public hiển thị rating committed và kết quả epoch provisional riêng, không giả rằng rating thay đổi từng game.

Eligibility baseline: N=lockedEntrantCount, `B=ceil(E/N)` nếu N lẻ, ngược lại0; `A=E−B`; `RequiredRated=min(8,A)` **counting rated encounters**, không games; `RequiredDistinct=min(8,A,N−1)` đối thủ khác nhau trong các encounter đó. Khóa thresholds trước chạy, withdrawal không hạ. N2/E8→8encounters/1opponent;N3/E8→5/2;N500/E36→8/8. Chỉ active entries đạt cả hai mới có thể champion; thiếu threshold không block finalize vô hạn, hiển thị INELIGIBLE/provisional cho tới hếtE, cuối giải không ai đủ thì NO_CHAMPION. Tie: rating6decimals desc → rated game points desc → rated distinct opponents desc → drawIndex asc. Bye/walkover/double-forfeit/void khôngrated/khônggamepoints.

Elo pairing `ArenaEloPair/v1`: trước epoch lấy active entries và snapshot ratings; oddbye theo `(byeCount asc, drawIndex desc)`, khôngrating bonus. Sau bye, exact perfect matching minimize lexicographic `(tổng prior counting encounters giữa paired opponents, tổng abs(ratingA−ratingB) theo micro-rating integer, tổng abs(drawIndexA−drawIndexB))`; tie bằng canonical UUID pairlist như Swiss, timeout10s→BLOCKED_PAIRING. History gồm encounters đã chơi kể cả Bot-forfeit, không unplayed/void; không pair do chọn đối thủ/request của đội. Như vậy ưu tiên đối thủ mới/cân cơ hội rồi rating gần, không farm lặp đối thủ khi còn full matching ít lặp hơn. Có withdrawal/forfeit, thresholds không bảo đảm mọi đội đạt; preview kiểm cơ hội và report thực tế, không đổi threshold để trao cúp.

## 5. Khóa, drop, lỗi và sửa kết quả

### TR-06 — Lock nguyên tử

Đến hạn đóng receipt intake theo server clock và persist eligible set bài nhận đủ/bền vững trước hạn. Chuyển VALIDATING_SUBMISSIONS, drain toàn tập tới READY/REJECTED; pending hoặc infrastructure BLOCKED không được bỏ qua để lock. Sau drain, transaction mỗi đội chọn max receiptOrdinal READY, ghi một snapshot submission/artifact/hash/ruleset/seed và LOCKED; idempotent500entries, không khóa một nửa. READY sau hạn vẫn hợp lệ nếu receipt đúng hạn. Đội không có bản hợp lệ chỉ excluded sau drain, reason public không log; <2đội không chạy, organizer cancel hoặc tạo giải mới.

### TR-07 — Lỗi Bot và lỗi hạ tầng

| Loại | Ví dụ | Hậu quả |
|---|---|---|
| BOT_FORFEIT | illegal move, protocol violation, CPU timeout, RAM/PID quota, crash | Thua game, giữ reason/evidence riêng đã lọc |
| INFRA_FAILURE | worker lost, sandbox không khởi tạo, object store lỗi, runner exception, host overload | Không điểm; attempt mới, giữ cùng manifest; tối đa 3 attempts tự động |
| BLOCKED | Hết retry infrastructure | Pause round/chờ organizer; không cancel cả giải và không cho Bot thua |
| NO_CONTEST | Hai Bot đều lỗi startup do Bot; hoặc map initial INVALID_START_BOTH_SIDES | Game score0–0; encounter terminal0điểm cả hai, không Elo; reason riêng, không quy lỗi Bot cho map |
| WALKOVER | Một đội withdrawal/DQ trước encounter start | Active opponent Swiss/RR3điểm, knockout advance; Elo khôngrating; khônggame |

Startup hai bên kiểm tra độc lập; lỗi sandbox/toolchain/storage là INFRA_FAILURE, không Bot failure. Một Bot lỗi startup thì game thua; cả hai lỗi do Bot là double-forfeit. Game đã bắt đầu thì lỗi bên đến lượt xử thua, không suy đoán đối thủ cũng lỗi. Encounter có bất kỳ NO_CONTEST thì toàn encounter terminal0–0/0điểm, không rating/game-points counting; giữ evidence đã chạy nhưng không aggregate để trao win. Double-forfeit reason khác INVALID_START_BOTH_SIDES; cả hai đều không là DRAW. DQ không làm source public.

Knockout encounter NO_CONTEST (double-forfeit hoặc invalid initial both sides) hay cả hai withdrawal/DQ: **không đội nào advance**, downstream EMPTY. Một active slot và một EMPTY tạo walkover; hai EMPTY tiếp tục EMPTY; final hai EMPTY→NO_CHAMPION, không seed fallback. NO_CONTEST dừng series ngay, giữ evidence, không tạo phần games còn lại. RR champion phải active; Elo phải active và đủ eligibility, không tạo Bot giả/bỏ ngưỡng để trao cúp.

Withdrawal effective tại transaction serialized với encounter start (claim game đầu tiên): nếu withdrawal trước start, pending encounter thành walkover; nếu encounter đã start, hoàn thành encounter đó với frozen Bots rồi withdrawal áp cho encounter sau, không đổi giữa hai game. Swiss/Elo không ghép đội withdrawn vòng/epoch mới; Swiss/RR sealed results giữ nguyên. RR lịch còn lại vẫn giữ slots để xử walkover/double-withdrawal. DQ gian lận: pause; khi có phán quyết upheld, void **toàn bộ encounters đội đó trong stage**, không chọn trận; rebuild/invalidate descendants theoTR-08, evidence riêng và public reason đã duyệt. Không vừa giữ điểm một số trận vừa xóa trận khác. Knockout tái tạo descendants từ round ảnh hưởng, không hai đội cùng slot.

Swiss/RR/Elo cả hai withdrawn/DQ trước start→DOUBLE_WITHDRAWAL0điểm/khônggame/rating; một active→walkover; withdrawn không nhận điểm/bye mới. Swiss activeN0 kết thúc stage NO_CHAMPION;activeN1 không ghép vòng còn lại, seal skipped rounds với0điểm/unplayed rồi seed đội còn lại vào playoff cùng EMPTY, không fake Swiss wins. Elo activeN<2: epochs còn lại EMPTY khôngrating; RR giữ fixed schedule. Empty/skipped round/epoch dùng lastTerminalAt=roundActivatedAt, grace10phút; không đợi encounter không tồn tại. Infra hoặc integrity blocker vẫn không được bỏ qua bằng EMPTY.

### TR-08 — Rejudge và finality

Result ledger append-only; không UPDATE xóa kết quả gốc. Correction tạo version có `supersedesResultId`, lý do, approver và attempt evidence. Trước SEALED vòng có thể void/retry trận infra lỗi. Sau SEALED, phải pause, đánh dấu mọi round/stage phụ thuộc INVALIDATED, hủy uncommitted jobs, giữ committed descendants làm lịch sử non-counting, tạo revision lịch mới từ earliest affected round; đội được thông báo. Không sửa Swiss scores mà giữ pairings vòng sau rồi gọi là cùng giải hợp lệ. Elo rebuild từ epoch bị ảnh hưởng theo ledger snapshot; RR lịch không phụ thuộc điểm nên chỉ re-score, bracket/Swiss phải re-pair descendants. Finalized giải chỉ mở lại bằng explicit organizer action có audit, không tự sửa cúp theo background retry.

TR-09 — Round/epoch tự SEALED sau grace10phút tính từ lastTerminalAt nếu không blocker, tự next/rating; stage cuối PROVISIONAL, **chỉ ADMIN chốt**. `finalAppealWindowMinutes` integer0–10080,default1440, Admin pin trước registration; cho0 không có nghĩa auto-finalize. Deadline từ finalStageProvisionalAt; dispute trong giải gửi ngay. Không finalize còn window/open dispute/infra/integrity blocker;0 không bỏ dispute đã mở. Create-dispute/finalize transaction serialize; doubleclick receipt idempotent. Sau mở chỉ gia hạn có audit/thông báo, không rút ngắn. Restart không award; champion/NO_CHAMPION theo scoring; reopen theoTR-08.

## 6. Capacity, scheduling và trải nghiệm

| 500 đội | Encounters | Games tối thiểu | Games tối đa không hạ tầng retry |
|---|---:|---:|---:|
| Loại trực tiếp | 499 | 1.996 | 3.992 |
| Swiss 9 vòng + top16 | 2.265 | 4.560 | 4.620 |
| RR một lượt | 124.750 | 249.500 | 249.500 |
| Elo36epochs,500đội | 9.000 | 18.000 | 18.000 |

Swiss: 2.250×2 + 15×4 tối thiểu; playoff 15×8 tối đa. Retry infrastructure không bounded theo bảng này, tự động tối đa 3 attempts/job rồi BLOCKED. Model throughput dùng observed wall service time trong sandbox, không 100ms×300 CPU như thể đó là wall đã đo. RR 500 không bị bỏ khỏi scope: phải preview lượng việc, hoàn tất benchmark và provision đủ slots hoặc từ chối publish với giải thích; không nhận giải rồi hứa chạy vài ngày bằng một worker. Deadline thi đấu là mục tiêu lịch, không tự biến mọi pending thành thua khi hết thời gian.

Game chạy nhanh hơn tốc độ trình chiếu được phép; public nhãn phân biệt LIVE_COMPUTE, COMPLETED_REPLAY và scheduled presentation. Trình chiếu playlist riêng, không ẩn authoritative kết quả. Người xem tự theo dõi trận và standings có phiên bản, thời điểm cập nhật, provisional/final rõ ràng.

## 7. Invariants bắt buộc kiểm chứng

TR-01: đổi màu/map/seed đúng; GP-02: precedence, max-turn winner reasons; GP-03: reject invalid official map; TR-02: 500 bracket byes và finite ties; TR-03: 500 matching deterministic, bye/rematch declared, BH/SB tính lại; TR-04: mỗi pair đúng số lượt, mini-table non-recursive; TR-05: out-of-order results không đổi rating, eligibility chính xác; TR-06: deadline race + locked revision không đổi; TR-07: infrastructure không phạt đội, double startup failure; TR-08: late correction invalidate descendants, không double counting. QA chi tiết ở [05](05-SECURITY-OPERATIONS-QUALITY.md), tasks ở [kế hoạch](../../superpowers/plans/2026-10-13-production-upgrade.md).

## 8. Policy authority và ca nghiệm thu baseline

Ruleset manifest pin `ArenaAutoFormat/v1`, `ArenaSwiss/v2`, `ArenaElo/v1`, `ArenaEloPair/v1`, draw/seed encoding+solver versions, pool order/digests/commitment, runtime/profile và rule revision trước đăng ký; resolvedN/R/T/E và frozen artifacts ghi thêm ở lock, không sửa policy. Seeded bracket được định nghĩa bằng recursion S2=[1,2], S(2p)=concat([s,2p+1−s] cho s theo Sp); đặt rank>N/qualifiedCount thành EMPTY. Third-place default OFF; bật trước đăng ký thêm đúng1series4–8games giữa hai semifinal losers còn active, không thay champion; không đủ hai đội thì unplayed theoTR-07. Map pool≥4 cho mọi preset có knockout,≥1 cho RR/Elo; distinct map versions cho4slots knockout, không lặp một version để lách gate. Rules change sau mở phải giải mới theo01; correction dùngTR-08, không mutation lịch sử.

| Ca nghiệm thu (chưa chạy) | Kết quả bắt buộc |
|---|---|
| N2,3,4,5,10,16,500 | R/T/E đúng bảng trongTR-03/05; N0/1 không start; không overflow log/power/isqrt |
| N500 knockout, Swiss, RR, Elo không withdrawal/retry; không hạngba | 499series1996–3992games;2265encounters4560–4620games;124750encounters249500games;9000encounters18000games |
| Swiss odd field và withdrawal làm seed1,2,100,101 còn lại | Bye tuple chính xác; seedrange gốc giữ dominance; same-input solver cùng pairing; rematch chỉ optimum không tránh được |
| Swiss active count<T trước playoff vs withdrawal sau draw | Trước draw lấy top active/refill tớiT; sau draw giữEMPTY; không đổiT/R;0active NO_CHAMPION,1active theoTR-07 |
| Elo1200v1200 thắng cả2ván | S1→delta+16/−16, không+32; split2ván→0/0; đảo completion order không đổi rating |
| EloN3/E8 không withdrawal | Bye mỗi đội2hoặc3lần; ít nhất5rated encounters,2distinct opponents; RequiredRated không nhầm thành sốgame |
| Double startup failure/initial invalidboth; double withdrawal; infrastructure exhausted | Không áp seed tiebreak/điểm giả; EMPTY/NO_CHAMPION theoTR-07; infraBLOCKED không Bot loss/finalize |
| Custom disconnected/asymmetric/initial-terminal map; request>256KiB | Warnings không chặn fairness, initial result trướcTURN; schema/bounds/IPCcap vi phạm phải reject |
| Tất cả trận hòa; withdrawals; correction sau seal | BH/SB/mini-table đúng unplayed policy; tie-seed nhãn rõ; invalidate/rebuild descendants thay vì sửa điểm giữ pairing |

Các ca này là acceptance contract cho implementation/QA, không evidence capacity/security hiện có. Solver/draw implementation digests và test vectors phải được pin/chứng nhận trước release; thiếu chúng là technical gate, không quyền chọn thuật toán khác với baseline.
