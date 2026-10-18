# 05 — Bảo mật, vận hành và chất lượng production

> Trạng thái: **Baseline thiết kế chốt cho triển khai; chưa triển khai, benchmark, pentest hoặc chứng nhận release**. Ngày: 2026-10-14.
> Phạm vi: PR-01…PR-09 trong [01 — Yêu cầu sản phẩm](01-PRODUCT-REQUIREMENTS.md), một trường, mục tiêu500đội và rehearsal vận hành7ngày, khách public không login. Không hard clock-cutoff1–7ngày: giải kết thúc khi hoàn tất lịch/epochs và ADMINfinalize theo02. Chỉ đặc tả; không thay code/config/test.
> “Phải” là acceptance condition tương lai. Quota/resource/retention/SLO là **technical defaults do người thiết kế chọn**, không phải đo đạc hoặc xác nhận riêng của người dùng. Runtime evidence vẫn là release gate, không là quyết định thiết kế bỏ ngỏ.

## 1. Điểm xuất phát và ranh giới tin cậy

Audit tĩnh hiện tại chỉ ra runner gọi `spawn` trực tiếp, C++ compile đồng bộ không timeout, TypeScript có fallback `tsx`; timeout có nhánh so sánh wrapper/reject không đồng nhất; stdout buffer chưa bounded và kill chỉ nhắm PID con. Tham chiếu: `packages/runner/src/ipc-client.ts:65-146,174-212,356-375`. Scheduler và match state nằm trong RAM; ghi result/rating/replay chưa có commit nguyên tử/idempotent: `packages/server/src/tournament-service.ts:205-345`, `packages/server/src/match-service.ts:133-138`, `packages/server/src/db.ts:416-505`. Đây là bằng chứng thiếu kiểm soát trong đường chạy, **không phải bằng chứng đã khai thác** hay benchmark toàn deployment. README hiện giới hạn trusted bots; không được coi container của toàn ứng dụng là sandbox từng Bot.

Threat model: sinh viên/tài khoản bị chiếm gửi source độc hại; compiler/parser/runtime có lỗ hổng; khách overload HTTP/WS; nội gián lạm quyền; process/API/storage/host dừng hoặc disk mất; artifact/result bị thay thế; ONLINE mail unavailable. Bảo vệ source/PII/secrets, CPU fairness và authoritative ledger; gVisor giảm attack surface, không chứng minh chống mọi escape. Một physicalhost nghĩa là kernel/root compromise có thể ảnh hưởng toàn deployment; backup là recovery, không isolation/HA node.

| ID | Ranh giới bắt buộc | Điều kiện chấp nhận |
|---|---|---|
| SEC-01 | API không chạy code/compiler đội | API process không runtime socket/capabilities/privileged launcher; chỉ metadata/source/job operations. Dedicated supervisor trên cùnghost quản lý sandbox, không chuyển quyền launch cho API |
| SEC-02 | Execution resource domain riêng cùng máyLinux | Supervisor/build/match không cùngAPIprocess; sandbox khôngAPI/DBsecrets/mounts/capabilities; cgroupreserve/admission phải chứng nhận, không remotehost/VM prerequisite |
| SEC-03 | Mỗi compile job và mỗi Bot runtime có sandbox riêng | Không sandbox chung cho hai đối thủ; không reuse writable workspace giữa submission, đội, attempt hoặc game |
| SEC-04 | Chỉ trusted supervisor điều phối IPC/result | Bot không truy cập queue, DB, result writer, opponent source, spectator socket hay key của worker; launcher chỉ nhận job manifest hợp lệ, không arbitrary host command |

Supervisor chạy UID riêng và nối broker UDS `/run/oantuti/broker.sock`; filesystem ACL + `SO_PEERCRED`, không remote credential/certificate/network worker listener. Broker cấp operation grant15phút bind job/attempt/fence/generation/allowedkeys; renew chỉ khi lease healthy, revoke khi quarantine/generation đổi. Sandbox không nhận grant/socket/secret. Privileged launcher chỉ nhận verified manifest và fixed runsc actions, không arbitrary command, API không launcher capability/Docker socket.

## 2. Sandbox build và runtime

### 2.1. Mặc định gVisor và readiness fail-closed

Baseline hỗ trợ được chọn: **Ubuntu Server24.04LTS amd64, GA Linux6.8 line, systemd/cgroupv2, PostgreSQL16, gVisor/runsc** trên một physicalhost. Không orchestration/cluster/remote worker/standby bắt buộc. Exact patches/toolchains/runtime/images/SDK pin bằng release BOM ở§7.4. Đây là lựa chọn target chưa có compatibility/security/support validation; Python/compiledTypeScript/C++20 phải được chứng nhận riêng, unsupported/BOM mismatch thì fail closed.

Worker chỉ `READY` sau khi kiểm tra thật: đúng runsc đang chạy (không chỉ tên runtime trong config), cgroup delegation/CPU/memory/PID limits có hiệu lực, freezer hoạt động, network-deny, readonly mount, writable quota, non-root, kill toàn sandbox và counter CPU đọc được. Chạy canary negative tests trong sandbox không chứa secret ở startup và sau cập nhật runtime/kernel/image. Periodic canary mỗi 5 phút; nếu thất bại, ngừng claim ngay, cách ly node và drain/stop các attempt theo mức nguy hiểm. Mất isolation là sự cố bảo mật, không “degraded mode” cho code không tin cậy.

- Không có gVisor, mount/cgroup thiếu hoặc canary sai → execution readiness false, job ở hàng đợi, cảnh báo; **không fallback sang runc/native spawn/trusted mode**.
- Liveness chỉ báo supervisor còn hoạt động; readiness báo khả năng nhận đúng loại job. API public có thể tiếp tục đọc khi execution plane không ready, nhưng báo trạng thái degraded và không hứa thời gian hoàn tất.

**LAN offline không biến code sinh viên thành trusted.** Cùng physicalhost nhưng supervisor/launcher và mỗi Bot có process/UID/cgroup/namespace boundary; không mặc định executionVM/host thứhai. Không API/DB secrets trong sandbox, không native fallback. Chứng nhận contention/limits theo hardware thật, không hứa500teams. WAN deny triển khai router/firewall/client theo perimeter input; kiểm host+client deny Internet, cold browser assets/editor/import/build/test/replay/start/finalize offline. Không tuyên bố chặn AIlocal/4G hay thêm surveillance.

**Một máy Linux cho LAN và ONLINE đã duyệt.** Local PostgreSQL/storage durable+idempotentacceptance, backupngoàihost, khôngstandby/replication/HA prerequisite. Processrestart/diskintact recoveracceptedledger; diskloss restoreconsistentbackup, khôngzero-loss. Sandbox/cgroup/accounting/capacity vẫn bắtbuộc. Backuphash/inventory/restoreproof/lastsuccess/data-at-risk và RPO/RTOtarget ở§6 là acceptancegate tương lai, không claim đãđạt.

- Mọi sandbox: UID/GID không-root độc lập, capabilities rỗng, `no_new_privileges`, read-only rootfs và artifact/SDK mounts; không host mount ngoài allowlist, không host PID/IPC/network, không devices; policy syscall tương thích runsc, hạn chế ptrace/mount và nested namespace.
- Sandbox offline khôngDNS/egress/package registry; chỉ thư viện chuẩn+SDK+tệp dự án. Multi-file source/ZIP phải normalize paths, reject absolute/.. traversal/symlink/hardlink/devices/encrypted/nested archives/duplicate hoặc case-fold path collisions; cap entrycount/expandedbytes/filebytes và extractiontime trước allocation/write. Không userbuildscripts/Makefile/arbitrarycommands. Draft/test snapshots cũng code không tin cậy, sandbox/quotas như official.
- `/tmp` riêng, `nosuid,nodev,noexec` nếu toolchain không cần execution tại đó; chỉ thư mục build output được cấp execution phù hợp. Quota thực thi được, không chỉ đếm sau job. Không đọc `/proc` của host hay đối thủ.
- Chấm dứt toàn cgroup/sandbox, đợi xác nhận zero descendants, unmount/xóa workspace. Cleanup không thành công → quarantine node, không cấp lại slot. Dùng `finally` mọi đường lifecycle, kể cả init đối thủ hoặc serializer thất bại.

