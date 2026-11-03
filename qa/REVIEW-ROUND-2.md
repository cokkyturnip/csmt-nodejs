# Review Round 2 — Evaluasi Mitigasi & Pengujian PTY

Tanggal: 2026-11-01  
Reviewer: Agent Pi (`w2:p4`)  
Target: `/Users/cokkyturnip/creatio-csv-import-nodejs`  
Verdict: **NOT READY TO SHIP (1 BLOCKER TERSISA)**

---

## Hasil Verifikasi Perbaikan Round 1

Agent Pi menjalankan script probe otomatis terhadap implementasi hasil mitigasi Round 1.
Sebagian besar temuan Round 1 dinyatakan **LULUS (PASSED)**:
- B1: `.env` loading and override behavior: **LULUS**
- H1: Date/datetime DD/MM parsing and no UTC shift across timezones: **LULUS**
- H2: Multibyte UTF-8 boundary trimming: **LULUS**
- M1/M2: Encoding normalisation & CSV BOM handling: **LULUS**
- M3: O(1) streaming memory: **LULUS**
- M5: Numeric validation: **LULUS**
- M6: Decimal string representation: **LULUS**
- M7: Parity unit tests (37 suites): **LULUS**
- M9 & L3-L7: `.gitignore`, cross-platform build, frozen panes, duplicate warnings: **LULUS**

---

## Temuan Baru Round 2 (BLOCKER)

### W1: `csmt wizard` Menggantung Setelah Prompt Rahasia dan Password Tetap Ter-echo

- **File**: `src/cli.ts:465-500` (`questionSecret`)
- **Penyebab**:
  1. *Dual Consumer pada stdin*: Instance `readline.Interface` dan handler `process.stdin.setRawMode(true)` manual sama-sama membaca dari `process.stdin`.
  2. *Chunk vs Karakter*: Handler raw mode membandingkan seluruh chunk dengan `"\n"` / `"\r"` (`===`). Di terminal nyata (atau PTY), string password beserta Enter sering datang dalam 1 chunk utuh (mis. `"SUPERSECRET123\n"`), sehingga perbandingan `===` gagal, promise tidak pernah resolve, dan proses wizard menggantung selamanya.
  3. *Echo Leak*: Readline tetap aktif di latar belakang dan merender karakter ke layar sebelum raw mode sempat menyembunyikannya (terlihat jejak `\r\r\n`).
  4. *Input Piped / Scripted Mati*: Piped input menghasilkan exit 13 (`unsettled top-level await`) karena readline terhenti saat raw mode memanggil `process.stdin.pause()`.
- **Dampak**: Setup wizard tidak dapat diselesaikan oleh pengguna (baik secara interaktif maupun otomatis lewat script pipe), file `.env` tidak pernah tercipta, dan password ter-echo di terminal.
