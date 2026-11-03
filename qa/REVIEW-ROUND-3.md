# Review Round 3 — Verifikasi Final & Status Rilis

Tanggal: 2026-11-01  
Reviewer: Agent Pi (`w2:p4`)  
Target: `/Users/cokkyturnip/creatio-csv-import-nodejs`  
Verdict: **READY TO SHIP (Semua Blocker & High Terpecahkan)**

---

## 1. Hasil Verifikasi Perbaikan Round 2

Agent Pi menguji secara mendalam terhadap implementasi `runWizard` dan pipeline:
- TTY oauth2 (Client secret): **LULUS** (exit 0, secret tidak ter-echo, `.env` benar)
- TTY forms (Password): **LULUS** (exit 0, secret tidak ter-echo, `.env` benar)
- TTY basic (Password): **LULUS** (exit 0, secret tidak ter-echo, `.env` benar)
- Pipe semua baris sekaligus: **LULUS** (exit 0, tidak ada baris hilang)
- Pipe tanpa newline terakhir: **LULUS** (exit 0, `.env` lengkap)
- Permissions file `.env`: **LULUS** (`-rw-------` 0600)
- Core Pipeline & OData Engine: **LULUS** (semua skenario idempotent, batch, lookup, negative cache, retry backoff)
- Multi-Timezone Matrix: **LULUS** (UTC, Asia/Jakarta, America/Los_Angeles)

---

## 2. Rincian Temuan Pi (5 MEDIUM & 6 LOW)

Berikut adalah daftar lengkap 5 temuan Medium dan 6 temuan Low dari review Agent Pi:

### A. Kategori MEDIUM

| Kode | Temuan | Lokasi | Dampak |
|---|---|---|---|
| **M-1** | Test W1 menggantung bila `dist/` tidak ada/basi: listener close dipasang setelah menulis jawaban, `dist/` di-gitignore, tanpa `--test-timeout` | `tests/cli.test.ts`, `package.json` | `npm test` di clone baru atau setelah edit `src/` menggantung, bukan gagal cepat (>120 s). |
| **M-2** | Default BOM export hanya benar di library; CLI masih `--encoding utf8` | `src/cli.ts`, `src/export.ts` | Default yang didokumentasikan (`utf-8-sig`) tidak berlaku via CLI (terbukti `49642c` vs `efbbbf`). |
| **M-3** | Flag logging inert; `progressEvery`/`logEvery` tidak dibaca; `--log-every`/`--lookup-chunk` tidak terdaftar pada CLI | `src/cli.ts`, `src/pipeline.ts`, `src/export.ts` | `--quiet`/`--log-file` menyesatkan pemakai, diagnosa progress hilang saat eksekusi panjang. |
| **M-4** | `parseDecimal` meneruskan `1e5`, `1.`, `0x10`, `Infinity`; int >2^53 dibulatkan | `src/mapping.ts` | Payload tidak valid dikirim ke OData berujung HTTP 400. |
| **M-5** | Audit: 10 moderate vulnerabilities via `exceljs@4.4.0` | `package.json`, `package-lock.json` | Risiko supply chain dependensi transitif (`archiver` -> `glob`/`minimatch` dan `uuid < 11.1.1`). |

### B. Kategori LOW

| Kode | Temuan | Lokasi | Dampak |
|---|---|---|---|
| **L-1** | Ctrl-C / EOF di wizard menghasilkan exit 13 + "unsettled top-level await" (dokumen menjanjikan exit 130) | `src/cli.ts`, `bin/csmt.ts` | Sinyal interupsi terminal mengembalikan exit code non-standar dan memunculkan error unhandled promise rejection. |
| **L-2** | Test W1 berjudul "masked secrets" tapi hanya menguji jalur piped non-TTY; logika masking TTY tidak dijaga test | `tests/cli.test.ts`, `src/cli.ts` | Regresi pada penanganan masking terminal interaktif tidak terdeteksi oleh CI. |
| **L-3** | Argumen `--header-row abc` menghasilkan `NaN` tanpa validasi | `src/cli.ts` | Nilai `NaN` lolos ke logika parsing spreadsheet, memicu error tidak terduga. |
| **L-4** | ISO datetime tanpa detik (`YYYY-MM-DD HH:mm`) ditolak; offset zona waktu (`+07:00`/`Z`) dibuang | `src/mapping.ts` | String ISO datetime bisnis ditolak atau kehilangan konteks offset zona waktu aslinya. |
| **L-5** | Header baris pertama CSV > 64 KiB dapat menyebabkan salah potong nama kolom | `src/csv-source.ts` | Berkas CSV ekstrem dengan ribuan kolom terpotong saat inisialisasi mapping. |
| **L-6** | `XlsxSource.fieldnames` async-init menghasilkan array kosong jika belum dipanggil `info()`, serta README test count out-of-sync | `src/xlsx-source.ts`, `src/tabular.ts`, `README.md` | Akses instan ke `.fieldnames` mengembalikan `[]`, angka pengujian pada dokumentasi usang. |