### 2.2. Profile tài nguyên mặc định, bất biến trong giải

Đơn vị KiB/MiB/GiB là nhị phân. Giới hạn áp dụng cả descendants và threads; supervisor và API có resource pool riêng, không tính vào quota Bot. Manifest ghi profile revision; thay profile chỉ ở revision/giải mới, không bí mật tăng timeout cho một đội.

| Tài nguyên | Compile sandbox, mỗi job | Runtime sandbox, mỗi Bot mỗi game |
|---|---|---|
| Project source |128regularfiles,256KiB/file,4MiBexpanded,ZIP2MiB; pinned manifest/entrypoint/build pipeline|Immutable artifact/project digest, không rebuild trong turn|
| CPU aggregate | 10.000 ms CPU/job, tối đa 1 core entitlement | 100 ms CPU/active turn; tối đa 1 core entitlement |
| Wall safety | 30.000 ms/job kể từ sandbox start | Startup 1.000 ms; mỗi active turn 1.000 ms |
| Startup CPU | Nằm trong budget compile | 500 ms CPU/startup, không chuyển dư sang turn |
| Memory hard limit, swap | 1 GiB, swap 0 | 256 MiB, swap 0 |
| Tasks/PIDs, gồm threads | 64 | 32 |
| Writable ephemeral storage | 512 MiB | 16 MiB |
| Artifact được nhận | Tổng tối đa 64 MiB; chỉ regular files theo allowlist | Read-only, không rebuild |
| stdout/diagnostic | Tổng stdout + stderr 1 MiB/job | Response NDJSON tối đa 16 KiB/dòng; stdout tối đa 1 MiB/game/Bot |
| stderr/log riêng | Trong cap 1 MiB/job | Lưu tối đa 64 KiB/game/Bot; tổng output stdout + stderr tối đa 2 MiB/game/Bot |
| Open file descriptors | 128 | 64 |
| Network | Không | Không |

Stderr vượt 64 KiB thì truncate phần **lưu** và đánh dấu rõ, tiếp tục drain trong cap tổng 2 MiB; vượt cap tổng hoặc stdout cap là `OUTPUT_LIMIT`, kết thúc Bot. Không đợi newline để áp cap. Đo bytes UTF-8 thực, không string length; collector/parser có bounded buffer riêng và không để Bot backpressure làm treo supervisor. Public replay không chứa diagnostics này.

Compile limit/invalid source là submission `REJECTED` có nguyên nhân, không trận thua. Toolchain missing, storage lỗi, sandbox launch lỗi là lỗi hạ tầng; không diễn giải thành compile error của sinh viên. Build key gồm source SHA-256, SDK, compiler image, flags và target/runtime digest; cache hit phải verify checksum/provenance. TypeScript compile một lần ở build sandbox, không `npx tsx` trong match. Không cho đường dẫn executable tùy ý từ request.

### 2.3. Chính sách thời gian, suspend và kiểm chứng tính thực dụng

**100 ms là CPU budget, không phải wall.** Không bank giữa lượt. CPUaggregate user/system toànworkload/descendants/threads và overhead profile côngbố. Authority chọn delta `cpu.stat usage_usec` cgroupperBot bao toànrunscworkload; sentry/gofer/helpers đúngcgroup, supervisor/counter/watchdog ngoài. Không innerPID riêng. Readiness chứng minh semantics/overhead pinnedplatform; counter không kiểm chứng được thì notready, không wall-onlyfallback.

Trình tự bắt buộc:

1. Sandbox khởi chạy; startup wall bắt đầu trước launch và kết thúc khi nhận `READY` hợp lệ. Startup CPU 500 ms độc lập; wall 1.000 ms bao cả launch/runtime init. Hai Bot chuẩn bị riêng và freeze ngay khi READY; không cho Bot thứ hai ponder khi đợi Bot thứ nhất. Image pull/cache warming ở readiness, không trong slot startup.
2. INIT/TURNv2 mỗi dòng≤256KiBUTF8; `pieceCount≤validCellCount≤4096`, throne có thể bị quân chiếm theo02 (không cap4094 giả throne trống). Kiểm serializedsize trướcjob, response≤16KiB. Encode privateboundedbuffer trướcunfreeze, rồi CPU/wall cùngnonblockingwrite/read, không yêu cầu pipe chứa256KiB khi frozen. IPCoverhead tính/côngbố; no drainstdin watchdog vẫnfinite. Map/request vượtcap lỗi schema/profile khôngBotthua; readiness kiểm large-map no deadlock.
3. CPU tính từ unfreeze đến freeze xác nhận sau response; đúng requestId/game/turn, duy nhất một JSON response, integer/range và luật hợp lệ. Unsolicited/stale/multiple response là protocol lỗi, không queue qua lượt sau.
4. Sau response hoặc limit, freeze trước evaluate/commit. Inactive Bot suspend cả sandbox, không ponder. Budget INIT/TURN khớp actual enforcement; request encode/privatebuffer không tính CPU Bot nhưng transfer sau unfreeze có accounting.
5. **Dedicated Rust OS watchdog thread** độc lập Rust native runner và async upload/parser theo dõi CPU/wall, không await engine. CPU>100.000µs là CPU_TIMEOUT; wall≥1000ms chưa response hợp lệ là WALL_TIMEOUT; không gameplay grace. Rust không tạo hard-real-time; OS counter/freezer là authority. Host reaper ngoài supervisor kill sandbox khi supervisorSIGKILL/lease mất; destructor không đủ.

Sampling có thể gây overshoot; target kiểm chứng là polling tối đa 1 ms và overshoot CPU p99 <=5 ms trên tải được admission cho phép. Phần overshoot không được coi là allowance và response đã dùng >100 ms không hợp lệ. Đây **không phải bảo đảm hard-real-time**. Nếu cannot freeze/account/enforce chính xác ở ngưỡng này, G1 không đạt: tối ưu thiết kế hoặc sửa profile có phê duyệt trước giải, không quảng cáo 100 ms chính xác.

Phải benchmark cả cold/warm startup, Python/Node JIT/C++ SDK, syscall-heavy, multithread/fork, full request trên map lớn nhất, idle sleep, silent bot và CPU busy loop dưới tải mixed. gVisor startup và Node memory có thể không phù hợp 1.000 ms/256 MiB; đây là rủi ro cần đo, không lời hứa. Chứng nhận starter/reference bot hợp lệ cho cả ba ngôn ngữ và cung cấp local harness cùng profile. SDK parsing và init semantics phải parity, đặc biệt initial pieces C++.

Wall safety chống sleep/IPC hang, không đo năng lực thuật toán. Scheduler starvation/throttle, collector stall hoặc mất counter xác nhận bằng supervisor/host evidence → infra, không Botforfeit. Bằng chứng không đủ phân biệt → UNRESOLVED_INFRA. Bot sleep khi worker khỏe → WALL_TIMEOUT. Default300ply: CPUturn≤30s +startup≤1sCPU hai Bot; watchdog game330s bao launch/turn/IPC allowance, hết hạn là executioninfra không tự gán thua. Persistence/delivery pending không thuộc compute watchdog. Ruleset khác300ply cần versioned derived profile trước publish.

