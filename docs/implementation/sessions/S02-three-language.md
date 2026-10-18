# S02 — Compiled three-language starter matches

Status: **THREE_LANGUAGE_TRUSTED_MATCHES_PASSED**, not full S02/G1 certification.

TypeScript5.9.3 compilation to CommonJS JS and g++13 C++20 compilation succeeded in exact previously exercised development image sha256:84e4a248f3c4191d3a03437a5c6f3da91183c47c897de93abc42052b4a6a74fc with Docker build network=none. No tsx/package manager at Bot runtime. Existing Python rootfs and action preserved. New image/artifact hashes: [compiled starter provenance](S02-compiled-starters.json).

Export597,578,752bytes; source archiveSHA256 fac7d1f7117e77461977305f459487773070d1fd84abfbf876be0c9de0446fbb. Expected normalized treeSHA256 b6305c27644a343ce1994b487e41bb1db46a332869b0f085c7b5f71a90d90d89 calculated from archive, **not yet verified on promoted disk**. One-time installer promotes exact archive with normalized links, exact modes, root ownership, verifies full tree before enabling policy. Existing artifacts not overwritten; failure keeps policy disabled.

Shared trusted-match implementation refactored into run_match; no parallel runner. Fixed entrypoint loops Python/TypeScript/C++ configs and accepts no caller args. Existing Rust supervisor/reaper and game-host retained. New root-owned action and rootfs promotion require operator installation. Shell syntax and sudoers parsed OK; actual nonroot entrypoint refuses. No new exhaustive test/review cycle per user instruction; next check is real integrated matches.

Installer deploy/linux/install-three-language.sh SHA25672f6fac1adc1f24d0d5c373f9581001938e2e2023c12ef3e1170705035e8e99c. New action /usr/local/libexec/oantuti/three-language-v1/three-language-match.py, exact empty arguments; revoke /etc/sudoers.d/oantuti-three-language-v1. No package-manager sudo workaround, no general runsc/shell permission. Real TypeScript/C++ sandbox matches not yet executed; startup timing, C++ SDK INIT parity and full gameplayv2 still require evidence, no G1/S02 complete claim.

## Actual execution

Operator installer output verified15,036rootfs members and normalizedtreeSHA256 `b6305c27644a343ce1994b487e41bb1db46a332869b0f085c7b5f71a90d90d89`. Agent invoked exact installed sudo action: exit0 after20.02s completecommand, allthree fixed matches PASS. Python, compiledTypeScriptJS andC++20binary each completed INIT/READY forbothsides and White THRONE_BREACH in1ply; independentReaperConfirmed=true for each. [Exact output](S02-three-language-result.json). This is realgVisorBotexecution, not harnessobservations ornativefallback. Existingkernel7.0developmentonly; gvisorCertified=false. This shortsinglefixturedoesnotprovefullSDKINITparity/maxmap/CPUovershoot/networknegativecanaries/capacity orGA6.8certification. No rerun required; next work is gameplayv2 parity and integrated lifecycle hardening, not another standaloneprobe.
