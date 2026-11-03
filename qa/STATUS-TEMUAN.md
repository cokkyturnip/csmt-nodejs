# Status Lengkap Temuan & Mitigasi

Dokumen ini melacak status seluruh temuan dari Review Round 1, Round 2, dan Round 3 bersama Agent Pi.

---

## 1. Ringkasan Status

- **Total Temuan Blocker & High**: 4/4 **CLOSED (100%)**
- **Total Temuan Medium**: 5 (4 **CLOSED**, 1 **UPSTREAM CONSTRAINT**)
- **Total Temuan Low**: 6/6 **CLOSED (100%)**
- **Test Suite**: 42 unit & integration tests lulus (0 fail, 0 hang) di 3 zona waktu (UTC, Asia/Jakarta, America/Los_Angeles).

---

## 2. Status Rinci 5 Temuan MEDIUM

| Kode | Temuan | Status | Solusi & Mitigasi |
|---|---|---|---|
| **M-1** | Test W1 menggantung bila `dist/` tidak ada/basi (`tests/cli.test.ts`) | **CLOSED** | Menambahkan `pretest: npm run build`, batas waktu `--test-timeout=30000`, menjalankan tes langsung via `tsx bin/csmt.ts`, dan memasang promise listener `proc.once("close")` sebelum loop penulisan stdin. |
| **M-2** | Default BOM export hanya benar di library, CLI masih `--encoding utf8` | **CLOSED** | Nilai default flag `--encoding` di Commander diubah menjadi `"utf-8-sig"`. Terverifikasi menulis byte UTF-8 BOM `0xEF, 0xBB, 0xBF`. |
| **M-3** | Flag logging CLI inert; `--log-every`/`--lookup-chunk` belum terdaftar | **CLOSED** | Dibuat modul `Logger` (`src/logger.ts`) mendukung `--log-level`, `--log-file`, dan `--quiet`. Opsi `--lookup-chunk` dan `--log-every` didaftarkan pada perintah `export`. Progress logging aktif di pipeline dan export. Dilengkapi unit tests di `tests/logger.test.ts`. |
| **M-4** | `parseDecimal` meneruskan bentuk non-kanonik (`1e5`, `1.`, `0x10`, `Infinity`) | **CLOSED** | Menolak format heksadesimal, infinity, dan nan; menormalkan eksponen ilmiah `1e3` -> `1000`; memotong trailing dot `1.` -> `1`; dan menegakkan regex `^-?\d+(\.\d+)?$`. |
| **M-5** | Audit: 10 moderate vulnerabilities via `exceljs@4.4.0` | **UPSTREAM CONSTRAINT** | Berasal dari dependensi transitif paket rilis resmi `exceljs@4.4.0` (`archiver` -> `glob`/`minimatch` dan `uuid < 11.1.1`). Tidak dapat di-downgrade ke 3.4.0 karena merusak ESM streaming writer. Aman digunakan untuk spreadsheet lokal terpercaya. Menunggu rilis versi 4.5.0 dari upstream ExcelJS. |

---

## 3. Status Rinci 6 Temuan LOW

| Kode | Temuan | Status | Solusi & Mitigasi |
|---|---|---|---|
| **L-1** | Sinyal Ctrl+C (SIGINT) tidak mengembalikan exit 130 di wizard | **CLOSED** | Menambahkan event handler `rl.on("SIGINT")` yang keluar dengan exit code 130, serta mereject waiter yang tertunda dengan `ConfigError` saat `rl.on("close")`. |
| **L-2** | Test W1 berjudul "masked secrets" hanya menguji jalur piped non-TTY | **CLOSED** | Menambahkan opsi injeksi stream `io: { input, output, isTTY }` pada `runWizard()` dan menambahkan unit test di `tests/cli.test.ts` yang memverifikasi muting readline `_writeToOutput` saat `isTTY: true`. |
| **L-3** | Flag `--header-row abc` menghasilkan `NaN` tanpa validasi | **CLOSED** | Parameter dibungkus dengan validasi `asInt(opts.headerRow, "--header-row")`, menghasilkan exit code 2 dengan pesan error yang jelas. |
| **L-4** | ISO datetime tanpa detik ditolak; offset zona waktu (`+07:00`/`Z`) dibuang | **CLOSED** | Format datetime tanpa detik dimasukkan ke `DEFAULT_DATE_FORMATS`. `parseIsoFallback()` dan `toDatetimeConverter()` diperbarui untuk menangkap serta mempertahankan offset zona waktu asli (`+07:00`/`Z`). |
| **L-5** | Header CSV baris pertama > 64 KiB terpotong | **CLOSED** | `loadHeaderSync()` diperbarui untuk membaca potongan berkas (chunks) secara berulang hingga menemukan karakter newline (`\n` / `\r`). Diverifikasi dengan test 5.000 kolom (~70 KiB header). |
| **L-6** | `XlsxSource.fieldnames` kosong jika belum panggil `info()`, test count usang | **CLOSED** | `openSource()` sekarang memanggil `await src.info()` sebelum mengembalikan instans `XlsxSource`. Seluruh referensi jumlah tes diperbarui ke 42 tes di `README.md`. |

---

## 4. Status Temuan Putaran Sebelumnya (B1, H1, H2, W1)

| Kode | Kategori | Ringkasan Solusi | Status |
|---|---|---|---|
| **B1** | BLOCKER | Menghapus `...overrides` yang menimpa variabel `.env` dengan `undefined`. | **CLOSED** |
| **H1** | HIGH | `DEFAULT_DATE_FORMATS` mendahulukan DD/MM/YYYY + menyimpan komponen kalender langsung tanpa pergeseran zona waktu UTC. | **CLOSED** |
| **H2** | HIGH | Trimming loop 0..4 trailing bytes di `detectEncoding` untuk multibyte UTF-8 yang terpotong pada batas chunk 64 KiB. | **CLOSED** |
| **W1** | BLOCKER | Menghilangkan dual-consumer stdin (`readline` + raw data listener), menggunakan antrean asinkron baris `nextLine()`, dan muting `_writeToOutput` pada password. | **CLOSED** |