## 3. Lỗi Bot, retry hạ tầng và tính toàn vẹn kết quả

| Loại | Ví dụ có evidence | Hành động |
|---|---|---|
| Bot forfeit | CPU/wall/startup timeout trên worker khỏe; illegal move; crash/exit; OOM/PID/output cap đúng sandbox; sai protocol | Commit kết quả theo luật với reason/profile/counter; không tự retry để tìm một lần Bot thắng |
| Submission lỗi | Syntax/compile error hoặc vượt build cap trên worker khỏe | REJECTED, diagnostics riêng đã lọc; không thay entry đang READY |
| Infrastructure | Node mất, lease hết, storage unavailable, image/toolchain missing, launcher lỗi, emergency stop, counter/freezer lỗi, host OOM ngoài sandbox | Attempt thất bại hạ tầng; không điểm/rating/phạt đội; requeue job hoặc pause |
| Không xác định | Mất evidence, kernel anomaly, tranh chấp counter | UNRESOLVED_INFRA; không kết quả official cho tới xử lý |

Infrastructure retry tốiđa3attempts tổng,backoff5/15s,cùngpinnedinputs; khôngretry lỗiBot hoặcrestore process từreplay. Singlehost worker/readiness sai phảiquarantineexecutionpool/pauseclaim, chỉresume sauhealthyproof; noothernode prerequisite. Infra≥5%/≥20attempts/5min hoặc isolationcanary failure pausepool; exhausted BLOCKED,khôngcancelgiải/phạtđội. Diskloss dùngrestorebackup khôngcompute retry cheacceptedloss.

Resultauthority theo single-hostAR-02: validfence→prepareCompletion durablepin→fsync/atomicpromote immutableevidence→PostgreSQL durabletransaction acceptedresult/replaymetadata/outbox; public/rating/reducer chỉsauacceptedcommit. Duplicate/lostackdelivery khôngdouble-score; stalefence denied. Khôngreplication/WAL-LSNpublicationbarrier hoặc second-store. Encounterterminal/unplayedexceptions02giữnguyên; diskdisasterbackup khác computationretry.

Ledger append-only ghi accepted result, superseding/void/rejudge events và reason/operator. Không `UPDATE` đè lịch sử để sửa điểm. Standings/rating/bracket là projection dựng lại theo ordering và revision, không nguồn thật. Public standings/live/replay theo visibility giải, **không theo projectedIndex hay trạng thái tab/máy chiếu**. Projection chỉ là playlist trình bày.

## 4. Danh tính, quyền, secret và phân vùng public/private

### 4.1. Auth production

- **ONLINE** email verified trước login; PENDING_EMAIL không session. Verification/reset tokens random/hash/purpose-bound/expiry/one-use, outbox/rate-limit, reset revoke sessions, không auto-activate pending. **LAN** theo profile ngoại lệ dưới, không dùng SMTP. Không MFA; emailchange ONLINE cần re-auth+verifynew+notifyold. Mode do deployment config không request quyết.
- LANADMIN cấp STUDENT accounts với **mật khẩu tạm random riêng, đổi lần đầu bắt buộc đã duyệt**; limited session chỉ passwordchange/logout, khôngteam/upload/privatequeries. Accountstatus ADMIN_ISSUED khôngfakeemailverified; noSMTP/selfregister. Adminreset one-time/revoke sessions+limitedsession/audit không xem mật khẩu cũ. Deploymentauthprofile immutable, ONLINE gate khôngbypass. accountCapacity/maxTeams Adminchốt, enforce transaction khi bulkcreate/register/join; không giảm dướiusage hoặcsilentexclude. Mật khẩu thô chỉ delivery riêng một lần, khônglog/plaintextpersist/defaultchung.
- **Không MFA/SSO cho mọi vai trò.** ONLINE emailverified+password; LAN ADMIN-issued/localbootstrap+password. Recentpasswordre-auth≤10phút cho start/finalize/correction/exportprivate/emailchange. Không recoverycodes/securityquestions. Credential/hộp thư bịchiếm không cófactorđộclập, không gọi tươngđươngMFA. Passwordhash Argon2id m=64MiB,t=3,p=1, randomsalt≥16bytes; password12–128Unicodecharacters, cho paste/passwordmanager, khôngtrimsilent/forcedperiodicrotation; hashworkadmissionbounded. Verifytoken32randombytes/24h, reset32randombytes/30min, hashstored/purposebound/oneuseatomic, resendrotatesold. LANtemporarycredential≥128bitentropy, expiry24h và oneuse first-change. Khôngplaintextpersist/log; weak/knowncompromisedpassword blocklist bundleoffline. Hashcost benchmark trước release để khôngDoSAPI.
- Chỉ một ADMIN tồn tại kể cả pending/disabled; DBsingleton và idempotent bootstrap không defaultpassword/APIpromote/inviteadmin. ONLINE bootstrap emailverify/password; LAN local-console bootstrap/password LOCAL_BOOTSTRAP không email. Recovery/đổi người dùng§7.2, giữ cùng singleton account, audit/revoke, không admin thứhai.
- Session opaque random/revocable DB; cookie Secure/HttpOnly/SameSite=Lax/host-only. Idle12h, absolute7ngày; ADMIN absolute12h. Logout/reset/disable/role change revoke; permission recheck trên mỗi private request/subscription, không chỉ JWTcachedscope.
- HTTPS bắt buộc **cả LAN và ONLINE**: ONLINE valid public cert/domain; LAN offline local CA/cert với SAN đúng hostname, trust provisioning trước dùng. Exact origin mutation/WS +sessionCSRF; public auth endpoints theo03 không yêu cầu session chưa tồn tại. Không wildcard credential CORS/conditional insecure production cookie. LANtrustfailure là deploymentblocker, không tắt TLScheck. PrivateWS reauthorize khi revoke.
- ADMIN/STUDENT; một ADMIN duy nhất là người tổ chức chung, quản lý mọi giải. Publicregister luôn STUDENT; không role tự khai, promote/invite-admin/lecturerassignment. Emailverification không cấp role. Không MFA/SSO; giữ serverauthorization/audit/re-auth.
- Mã chung chỉ **ONLINE**, admissionsecret không loginidentity, POSTbody/redact/no publicDTO/log/query; verifier/CSPRNG/rate-limit và scope/window/capacity nguyên tử, rotate khôngkick admittedteams. **LAN** Admin direct-enroll đội đã phân, không mã; actor ADMIN, profile LAN, roster/capacity/uniquemembership checks và audit bắtbuộc. Student không gọi direct-enroll hoặc gửi mode=LAN để bypass mã ONLINE.

### 4.2. Scope và dữ liệu

ADMIN duy nhất quản lý mọi giải và được đọc source/log bài nộp của mọi đội; STUDENT chỉ đội mình/admission đúng mã, khách không source/log. Kiểm quyền server xuyên HTTP/download/export; private no-store, không public cache hoặc live/replay payload. ADMIN không sửa source/đổi frozen artifact/giả danh đội. Audit đọc/tải ghi actor,submission/version,target,time,requestId, không ghi nội dung source/log vào audit. Draft chưa nộp/local không thuộc quyền đọc này.

PublicDTO khôngsource/log/testsnapshot/PII/secret. TESTprivate xuyênHTTP/WS/replay/storage/cache/export, khôngdiscovery/officialreducers/rating. ADMIN đọc bàiđãnộp không mặc nhiên đọc draft/testchưanộp. Private no-store, tokenizeddownload≤5min/reauthorize hoặc APIproxy03. TESTretention7ngày theo§4.3, holds thắngTTL.

