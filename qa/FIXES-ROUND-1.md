# Perbaikan & Mitigasi Round 1

Tanggal: 2026-11-01  
Pelaksana: Agent Antigravity  
Status: **SELESAI & DIVERIFIKASI**

---

## Rincian Mitigasi Temuan Round 1

### 1. Perbaikan B1 (BLOCKER: Clobbering Nilai .env)
- **File**: `src/config.ts`
- **Tindakan**:
  - Menghapus spread `...overrides` pada return `Settings.fromEnv`.
  - Fungsi `pick()` sudah memprioritaskan override yang terdefinisi (`!== undefined`) dan melakukan fallback ke `env`.
  - Menambahkan regression test di `tests/config.test.ts` yang memverifikasi bahwa objek override dengan nilai `undefined` tidak menimpa nilai dari environment variables.

### 2. Perbaikan H1 (HIGH: Format Tanggal & Timezone Drift)
- **File**: `src/mapping.ts`
- **Tindakan**:
  - Mengimplementasikan `DEFAULT_DATE_FORMATS` dengan memprioritaskan format hari duluan:
    `"%Y-%m-%d"`, `"%Y-%m-%dT%H:%M:%S"`, `"%Y-%m-%d %H:%M:%S"`, `"%d/%m/%Y"`, `"%d-%m-%Y"`, `"%d.%m.%Y"`, `"%Y/%m/%d"`, `"%d/%m/%y"`, `"%m/%d/%Y"`, `"%Y%m%d"`.
  - Mendahulukan `spec.dateFormat` jika didefinisikan pada pemetaan field.
  - Menyimpan komponen kalender parsed (`year`, `month`, `day`, `hour`, `minute`, `second`) secara langsung tanpa konversi `toISOString()`.
  - Memvalidasi konsistensi hasil pengujian di bawah zona waktu ganda: `TZ=Asia/Jakarta` dan `TZ=America/Los_Angeles`.

### 3. Perbaikan H2 (HIGH: Deteksi Encoding UTF-8 Multibyte)
- **File**: `src/csv-source.ts`
- **Tindakan**:
  - Mengimplementasikan loop pemotongan (trimming) 0..4 trailing bytes pada buffer sampel 64 KiB di `detectEncoding`.
  - Mencegah error decoding saat karakter multibyte (misalnya simbol € 3-byte) terpotong di akhir batas buffer pembacaan.
  - Menambahkan regression test di `tests/csv-source.test.ts`.

### 4. Perbaikan M1 & M2 (Encoding Aliases & CSV Export BOM)
- **File**: `src/csv-source.ts`, `src/export.ts`
- **Tindakan**:
  - Normalisasi nama encoding: `utf-8-sig`, `cp1252`, `windows-1252`, `iso-8859-1`.
  - Menghapus BOM UTF-8 (`\ufeff`) secara otomatis saat membaca file CSV.
  - `CsvSink` menulis UTF-8 BOM (`\ufeff`) secara default ke file output ekspor untuk kompatibilitas penuh dengan Microsoft Excel.

### 5. Perbaikan M3 (Streaming Memory O(1))
- **File**: `src/csv-source.ts`, `src/export.ts`
- **Tindakan**:
  - `loadHeaderSync()` diubah hanya membaca chunk pertama (64 KiB) untuk mengambil baris header tanpa membaca seluruh file ke memori.
  - `XlsxSink` dimigrasikan menggunakan `ExcelJS.stream.xlsx.WorkbookWriter` dengan pemanggilan `row.commit()` untuk streaming baris langsung ke disk.

### 6. Perbaikan M5 (Validasi Flag Numerik CLI)
- **File**: `src/cli.ts`
- **Tindakan**:
  - Menggunakan parser `asInt` dan `asFloat` untuk seluruh opsi numerik CLI (`--batch-size`, `--timeout`, `--max-retries`, `--limit`, `--page-size`, dll.).
  - Melempar `ConfigError` dengan exit code 2 dan pesan error jelas saat argumen non-numerik diberikan.

### 7. Perbaikan M6 (Presisi Decimal)
- **File**: `src/mapping.ts`
- **Tindakan**:
  - `parseDecimal` mengembalikan string angka ternormalisasi (mis. `"1234.56"`), mempertahankan presisi tanpa distorsi floating-point IEEE 754 dan sesuai dengan format JSON OData v4.

### 8. Perbaikan M7, M9, & Temuan Low (L3 - L7)
- Menambahkan test suite baru dari `test_pipeline.py` (total test naik menjadi 37).
- Membuat `.gitignore` untuk mengabaikan `node_modules/`, `dist/`, `.env`, `*.log`, dll.
- Menambahkan `engines: { "node": ">=20.0.0" }` di `package.json`.
- Menambahkan `views: [{ state: "frozen", ySplit: 1 }]` pada ekspor XLSX (L3).
- Menambahkan peringatan konsol saat record yang ada di server memiliki key ganda (L5).
- Hanya mencetak `Report: <path>` jika file ada dan baris diproses (L6).
- Memberikan warning saat `--encoding` atau `--delimiter` dipasangkan dengan file Excel `.xlsx` (L7).
