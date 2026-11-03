# Review Round 1 — Evaluasi Awal Porting Node.js

Tanggal: 2026-11-01  
Reviewer: Agent Pi (`w2:p4`)  
Target: `/Users/cokkyturnip/creatio-csv-import-nodejs`  
Verdict Awal: **NOT READY TO SHIP**

---

## Ringkasan Temuan Round 1

Review Round 1 dilakukan secara empiris oleh Agent Pi dengan menjalankan probe pengujian terhadap implementasi awal Node.js/TypeScript. Ditemukan 1 Blocker, 2 High, dan 9 Medium.

### 1. BLOCKER
- **B1**: Konfigurasi `.env` / `CREATIO_*` diabaikan oleh CLI (`src/config.ts:327-345`).
  - *Penyebab*: `Settings.fromEnv` menyebarkan `...overrides` di akhir instansiasi objek. Saat CLI dipanggil tanpa flag opsional, parser Commander menghasilkan nilai `undefined` untuk flag yang tidak disetel. Spread `...overrides` menimpa nilai sah yang sebelumnya dibaca dari file `.env`.
  - *Dampak*: Menjalankan CLI dengan file `.env` gagal mengenali kredensial dan URL.

### 2. HIGH
- **H1**: Konversi tanggal/datetime menukar hari/bulan dan bergeser mengikuti zona waktu mesin (`src/mapping.ts:591-640`).
  - *Penyebab*: Menggunakan `new Date(text)` bawaan V8 yang mendahulukan format US `MM/DD/YYYY` alih-alih standar Indonesia/Eropa `DD/MM/YYYY`. Selain itu, pemanggilan `toISOString()` mengonversi jam lokal ke UTC (mis. Jakarta UTC+7 bergeser mundur 7 jam). `spec.dateFormat` juga diabaikan.
- **H2**: UTF-8 valid terdeteksi salah sebagai Latin-1 (`src/csv-source.ts:15-39`).
  - *Penyebab*: Karakter multibyte UTF-8 yang terpotong tepat pada batas chunk buffer 64 KiB menyebabkan `TextDecoder({ fatal: true })` melempar error dan langsung fallback ke `latin1`.

### 3. MEDIUM
- **M1**: Encoding terdokumentasi `--encoding utf-8-sig` dan `cp1252` crash di Node fs (`ERR_UNKNOWN_ENCODING`).
- **M2**: Ekspor CSV tidak menyertakan UTF-8 BOM (`\ufeff`) secara default sehingga aksen/karakter khusus rusak di Microsoft Excel.
- **M3**: Klaim streaming memori O(1) tidak terpenuhi karena pembacaan header CSV memakai `readFileSync` seluruh file dan `XlsxSink` mengumpulkan semua baris di memori.
- **M4**: Flag logging yang terdokumentasi (`--log-level`, `--log-file`, `--quiet`) belum dihubungkan.
- **M5**: Flag numerik CLI (`--batch-size`, `--timeout`, `--limit`, dll.) tidak divalidasi sehingga argumen string menghasilkan `NaN` tanpa pesan error yang jelas.
- **M6**: Potensi kehilangan presisi tipe data `decimal` karena konversi ke tipe `number` floating-point IEEE 754 JavaScript.
- **M7**: Paritas cakupan testsuite masih kurang dibanding versi Python (baru 31 test).
- **M8**: Input password dan client secret pada wizard konfigurasi terminal tampil plaintext (tidak ter-masking).
- **M9**: Belum ada file `.gitignore` dan `engines` di `package.json`.

### 4. LOW
- **L-3**: Ekspor XLSX belum menyertakan `freeze_panes = "A2"`.
- **L-4**: Skrip build `package.json` memakai `chmod` yang tidak portabel di Windows.
- **L-5**: Warning duplikat key pada `ExistingIndex.preload` belum ada.
- **L-6**: Laporan tetap mencetak path report meskipun 0 baris diproses.
- **L-7**: Warning saat opsi `--encoding` atau `--delimiter` diberikan untuk file `.xlsx`.