Escape tên/announcement/diagnostic, không raw HTML. CSP phù hợp, safe download MIME/disposition, avatar decode/re-encode và cap size; không fetch URL avatar tùy ý từ server. Source editor/replay decoder không có quyền thực thi Bot; parser có size/length bounds, checksum/version và reject invalid/trailing bytes theo hợp đồng v2.

### 4.3. Secrets, quota, audit và lưu giữ

Secrets lưu root-owned `/etc/oantuti/credentials/` mode0700, từng file0400/0600, systemd credential delivery chỉ đúng service; encrypted off-host recovery copy, không repo/image/BOM/log. Default không external secret manager. App DB role khôngsuperuser/DDL; migrator riêng chỉ lúc maintenance, backup role riêng tốithiểu. Broker/reconciler có object write/promotion qua module; supervisor chỉ grant keys, Bot không ambient env/cloud/home credentials. Rotation dùng keyId/current+previous decrypt-only trong bounded migration window, revoke compromised keys ngay; verify old evidence decrypt/restore trước retire, không mất private backups vì xóa key sớm.

Quota mặc định **theo team+tournament**:10official submissions/rollinghour,100/UTCday,2compile pending/running; không practice. TEST2pending/running,30games/UTCday,10create requests/rollingminute (failed auth/validation không tạo game nhưng rate-limit vẫn tính). Shared buildpool không vượt2compile/team; official có reserved capacity. Idempotent retry không doubleconsume; quota reservation consume atomically khi enqueue, infrastructure retries không tính thêm submission/testgame. Không phase/deadline gate cho TEST; archived profile unavailable503 rõ, không fallback.

Auth10failed/account/15min,30/IP/15min; reset3/account/hour,20/IP/hour; public120requests/IP/min và20WS/IP. Publicdefaults cần NATworkload gate, chỉ đổi bằng deployment revision/audit trước go-live; không tin arbitrary X-Forwarded-For, trustedproxy exactallowlist.429+Retry-After, bounded counters, uniform auth/reset response tránh enumeration. Submissionquota500×100=50000build/day và test500×30=15000games/day là upperdemand chưa đo.

Audit append-only actor/scope/action/target/revision/time/reason/requestId+before/aftermetadata; cả denied sensitive actions, không source/secrets. DBpermissions cấm app sửa/xóa audit trong retention; hostroot vẫn là trust boundary, off-host backup giữ evidence. Retention mặc định: operational logs30ngày; private diagnostics30ngày sau finalize; TEST snapshots/results/replay/log7ngày từ terminal (abandoned staging24h nếu khôngjobref); security/admin audit1năm; official source/private evidence90ngày sau finalize; official ledger/replay ít nhất1năm; backup35ngày. Active/nonfinalized records không TTL từ creation giả finalize; hold dispute/security/legal chặn purge cả references/keys/backup expiry khi liên quan. Policy notice/consent trường là operator input trước registration; không tùy ý kéo dài source retention ngoài policy đã công bố. Backup purge theo expiry, không hứa xóa tức thì immutable copies.

## 5. Capacity, SLO và observability

### 5.1. Tính tải, không suy từ số sockets

E là encounters; Swiss/RR/Elo2games/encounter; knockout4–8games/series. Tính thêm infrastructure retries và compile/validation riêng, **không tải luyện tập**. Bye/walkover không game thực; admission theo game tối đa.

| Preset, 500 đội đủ lượt | Encounters | Games min–max, chưa infra retry | CPU turn-bound ở 300 ply × 100 ms | Wall-safety slot-hours ở 300 s/game |
|---|---:|---:|---:|---:|
| Single elimination, không hạng ba | 499 | 1.996–3.992 | 16,63–33,27 core-hours | 166,33–332,67 |
| Swiss 9 vòng + top16 playoff | 2.250 + 15 = 2.265 | 4.560–4.620 | 38,00–38,50 core-hours | 380,00–385,00 |
| Round robin một lượt encounters | 124.750 | 249.500 | 2.079,17 core-hours | 20.791,67 |
|Elo liên tục, E epochs với500đội|250E|500E|4,17E core-hours|41,67E slot-hours|

RR đã duyệt cố định một lượt gồm2ván đổi bên/cặp; không doubleRR. Swiss500=2250×2+15×(4–8). Knockout hòa hết8ván dùngseedpriority, không chạy vôhạn; trận hạngba nếuđượcduyệt cộng4–8ván. CPUcolumn chỉactive turns, wallsafety khôngservice time đãđo.

Elo tựtính E từNlocked theo02, cốđịnh trướcstart. Capacity khôngtựthayE; phải chứng minhresources/ETA hoặc BLOCKED_CAPACITY.500đội→250Eencounters/500Egames, E36→9000cặp/18000ván chưaretry. Khôngfixed4đợt/ngày/14000ván/7ngày. Submissionupperdemand50000build/day tính riêng.

ETA từ measured service distribution/simulation và certified reservedslots, cộng pairing/IO/retries/roundsealgrace/outageheadroom; không replication. Sau lock chốt baselineDuration, trước ADMINstart không autostart; actualstartedAt+duration là estimatedCompetitionEndsAt, liveETA riêng córeason. EarliestFinalizationAt=finalStageProvisionalAt+configuredfinalAppealWindowMinutes theo02 (default1440,max10080,cho0), finalizedAt cần ADMIN/disputes resolution nên không exactpromise. Thiếu/stalebenchmark chặn start; không giảmE/cắttrận.

RAM floor runtime khoảng `C×2×256 MiB` cộng sentry/gofer/engine/collector overhead, OS và headroom; build concurrency `B` cộng `B×1 GiB` và overhead. CPU/IO pool cho compiler độc lập. Disk/network dùng kích thước artifact/replay/log và rates **đo được**; bounded retention và storage alert. 1.000 viewers mỗi 60 delta/s ở giả định payload 200 bytes → 12 MB/s (~96 Mbit/s) payload nếu cùng stream; chưa TLS/WS framing, snapshots, catch-up, replay downloads và fanout multi-match. Gameplay không buộc chạy 60 turns/s; animation và batching không sửa result.

Capacitywizard phải gồm compileofficial/tests và TEST_GAMEmixedload; reservedAPI/DB/scheduler/officialslots, testadmissionbounded thấp hơnofficial. Thiếubenchmark/resources BLOCKED_CAPACITY, khôngsilentformatchange; test cóthểqueue/deny429/503 rõ ràng,khôngsteal officialcapacity. Security incidentstopall.

### 5.2. SLO mục tiêu

Các target đo tại môi trường được capacity admission, rolling 7 ngày trong giải; lỗi thật bao gồm maintenance ảnh hưởng người dùng. Synthetic probes chạy ngoài host/load-generator chính. Publish cả denominator/sample count, p50/p95/p99 và cửa sổ; không lấy average để che tail.

| ID | Target baseline cần chứng nhận | Cách đo |
|---|---|---|
| OPS-01 | Public reads/authenticated control plane availability >=99,9% | Probe HTTP + anonymous deep-link hành trình, tách dependency failure |
| OPS-02 | Public standings/match metadata HTTP p95 <=300 ms, p99 <=1 s | Load distribution thực, không tính browser cache hit là API latency |
| OPS-03 | Accepted-result tới public standings p95 <=2 s, p99 <=5 s | Correlate ledger/outbox/read-model revision; không chờ máy chiếu |
| OPS-04 | Live delta commit tới client receipt p95 <=500 ms, p99 <=2 s | Event sequence/timestamp, clock skew report; separate server enqueue/network/render |
| OPS-05 | Infrastructure attempt failure <0,5% | Chỉ trusted classification; Bot forfeits không tính vào numerator |
| OPS-06 | Normal official ready-job queue age p95 <=30 s, p99 <=120 s | Không gồm round barrier intentional, ghi riêng waiting reason |
| OPS-07 | Submission validate/build/smoke READY hoặc REJECTED p95 <=60 s, p99 <=180 s tại deadline burst được duyệt | Upload commit tới terminal status; infra retry/BLOCKED tách rõ |
| OPS-08 | RPO <=5 phút, RTO <=30 phút | Restore rehearsal từ ngoài deployment, đối chiếu ledger và manifest, không chỉ boot app |

