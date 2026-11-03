# Perbaikan & Mitigasi Round 3

Tanggal: 2026-11-02  
Pelaksana: Agent Antigravity  
Status: **SELESAI & DIVERIFIKASI (42 Tests Passing)**

---

## Rincian Lengkap Mitigasi 5 MEDIUM & 6 LOW

### 1. Mitigasi Kategori MEDIUM

#### M-1: Pengerasan Test Suite & Pencegahan Hang
- **File**: `package.json`, `tests/cli.test.ts`
- **Mitigasi**:
  - Menambahkan script `"pretest": "npm run build"` di `package.json` agar berkas kompilasi selalu mutakhir sebelum tes dijalankan.
  - Menambahkan argumen `--test-timeout=30000` pada script test untuk menjamin *fail-fast* jika terjadi kebuntuan proses anak.
  - Memperbarui pemanggilan subproses pada `tests/cli.test.ts` agar mengeksekusi `npx tsx bin/csmt.ts` langsung dari sumber TypeScript.
  - Memasang promise listener `proc.once("close")` sebelum loop penulisan baris stdin dimulai.

#### M-2: Default UTF-8 BOM pada CLI Export
- **File**: `src/cli.ts`, `src/export.ts`
- **Mitigasi**:
  - Mengubah nilai default flag `--encoding <enc>` pada perintah `export` di Commander menjadi `"utf-8-sig"`.
  - Memastikan byte `0xEF, 0xBB, 0xBF` otomatis ditulis pada permulaan berkas CSV ekspor agar langsung terbaca sempurna di Microsoft Excel.

#### M-3: Implementasi Logger Lengkap & Registrasi Flag CLI
- **File**: `src/logger.ts`, `src/cli.ts`, `src/pipeline.ts`, `src/export.ts`, `tests/logger.test.ts`
- **Mitigasi**:
  - Membuat modul `Logger` (`src/logger.ts`) dengan level `debug`, `info`, `warning`, `error`, penulisan berkas log (`--log-file`), dan penekanan output (`--quiet`).
  - Memasang hook global `program.hook("preAction", ...)` di `src/cli.ts` untuk mengonfigurasi logger secara otomatis pada setiap perintah CLI.
  - Mendaftarkan opsi `--lookup-chunk <n>` dan `--log-every <n>` pada perintah `export`.
  - Menghubungkan pelaporan progres pada `ImportPipeline.emit()` (`progressEvery`) dan `Exporter.run()` (`logEvery`).
  - Menambahkan 2 unit test pada `tests/logger.test.ts`.

#### M-4: Validasi & Kanonikalisasi Angka Desimal
- **File**: `src/mapping.ts`
- **Mitigasi**:
  - Menolak bentuk non-desimal seperti heksadesimal (`0x10`), `Infinity`, `-Infinity`, dan `NaN`.
  - Mengonversi notasi eksponensial ilmiah (mis. `1e3` -> `1000`).
  - Menormalkan trailing dot (mis. `1.` -> `1`).
  - Menegakkan regex kanonik ketat `^-?\d+(\.\d+)?$`.

#### M-5: Status Dependensi Upstream ExcelJS
- **File**: `package.json`, `package-lock.json`
- **Mitigasi & Status**:
  - 10 kerentanan tingkat *moderate* pada `npm audit --omit=dev` seluruhnya berada pada dependensi transitif internal `exceljs@4.4.0` (`archiver` -> `glob`/`minimatch` dan `uuid < 11.1.1`).
  - `exceljs@4.4.0` merupakan rilis stabil resmi terbaru dari komunitas ExcelJS. Menjalankan `npm audit fix --force` akan menurunkan versi secara paksa ke `exceljs@3.4.0` yang merusak arsitektur ESM dan antarmuka *streaming workbook writer*.
  - CSMT menggunakan `exceljs` secara lokal untuk file terpercaya (bukan server publik). Dicatat sebagai dependensi terkelola upstream yang menunggu rilis patch 4.5.0 dari tim ExcelJS.

---

### 2. Mitigasi Kategori LOW

#### L-1: Penanganan Sinyal Interupsi Ctrl+C (SIGINT)
- **File**: `src/cli.ts`
- **Mitigasi**:
  - Menambahkan listener `rl.on("SIGINT", () => { rl.close(); process.exit(130); })` pada antarmuka readline wizard.
  - Menolak (*reject*) antrean pembaca baris tertunda (`waiters`) dengan `ConfigError("Input ended before wizard completed")` pada saat event `close` terpanggil.

#### L-2: Unit Test Masking Terminal TTY
- **File**: `src/cli.ts`, `tests/cli.test.ts`
- **Mitigasi**:
  - Menambahkan parameter stream opsional `io: { input, output, isTTY }` pada `runWizard()` sehingga interaksi TTY dapat disimulasikan secara programatik.
  - Membuat unit test `tests/cli.test.ts` yang mengaktifkan `isTTY: true`, memasukkan secret password melalui stream, dan memverifikasi bahwa password tersimpan di `.env` namun sama sekali TIDAK bocor ke stream output terminal.

#### L-3: Validasi Argumen Baris Header Spreadsheet
- **File**: `src/cli.ts`
- **Mitigasi**:
  - Membungkus parameter `opts.headerRow` dengan validator `asInt(opts.headerRow, "--header-row")` pada perintah `init-mapping` dan `import`.
  - Mengembalikan exit code 2 dengan pesan galat yang informatif jika diisi nilai non-angka.

#### L-4: Dukungan Format ISO Datetime & Offset Zona Waktu
- **File**: `src/mapping.ts`, `tests/mapping.test.ts`
- **Mitigasi**:
  - Menambahkan pola tanpa detik (`%Y-%m-%d %H:%M`, `%Y-%m-%dT%H:%M`, `%d/%m/%Y %H:%M`) ke `DEFAULT_DATE_FORMATS`.
  - Memperbarui `parseIsoFallback()` untuk menangkap token offset zona waktu (`Z` atau `[+-]\d{2}:?\d{2}`).
  - Memperbarui `toDatetimeConverter()` agar mempertahankan offset zona waktu asli (`comp?.tzOffset`), cocok dengan perilaku Python `isoformat()`.

#### L-5: Penanganan Baris Header CSV > 64 KiB
- **File**: `src/csv-source.ts`, `tests/csv-source.test.ts`
- **Mitigasi**:
  - Memperbarui metode `loadHeaderSync()` agar membaca chunk berulang kali sampai menemukan karakter newline (`\n` / `\r`) atau batas maksimum 16 MiB.
  - Menambahkan uji regresi di `tests/csv-source.test.ts` menggunakan berkas CSV dengan 5.000 kolom (~70 KiB header) tanpa terjadi pemotongan nama kolom.

#### L-6: Akses Instan Fieldnames Excel & Sinkronisasi Dokumentasi
- **File**: `src/tabular.ts`, `src/xlsx-source.ts`, `README.md`
- **Mitigasi**:
  - Memastikan fungsi pembantu `openSource()` langsung memanggil `await src.info()` sebelum mengembalikan instans `XlsxSource`, sehingga properti `source.fieldnames` langsung terisi secara sinkron tanpa jeda.
  - Memperbarui status pengujian di `README.md` menjadi **42 unit & integration tests lulus (0 failures)**.
