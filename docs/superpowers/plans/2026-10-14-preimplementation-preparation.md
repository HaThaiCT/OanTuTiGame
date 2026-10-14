# OanTuTi v2 — gói chuẩn bị trước implementation

> Preparation-only; không product code, không provisioning hoặc chứng nhận runtime. Đọc cùng [S01–S17](2026-10-14-sequential-implementation-sessions.md), [master T0–T12](2026-10-13-production-upgrade.md), [baseline](../../specs/v2/README.md). Không thay contracts/policies của01–05.

## 1. Kết luận tại thời điểm inventory

**PLANNING_READY; HOST_PROVISIONING_BLOCKED; S02_RUNTIME_NOT_READY; RELEASE_NOT_READY.** Có thể đọc/chuẩn bị cấu hình và inventory. Không bắt đầu tải toolchain/images, build, tạo nhiều worktree hoặc chạy load trên volume hiện tại trước khi có headroom. Các trạng thái này không đánh dấu S01 đã hoàn tất.

| Hạng mục | Bằng chứng quan sát | Hệ quả |
|---|---|---|
| Workspace | branch main, HEAD `cafe674a44de8076dda9c2d1dede40609a76fa63`; một worktree | Không reset/clean; chưa có workspace implementation riêng |
| Thay đổi | README.md/docs/specs/README.md modified; research/v2/masterplan/sessionplan/overview untracked | Không tạo worktree từHEAD rồi giả specs đã có; giữ tất cả thay đổi, không tự gom unrelatedchanges |
| CPU | i5-1135G7,4cores/8threads | Chỉ inventory, không capacity500proof |
| RAM |7,5GiB tổng;3,0GiBavailable tại snapshotS01; swap4GiB dùng1,9GiB | Availability biến động, không chứng nhận game/buildslots hoặc benchmark |
| Disk | `/dev/nvme0n1p6`,ext4;size60.510.113.792bytes/used57.057.214.464/available345.919.488;df100%;2.732.966inodesfree | **BLOCKER trước package/image downloads/build/db/WAL/spool**; reserve10%=6.051.011.380bytes, footprintchưađo; không tự xóa/prune |
| OS/kernel | Ubuntu24.04.5LTS amd64/kernel7.0.0-38/cgroup2 | Khác targetGA6.8; không tựdowngrade/reboot, chưa certifiedruntime |
| Tools | Node24.21.0/npm11.19.0/Docker29.1.3/g++13.3.0/Python3.12.3 cóCLI; dpkg runc1.3.4-0ubuntu1~24.04.1 installed | Không đồng nghĩa daemon/permissions/network/runtime đãready; installedversionkhôngtựselectedBOM |
| Thiếu PATH | Cargo/Rust/runsc/podman/psql/protoc; khôngmatch~/.cargo/bin hoặc/usr/lib/postgresql/*/bin/psql; dpkg cargo/rustc/protobuf-compiler/runsc khôngmatch | Standardlocation/packagechecks khôngchứngminh tools/servicekhôngtồn tạiởmọilocation; noinstall |
| Security inventory | lscpu báo Gather data sampling Vulnerable | OSreportedstatus chưa pentest; review microcode/kernel/mitigation theo hostthực trước sandbox certification, không tự thay cấu hình |

Snapshot thực thi S01 theo hostclock2026-10-14T17:14:03.121Z, commandsread-only vàexitstatuses trong [handoff](../../implementation/sessions/S01-preparation.md). Rootext4 làpersistentext4mount duy nhấtquan sát; workspacewritable khôngfsyncproof. Hashbaseline15files làPARTIAL_HASH_ONLY, khôngcheckpoint/backup. Không chạy build/tests/hostilecanaries, không truy cập secrets hoặc xóa dữ liệu. S01BLOCKED, khôngDEVELOPMENT_CONFIG_READY/S02runtime/releaseready.

## 2. Thứ tự chuẩn bị có kiểm soát

### P01 — Bảo toàn workspace và baseline

- [ ] Inventory diff/filelist khi bắt đầu phiên thực, phân biệt userchanges và assistantdocs; không restore/reset/clean.
- [ ] Giữ baseline bằng checkpoint hoặc commit được user/repo cho phép, chọn rõ docs-onlypaths và không stage unrelatedcode/secrets. Nếu chưa commit, dùng snapshotcopy vào workspace sau khi có diskheadroom và kiểm digests; khôngworktree từHEAD thiếuuntrackeddocs.
- [ ] Ghi basecommit+baselinefilehashes+permissionprovenance và integrationowner. Read AGENTS/CLAUDE nếu thực sự có trong workspace; không tạo instructionsfile chỉ để thay workflow.
- [ ] Branch/worktree cô lập chỉ sauheadroom, đọc using-git-worktrees khi thực hiện; noautopush/merge.

### P02 — Giải quyết disk trước provisioning

- [ ] Chọn volume phát triển có headroom hoặc kế hoạch dọn/di chuyển được chủ máy đồng ý theo **exact target**; không tự xóa repo/storage/replays/SQLite/node_modules/Dockerimages/volumes.
- [ ] Đo dung lượng packagecache/toolchains/images/extractedprojects/PG/WAL/replay/spool/worktree và workspace/build cần dùng. Reserve theo số đo kế hoạch thực, không tùy ý ghi305MB là đủ hoặc bịa một diskminimum đủ500đội.
- [ ] Verification sau xử lý: df/findmnt/inodeinventory và capacitybudget; imagepull/build/databasewrites không bắt đầu nếu footprint+reservedmargin vượtfreebytes. Runtime80%warning/90%page theo05 không được bỏ vì developmentdiskđầy.
- [ ] Backup dữ liệu v1/workingchanges trước di chuyển; checksum/restoreproof cho thao tác thực, không chỉ nói đãbackup.

### P03 — Chọn host phát triển và host chứng nhận

- [ ] Currentkernel7.0 dùng đọc code/development khi toolsheadroom đủ; **không dùng evidence này chứng nhận targetGA6.8**. Dockercontainer không thay hostkernel, không giải quyết mismatch bằng imageUbuntu24.04.
- [ ] Conservative option: host Linux cô lập targetUbuntu24.04amd64/GA6.8 với quyền operator phù hợp; không bắt buộc đổi laptop hiện tại. Certification/release vẫn **một serving/executionhost**, workstation/loadgenerator khác không trở thành cluster.
- [ ] Nếu muốn kernel7.0 làm target, phải đổi baseline có impact/supportreview+proof, khôngsilentcutover. Không executionVM default; thêmVM cần revisiontrustseams, không coi tương đươngUDSbaseline.
- [ ] Root/systemd/cgroupdelegation/runsc launcher/UIDACL/reaper/networkdeny checks trên target được phép; groupssudo/docker không chứng minh đã được quyền sửa host.

### P04 — Pin BOM và chuẩn bị tools

- [ ] Dùng upstream official releases/support/securityadvisories để resolve exact Rust/Cargo/protoc/runsc+OCIlauncher/PostgreSQL16/Node24/Python/C++20/NextReact/Fastify/Monaco/UIdeps và apt/packages/offlinehashes. Chỉ ghi version/digest đã fetch thực, khôngcopy currentinstalledversions vàoBOM vì tiện.
- [ ] Kiểm installedpaths/packageinventory; cần install thì xác định prefix/path/package/service, footprint, quyền và rollback trước thực hiện. Không auto `curl|sh`, floatinglatest hoặc rootinstallscript khôngreview.
- [ ] Cargo.lock/npm lock/generatedproto tool versions+hashes; libc/compilerflags/runtime/SDK/baseimage/provenance. Supportdate+source/license/SBOM record theo05§7.4.
- [ ] Verify phiênbản/hash/canaryprerequisites sau provisioning; toolcommand có mặt không thay isolation/accountingproofS02.

### P05 — Inputs theo thời điểm cần dùng

| Input | Cần trước | Bằng chứng / nơi cung cấp |
|---|---|---|
| Host/volume/operator permissions/isolatedtesttarget | S01provisioning/S02 | Actualinventory + authorizedtarget; không hỏi user thứ đãtoolsđọc được |
| ExactBOM/roles/paths/profile/configschema | S02 | Redactedmanifest/hashes, completebaseline; runtimeproofpending hợp lệ |
| PostgreSQL16 isolation/testDB credentials | S03 | Secretfile ngoàiGit+roleACL/migrationvalidation, không productionDB |
| ONLINE SMTP + mailbox được phép | S04smoke | ProviderTLS/sender/quota và tokenflow tới controlledstagingmailbox; nofakeverified |
| Sourcecode giao diện được phép | S12reuse | Publiclegitcode hoặc gói author cung cấp, file/version/provenance; permission không làmprivatesource tựtruycập được |
| Domain/TLS/localCA trust/LANperimeter/timeauthority | ProfileUI/deploysmokes S12–S15 | Actualchain/SAN/coldclienttrust/denyWAN/timeevidence; developmentnoexternalintake |
| Offhostbackupdestination/keyescrow/restoretarget | S15 | Verifiedtransport/completeDBobjectsmanifest/keyretrieval/RPO-RTOdrill |
| Students/lecturers usability, independentsecurityreviewer/oncallowner | S14–S17 hoặc earliersecuritygate | Người thực và scope/evidence/signoff, không agentreview thay humansecuritycertification |
| Actual500team/1000viewer workloadslots | S16/S17 | Measuredhost/BOMreports/headroom, không hardwareguess |

Chưa có giátrịthực của credentials/target/contacts không viếtplaceholder productionsecret hoặc successreport. Cấu hình mẫu tương lai dùng tênfield/validation, neverdefaultsharedpassword. Chỉ hỏi missinginput sautools/context khôngthểcung cấp, batch theo phasecần.

### P06 — Kết thúc S01 và chuyển S02

- [ ] Docscheckpoint thực có thể đọc từ implementationworkspace; no unrelatedchangeslost.
- [ ] Diskfootprint+headroom đủ và hosttarget permission rõ.
- [ ] Tools/BOM resolve/pin/verify, configschema/paths/UIDprofile ready; installerwork chưa làm ghiBLOCKED.
- [ ] Chứng nhận chưa sinh ghiPENDING_RUNTIME_PROOF, không yêu cầu fullG1G3G4 trướcT1; `DEVELOPMENT_CONFIG_READY` khôngproductionbypass.
- [ ] Handoff redacted tại docs/implementation/sessions/S01-<scope>.md khi thực sựthực hiện. Hiện chưa tạo reportcompleted giả. S02chỉbắtđầu khi target có thể chạy sandbox failclosed; kernelmismatch hoặc runscabsent khôngnativefallback.

## 3. Phạm vi quyền

Yêu cầu chuẩn bị không tự cấp quyền xóa dữ liệu/đổibootkernel/reboot/chỉnh account/firewall/cgroupservice toànhost/muaVPS/gửiemail/deployproduction. Exacttarget+changes phải xácnhận trướcsideeffect nếu chưa có quyền cụthể. User-local isolatedtoolsetup có thể thực hiện trong phiên S01 được yêu cầu rõ, saudisk và source/BOMreview; không vượt lênproductimplementation trướcpreparationgate.

## 4. Exit hiện tại và tiếp theo

Preparation packet và inventory đã ghi; **chưa hoàn tất provisioningS01**. Criticalblocker hiện tại làdiskheadroom, targetkernel/toolchainruntime chưaready. Khi thực thi, ưu tiên P01/P02 rồi P03/P04; không thêmroadmap hoặc hỏi lạiUI/languages/rules đãchốt. Baseline/sessionplan làauthority, packet này chỉtriage operationalinputs.