1000 viewers là mục tiêu validation không điều kiện chắc chắn đạt. WS cap canonical **1 MiB pending/client** theo03; vượt cap disconnect/catch-up từ sequence, không chặn match. Active frame RAM có cap và eviction; archived replay lấy storage không giữ mãi trong Map. Mọi sequence gap/duplicate được test; drop client không drop authoritative actions.

### 5.3. Telemetry và alert

Structured logs/traces correlate `requestId`, tournament/round/encounter/game/job/attempt/fencing token, profile revision và worker ID; không ghi source, password, cookie, email, request body chứa code hoặc raw stdout. IDs không làm metric label cardinality vô hạn; metrics dùng pool/language/reason/status, logs/traces tra chi tiết.

Dashboard: queue count/oldest age theo pool, capacity/lease health, CPU active turn vs wall/overshoot, cgroup throttling/OOM/PIDs/output, sandbox startup/freeze/cleanup, build/cache timings, attempt/retry/forfeit reasons, DB commit latency/locks, ledger-to-read-model lag, outbox age, replay checksum/orphans, WS connections/backpressure/gaps, disk/object retention, backup last-success/WAL lag và cert expiry.

P1 page ngay: isolation fail; stalefence accepted; ledger/replay checksum sai/duplicate scoring/missing acceptedrecord; backup consistentage>5min; authbypass/secret suspicion. Queue oldest>120s/5min; infra≥5% trong≥20attempts/5min; DBunavailable>1min; RAM/disk>80%warning/>90%page; cert<14days warning/<7days page; outbox oldest>5s/1min page. Page phải có delivery acknowledgement≤5min qua ONLINEpager hoặc LANlocalaudible/console+operator tại chỗ, escalation contact nếu khôngack; không phụ thuộc email/LANInternet hoặc tác giảcode thức trực. Runbook owner/exit bên dưới.

## 6. Backup, phục hồi và bảo vệ authoritative ledger

RPO≤5min/RTO≤30min là **acceptance targets cần drill trên actualhardware**, không HA/no-lossguarantee. Authority là PostgreSQL+local immutableobjects. LAN dùng off-host removablemedia luôn mounted khi giải hoạt động (hoặc dedicated backupstorage không serving); ONLINE dùng configured off-host backuptransport. Thư mục khác cùng host/disk không đạt. Một offline drive chỉ cắm cuối ngày không đáp ứng5min: preflight/start blocked đến khi có pipeline đạt target.

- Local acceptance PostgreSQL `fsync=on`, `full_page_writes=on`, `synchronous_commit=on`, data checksums bật khi init; local filesystem ext4 với barriers và storageflush được xác thực (không NFS/tempfs/unsafe writecache). Source/artifact/evidence staging+destination cùngfilesystem, fsyncfile→atomicrename→fsyncparent trước DBreceipt/acceptedcommit. Permissions broker-only; missing/corruptobject là integrityincident, không dựng replay giả. Khôngstandby/replication/LSNpublicationbarrier.
- Backup mỗi24h physicalbasebackup bằng PostgreSQLbackupprotocol, continuousWALarchive (`archive_timeout=60s` target), verifiedchain. Coordinator mỗi≤60s tạo checkpoint: acquire ngắn global **object-reference mutation barrier** (mọi transaction tạo/xóa reference, source/testreceipt, acceptedresult và GC đều tuân thủ), drain in-flight referencewriters; mở repeatable-readinventorysnapshot, ghi namedPGrestorepoint+LSN/time khi referencewrites vẫnblocked, rồi releasebarrier ngay. Snapshot inventory toàn referencedobject digests/lengths/holds cùngrestorepoint không thể bỏ objectcommit giữa snapshot và WALtarget; readonly/publictraffic tiếp tục, barrierbound1s, vượt thì abortcheckpoint+alert không dropmutation. Snapshot-pinned references chốngGC đến copycommit. Copy required basebackup+WAL và immutableobjects off-host, hashverify rồi atomicpublish encryptedmanifest gồm restorepoint/BOM/schema/generation/keyIDs **chỉ khi đủ tất cả**. Accepted sau barrier thuộc checkpointtiếp. WAL-LSN chỉ backuprecovery, không publicationbarrier; không rawlivePGdirectorycopy/DB-onlybackup.
- `lastSuccessfulConsistentCheckpointAt` là restorepointtime của manifest đã off-hostverified, không jobstartedAt/copyendAt. Data-at-risk = now−checkpointtime; cadence≤60s để hoàn tất trước5min không là guarantee. Backuplag>5min page+stop new execution/admission/privatewrites và holdfinalize; đang chạy attempts stopinfra, preserve spool/evidence; public readonly. Không âm thầm tiếp tục tích lũy risk hoặc compute lại acceptedgames. Resume chỉ sau healthy verifiedcheckpoint+ownerack.
- Retain backup35ngày, tốithiểu một verifiedbase+continuousWAL+objects để restore từng retainedcheckpoint; không prune chain hoặc referencedkeys sớm. Encryption at rest/in transit tới remote, riêng encrypteddrive LAN; backupcredentials không trong Bot/API và restorekeys có bản sealed offline. Weekly restorecheck sample+hash; full restore trước mùa/upgrade và mỗi tháng trong vận hành, ghi actualRPO/RTO không chỉ bootapp.
- Restore owner Operator: maintenance/stopallwrites+claims, preserve damageddisk/evidence; restore selected completebase/WAL/manifestobjects vào clean replacement baseline (không parallel live scheduler); compare counts/digests/acceptedreceipts/frozenentries/holds. Tăng deploymentgeneration, invalidate grants/leases, cleanup old cgroups, rebuild projections/rating theo acceptedledger, chỉ requeueunacceptedjobs. Reauthorize sessions/tokenrevocation sau incident; private/public smoke evidence, readinesscanaries/capacity rồi ADMINexplicitresume. Lostrecords sau checkpoint báo công khai extent/time và private đội liên quan, không che bằng recompute.
- Drill processkill/diskfull/storageunavailable/corruptbackup/missingkeys/replacementhost. RTO tính incidentdeclaration đến validatedservice resume bao provision/keyretrieve, không loại human wait; RPO actual newestcompletecheckpoint, report mọi data-loss. Không giả luôn có sparehost/hardware đủ nhanh; targetfail chặn release/start. Restore/corruption unresolved chặn finalize.

## 7. Rollout, runbook và gates review

### 7.1. Cutover có thể đảo triển khai, không đảo dữ liệu tùy tiện

Chốt deployment bill of materials, profile/rules/runtime digests và policy trước go-live. Migration thử trên bản sao dữ liệu thật đã redacted; giữ V1 replay/rules để đọc archive, metadata revision thiếu phải ghi `LEGACY_UNVERIFIED`, không lấy current Bot để giả provenance. Chuyển tất cả public paths khỏi projection-as-publication, không để policy cũ song song làm ẩn/lộ không nhất quán.

Rollout: staging cùngbaseline→internaladversarialcanary→unratedrehearsal→single-supervisorcanarypool cùnghost→production trướcregistration. Expand/migrate/contract cho compatible rollback, backup/restoreproof trướcdeploy. Không đổi engine/rules/compiler giữa lockedgiải; criticalpatch cầnpause/impactassessment/revision/rejudge/audit/notice. Rollbackbinary chỉ schema/event/provenancecompatible, khôngrestoreoldDB làm mấtacceptedwrites đểrollbackUI.

### 7.2. Runbooks phải có owner, trigger, thao tác và exit criteria

Mỗi incident có incidentId/timeline/requestIds/private evidence và operator on-call là đầu mối, ADMIN quyết định giải, security reviewer quyết định isolation/integrity clearance. “Verify” là bước vận hành tương lai phải lưu evidence, không đã chạy trong docs-only.

| Incident / trigger | Owner và hành động | Verify / exit criteria |
|---|---|---|
| Supervisor chết / lease30s expired, heartbeat5s mất | Operator: stopclaims; reconciler10s fence generation/attempt; hostreaper kill oldcgroups; recover pinnedCOMPLETION_PENDING trước requeue unaccepted pinnedinput,3attempts5/15s | Zero descendants/oldgrant denied; canonicalreceipt khôngdoubleaccept; startupcanariespass; Operatorresume, exhaustedBLOCKED cần ADMIN xử lý |
| Bot hang/output/fork/memory/PID limit | Supervisor auto boundedkill/freezefinalcounters/private diagnostics; Operator điều tra nếucleanupfail | Counter+healthyhost phân biệt Botlimit/infra; zerodescendants/slotclean; lỗi cleanup quarantine pool đến canarypass, không retryBotforfeit |
| Isolationcanary fail (startup/5min), escape/authbypass/secret suspicion | Operator emergency stopall, isolate execution/network, revoke grants/sessions/compromisedkeys; securityreviewer preserve private forensic evidence/scope leak; ADMINnotify impactedteams | Independent securityclearance, patched BOM+negativecanaries+secretrotation/review affectedacceptedresults; không resume chỉ vì serviceup |
| Queue>120s/5min hoặc deadlineburst | Operator stoptestadmission first, inspect slots/throttle/disk; ADMIN báo delay. Close receipts đúngcutoff, drain mọi đúnghạn; không extend silently/exclude infra-pending | Eligible-set/digests/counts và maxREADYordinal đúng; capacityrevalidated; ADMINstart chỉ khi drainsolved+readiness, không nhận code muộn |
| Infra≥5%/≥20attempts/5min | Operator pauseexecutionpool và preserveattempts; classify rootcause, fix limit/resource/runtime, không phạtđội | Canary/accounting/cleanup healthy, benchmark/admission revalidated; Operatorclear+ADMINresume; BLOCKED không autoresetretry vôhạn |
| DBunavailable>1min, storage/fsync error, disk>90% | Operator stopwrites/claims/accept/finalize, publicdegraded; preserve spool, free only provenunreferenced/nohold expiredobjects; repair device/DB, không disablefsync | DBdurabilityflags/storageflush/checksums/fence valid; reconcile promotedorphans/pinnedcompletion; no acceptedmissingobjects; validatedbackup mới rồi resume |
| Outboxlag>5s/1min, projectionlag/SLOburn | Operator pause affectedpublication/advancement if consistency uncertain; replay idempotent outbox from ledger cursor, không recompute acceptedgame | Ledger/projection revision+digest match, no duplicate score/event, lag≤5s sustained5min; clearintegrityblocker trướcADMINfinalize |
| Standings/rating mismatch, dispute, corrupt/missing accepted evidence | ADMINpause dependentrounds, Operator compare ledger/digests; correctionpreview/apply supersede/void/rejudge theo02, securityreview integrityscope; không editprojection | Rebuildsamehash/ratingorder, descendants invalidated/repaired, disputesdecided/audit/notice; ADMINresume/finalize only afterallblockersclear |
| Backupconsistentage>5min, chaincorrupt, keymissing hoặc wholehostloss | Operator follows§6, stopwrites/admission/finalize, repairtransport/keyretrieve hoặc restore cleanhost; ADMINcommunicate actualloss/downtime | Complete off-hostmanifest/hash+chain/keys valid, restorechecks pass; RPO/RTO recorded (violation stated), newcheckpoint+readiness before resume |
| PublicHTTP/WS overload/backpressure>1MiB | Operator apply proxyIPlimits/trustedproxycheck, rejectnewWS/slowclient disconnect+sequencecatchup, keep API/DB/officialreserve; no match throttling by viewer | Queue/controlplane recovered, sequencecatchup correct, privatecache absent; sustainedSLO sample5min before remove temporarylimits |
| ONLINE SMTP failure/bouncequeue, verify/reset delivery unavailable | Operator check SMTPauth/TLS/DNS/providerquota, bounded outbox retries15s/60s/300s then hold+alert; redact recipient/token; ADMINstatusnotice | Probe verified ownedtestmailbox delivery+oneusetoken/revoke; queued mail notsent after tokenexpired (regenerate explicit request); neveractivatepending/bypassemail; LAN notdependent |
| TLSexpiry<7days/trustfailure or clockskew>1s | Operator renew from pinned procedure (LANlocalCA offline), correct NTP/localtimeauthority, pause timedmutations on skew>1s; monotonic watchdog unaffected | CorrectSAN/chain/trust coldclients, expiry>30days, UTCskew≤1s and deadlines reconciled/audited; no insecurecookie/Originbypass |
| ADMIN lost access ONLINE | Normal verifiedmail reset oneuse/revokesessions; if mailboxlost Operator maintenanceconsole + organization authorizedhandover record, preserve singleton and verifynewmail | Identity/handover evidence audited, tokens/sessionsrevoked, newmailverified/re-auth success, singletoncount1; no username-only reset orsecondADMIN |
| ADMIN lost access LAN (noemail) | Operator with authorized localOSconsole/root, deploymentId+ADMIN UUID+schoolcustodian signed recovery authorization: maintenance stopauthwrites, local maintenancecommand sets random oneuse temporarypassword and password_change_required, increments authgeneration/revokesallsessions/tokens, audit actorOSuid+reason+authorizationref; deliver credential privately once, neverlog | ADMIN limitedsession only changepassword/logout; atomicconsume+normalLOCAL_BOOTSTRAP session afterchange, oldpassword/session rejected, singletoncount1+auditdurable, localoperator+ADMIN acknowledge before maintenanceexit. NoSMTP/securityquestion/shareddefault/recoverycode/adminclone |
| Upgrade/migration failed or integrityvalidation mismatch | Operator maintenance/singlemigratorlock, preserve snapshot and logs; rollback compatible binary or forwardfix; ADMINnotify; no restorev1 over v2writes | Schema/BOMcompatibility/count/FK/digest/privatepublic/restoreproof, no dualscheduler; databasewritesresume only after approved migrationreceipt |
| Retention/PII purge error or accidental disclosure | Operator stoppurge/restrict affectedexport/cache, securityreviewer determine scope, ADMINnotify per policy; restore held evidence from backup if needed | Holds/references/keys preserved, deniedACL/publicDTO/cache tested, retentioninventory reconciled, reviewerclearance; no promise instant immutablebackupdelete |

Pause thường chỉ ngừng claim mới, game đang chạy hoàn tất. Emergency stop hủy sandbox và coi uncommitted attempts là infra; không xử thua Bot. Banner sự cố public không lộ source/security details; thông báo đội riêng và postmortem có timeline/corrective action. Không xóa evidence trước security reviewer quyết định.

### 7.3. Gates release, không tự ký “production-ready”

| Gate | Evidence cần ký duyệt |
|---|---|
| G0 — baseline/config completeness | Finalized01–06 baseline, exact BOM/lockfiles, profile/quota/retention/SLO, operator inputs validated per§7.4, ownership/notice approved; no product design TBD |
| G1 — security isolation | Independent execution/auth/scope/publicDTO review, actualgVisor/adversarialcompile/run/accounting/freezer for3languages; no unresolvedcritical/high/bypass, no privilegedAPI |
| G2 — correctness/durability | Frozenmanifest/fourpresets/deterministicpairing+rating, transaction/fencing/idempotency, ledgerrebuild/consistentbackuprestore |
| G3 — capacity/endurance | Actualhardware/BOMmixedworkload500teams/1000viewers,72hsoak+7dayrehearsal; admittedslots/ETA/headroom, not configcaps |
| G4 — operational release | MeasuredrestoreRPO/RTO, allrunbookdrills/oncall; ONLINEemail/CAtrust or LANlocalbootstrap/recovery, secrets/migrations/rollback proof; ADMIN/operator/independentreviewer signoff |

Trước nhận source không tin cậy cần G1; trước mở giải official cần tất cả gates. Tự audit code không thay independent security review; scan không thay thử sandbox thật. Finding về scope, result integrity, escape hoặc leak source là blocker, không “risk accepted” bởi một người tác giả code.

### 7.4. Reproducible BOM, deployment roles và input validation

Không lựa chọn “latest” tại startup. Release engineer trong phiên implementation resolve supported/security-maintained exact patches cho Ubuntu24.04/GA6.8, PostgreSQL16, runsc+OCI launcher, NodeLTS/Python/Rust/C++20 compiler và Next/React/Fastify/Monaco/shadcn/Tailwind/brackets-viewer. Record upstreamsupport/securityreview date+source, compatibilityevidence, exactversion+SHA256/OCI digest+architecture+licenses/SBOM+provenance+lockfilehash; không bịa patchversion/current-support status trong spec. Pin apt snapshot/package versions+offline.deb hashes, Cargo.lock, JS lockfile+packageManager version, compilerflags/SDK/engine/protoc/generatedschema digests, baseimage digest và frontend copied-code attribution. Release manifest canonicalSHA256 được operator approved, offlinebundle checksum signature và full installationinventory; rebuild dùng đúng cachedbytes, không `apt upgrade`/floatingtag/networkinstall khi boot/job. Scan advisories/provenance/license gate trước signoff và mỗi tuần, critical advisory ngừng admission/impactreview theo runbook, không tự đổi toolchain locked giải.

| Role/process | Quyền tối thiểu / boundary |
|---|---|
| Operator/release engineer (OS, không appADMINthứhai) | Rootconsole cho package/systemd/firewall/CA/bootstrap/recovery; signeddeploymentreceipt. App secrets không phát quaweb. Independentreviewer không cần thườngtrựcappaccount |
| Reverseproxy / web | Chỉ80redirect/443exposed; proxyTLS key riêng; NextUID chỉ APIpublic/privateviausersession, khôngDB/object/launcher credentials; static assets local |
| API/broker + scheduler/reconciler | Separate serviceUIDs; API DBappwriter và brokerobject access, khôngrunsc/cgroup/root. Scheduler/reconciler DBleastprivilege và UDS peerACL, durablelease/outbox; no browseradmin delegation |
| PostgreSQL / objectstorage | postgresUID local Unixsocket/peer roles, khôngpublic5432; appwriter khôngDDL/superuser; privateobjects `/var/lib/oantuti/objects`, paths normalized/broker-only, ext4durable volume; staging/spool samevolume bounded |
| Supervisor / launcher / reaper | SupervisorUID UDS allowed+ownslotcgroups, noDB; rootlauncher/reaper narrowfixedverifiedmanifest actions, sandboxusercapsempty, nohostsocket/secretmount. systemd cgroupreservations keep API/DB/scheduler alive |
| Migrator / backup | Temporary maintenanceDBDDL role under advisorylock, versionedchecksummedSQL once; backupUID minimalPGbackup+readonlyobjects and encryptedtransport credentials, no public listener; keyescrow operator-controlled |

Deployment configuration is a typed, canonical-hashed inventory, not runtime environment fallback. Required fields below are operator-supplied **values**, not unresolved architecture. Validation errors name field/code without secretvalue. Parsing/type/allowlist failures prevent service readiness; execution cannot claim without successful integrity+isolation+policy+capacity gates. Missing mail blocks ONLINE registration/loginrecovery readiness, never silently enables LAN; missing backup/durability/cert/secrets blocks protectedwrites/start. Public maintenance/read-only may remain reachable with explicit degradedstatus.

**Hai mức kiểm input:** `DEVELOPMENT_CONFIG_READY` trước T1 chỉ kiểm schema/BOM đã resolve, paths/roles/profile và môi trường kiểm thử được phép; capacityReportDigest/restoreReportDigest/installed runtime canary evidence chưa sinh được ghi `PENDING_RUNTIME_PROOF`, không fake digest hoặc yêu cầu chúng trước code tạo proof. Fields secret/provider/profile cần cho smoke nào phải có trước smoke đó. `RELEASE_READY` sau T11/T12 phải có đầy đủ actual hashes/slots/reports/TLS/mail theo profile/backup≤5min/G1–G4; pending khi đó là blocker. Development chỉ fixture được kiểm soát trong môi trường cô lập, không mở submissions/publicproduction; production preflight không có bypassdevelopment flag.

| Input fields | Validation gate / failure behavior |
|---|---|
| `deploymentId`, `profile`, `organizationId`, `operatorContact`, `securityContact`, `onCallSchedule`, `incidentChannel` | UUIDs; profile enumLAN_OFFLINE/ONLINE immutable; contacts reachable by profile-specific ackdrill; fulltournament coverage, no SMTP-only LANalert |
| `publicBaseUrl`, `allowedOrigins`, `bindAddress`, `trustedProxyCidrs`, `tlsCertPath`, `tlsKeyPath`, `lanCaBundlePath` | HTTPSorigin no path/wildcard/userinfo, exactsameorigin, SAN/chain/expiry/privatekeypermissions; LANCAtrusted on cleanclients; ONLINEpublicchain; CIDRparse/proxyknownhops. No insecure override |
| `adminUserId`, `adminUsername`, `adminEmail` (ONLINE), `bootstrapCredentialPath`, `recoveryAuthorizationCustodian` | SingletonmappingUUID/uniqueusername, ONLINEvalidemail+verifiedbootstrap before normal session; LAN no emailrequirement; bootstraprandomoneuse secretfileowner/mode, remove afterconsume; signed localcustodian recovery contact/authority recorded |
| `accountCapacity`, per-tournament `maxTeams`, `maxTeamSize`, `rulesRevision`, `policyProfileDigest`, `retentionNoticeVersion` | Positive integerlimits≥usage; maxTeamSize1–5/default3, limits explicitly setbyADMIN; rules02/profile05 exactdigests, no missingresource/network/outputquota fields; policyapprovednotice/holdsupport. No “empty means unlimited” |
| `pgSocketPath`, `pgDatabase`, `pgAppRole`, `pgMigratorRole`, `pgBackupRole`, credentialfile refs; `objectRoot`, `stagingRoot`, `spoolRoot` | RoleACL/ownership, separateDDL, checksums/durabilityflags/fsyncprobe; ext4samefilesystempromotion, nonworldreadable/nonexecutablesourcepaths, diskreservation/quotas; no insecurePGorhostpath defaults |
| `releaseBomDigest`, `runtimeProfileDigest`, `toolchainImageDigests`, `sdkDigests`, `hardwareInventory`, `certifiedBuildSlots`, `certifiedGameSlots`, `controlPlaneReserve`, `capacityReportDigest` | Verify installedhashes/architecture/kernel/cgroup/runsc/negativecanaries, exactprofileall3languages; hardware CPUmodel/cores/RAM/disk/freebytes/network; nonnegative slots backed by signed measuredreport/reservation, officialgame slots>0 beforestart; stale/missingproof BLOCKED_CAPACITY |
| `backupTarget`, `backupTransport`, `backupCredentialPath`, `backupEncryptionKeyId`, `restoreKeyEscrowLocation`, `backupManifestSigner`, `restoreReportDigest` | Targetoff-host reachable/writable and encrypted, LAN removabledeviceUUID not samehostvolume; ONLINE TLSverified endpoint optionalstorageprovider, no S3requirement. Keyaccess/escrow retrieval/hash/completechain/actualRPO-RTO drill; consistentage≤5min beforestart |
| ONLINE `smtpHost`, `smtpPort`, `smtpTlsMode`, `smtpUser`, `smtpPasswordPath`, `mailFrom`, `mailReplyTo`, `mailPublicBaseUrl` | Hostnonempty, port1–65535, TLSverifiedSTARTTLSorimplicit no plaintext, senderapprovedmailbox/domain, secretfilepermissions, exactbaseURL, controlledmailboxverification/resetdeliverydrill+providerquota/DNSsetup; provideroutage noverifiedloginbypass. LANfields absent and noSMTPsocket |
| `lanInterface`, `lanAllowedCidrs`, `lanWanDenyPolicyDigest`, `offlineBundleDigest`, `localTimeAuthority` (LAN); `timeSyncSource` (ONLINE) | LAN actualclient+hostWANdenied/requiredLANroutesallowed, coldasset/cachelessworkflow all local; bundlehash matchesBOM. UTCskew≤1s for deadlines, monotonicwatchdogs; not AIfreeguarantee |

Deploy order: verify offline/releaseinventory→create OSroles/volumeACL/secrets/firewall/TLS→initPGchecksums+backuproles→maintenance advisorylock/checksummedmigrations→verify schema/data/inventory (v1import03 mapping included)→singleADMINbootstrap byprofile→backupcheckpoint/restoreproof→API readonly→supervisorcanaries+policy/slotproof→enablewrites/registration only with gates. Migratorlock conflict/schemahash mismatch abort before servingwrites. Scheduler starts only one deploymentgeneration; newcode rolloutdrains computation/pinnedcompletion, backup beforemigration, preserve7day compatiblebinary/schema rollbackwindow. No automatic full hostupgrade during lockedtournament. Every deploy has actor/time/BOM/schema/profile hashes+gate report receipts; no installation implemented in this documentation pass.


## 8. Ma trận nghiệm thu thực tế

Đây là công việc triển khai/QA tương lai; **không chạy checks trong đợt docs-only này**. Mỗi report phải ghi commit, runtime/toolchain digest, OS/kernel/CPU model/cores/RAM/disk/network, concurrency/admission, dataset, timestamps, số mẫu, failure distribution và raw evidence đã redacted. Load generator tách host, đồng bộ clock có báo skew; không dùng loopback synthetic single-match làm bằng chứng toàn nền tảng.

| Nhóm | Ca kiểm thử tối thiểu | Pass condition |
|---|---|---|
| Isolation | Compiler macro/template bomb; đọc host/env/other Bot; DNS/egress/metadata; fork/thread bomb; disk/PID/FD/memory flood; symlink; attempted mount/ptrace; kill ignored | Denied/enforced đúng per-job; không leak/escape; host/API/DB ổn; zero descendants sau cleanup |
| Timing/protocol | Silent INIT/TURN, infinite CPU, sleep, multithread CPU, unsolicited/stale/double MOVE, huge line/no newline, malformed UTF-8/JSON, ignored TERM; event-loop stall và node throttle | Finite bounded finish; CPU vs wall đúng evidence, inactive Bot CPU không tăng ngoài accounted freeze boundary, không timeout oan do infra; oversight target đạt |
| SDK/profile | Starter và reference Bot Python/TS/C++ trên map min/max, cold/warm launch, JIT/syscall-heavy | Cùng init/legal actions/seed semantics; startup/memory practical; digest/profile đúng; không hỗ trợ ngôn ngữ chỉ trên quảng cáo |
| Auth/privacy | Pending-email login denied; token verify/reset replay/race; password re-auth/scope/session revocation; CSRF/CORS; public/private cache/export probing | Quyền đúng scope, không session trước verify hoặc role tự khai; không leak source/default secrets; không MFA implementation |
| Ledger/fault | Kill trước/sau artifact/replay promote, acceptance transaction, receipt archive và outbox; duplicate completion; stale worker; DB/network partition; reboot scheduler | Không double scoring/rating/advance; accepted result có đủ evidence; unaccepted game retry đúng; standings rebuild trùng |
| Four presets | 500 đội; byes/withdrawal/DQ/tie/dispute/seal/rejudge; Swiss→playoff; paired colors; Elo waves/quota/retry | Games count đúng cap, entry bất biến, rating không phụ thuộc worker completion order; không trao cúp unresolved |
|Deadline burst|500đội nộp nhiều versions, complete upload trước/sau hạn, build đảo thứ tự/sau hạn,restart drain và infraBLOCKED|Eligible theo durable receipt time; intake closed; READY sau hạn vẫn eligible; chỉ khóa khi tất cả READY/REJECTED, BLOCKED hoãn; maxordinal/frozenhash đúng|
|Mixed viewers/tests|1000khách public,500đội workspace/upload/compile/privatetests+official đồngthời|SLO/sequence/resourcequota/officialreserve đạt; testprivate khônglộHTTP/WS/cache/replay,khôngrating/candidate sideeffects|
| Capacity | RR 249.500 baseline games và các preset khác, actual Bot workload + tie/retry allowance, storage growth/retention | Report games/s và CPU/RAM/IO/headroom đủ deadline; không thay bằng chỉ tạo 500 rows hoặc tăng max constant |
|72h soak|Official/buildvalidation/privateTEST_BUILD+TEST_GAME/public/churn/rotation/backup|Memory/FD/process/object bounded,private retention đúng,officialqueue khôngstarve,testquota córecovery,no silentjobloss|
| 7-day rehearsal | Đúng duration mùa Elo hoặc format định mở, 500 đội dataset, peak 1000 viewers, sleep/overnight no admin tab, backup/restore và outage/recovery có operator | Không cần giữ browser; quota/reset/day boundary/timezone đúng; finish/ledger/replay đầy đủ; RPO<=5min/RTO<=30min và accepted-result invariant đạt |
| Recovery/rollout | Restore offsite, corrupted backup, missing key, old-version replay, migration rollback compatibility, upgrade/drain worker | Recovery đúng ordering/manifests; legacy unknown không giả provenance; không mất accepted results/PII leak |

72h soak và 7-day rehearsal là hai gates riêng; 72h không đủ chứng minh hoạt động 7 ngày. Nếu không thể chạy full RR trong deadline/hardware đã đo, phải giảm tải hoặc đổi lịch/quota bằng quyết định sản phẩm trước publish; không thu hẹp test rồi tuyên bố 500 đội mọi preset đạt. Regression suite sau implementation phải giữ ca silent Bot đã thiếu trong timeout test hiện tại và crash boundaries ledger, không chỉ positive starter bots.

## 9. Phạm vi bằng chứng hiện tại

Tài liệu này dựa trên yêu cầu sản phẩm và audit tĩnh RunnerAudit/ServerAudit ngày 2026-10-13. Benchmark WS hiện tại (`tests/load/websocket-load.ts`) là workload synthetic/loopback ngắn, không compiler/Bot hay soak; không chứng minh SLO hoặc capacity nêu ở đây. Không có measured sandbox security, CPU fairness, 500-team throughput, 1000-viewer end-to-end, RPO/RTO hay 7-day stability được tuyên bố. Các nguồn kỹ thuật bên ngoài và so sánh lựa chọn triển khai thuộc [nghiên cứu nền tảng](../../research/2026-10-13-v2-platform-research.md); kết quả thực nghiệm chỉ được bổ sung khi có report và gate ký duyệt.
