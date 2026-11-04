# CSMT (Node.js) — Creatio Simple Migration Toolkit

[![npm version](https://img.shields.io/npm/v/csmt-nodejs.svg?color=cb3837)](https://www.npmjs.com/package/csmt-nodejs)
[![CI Tests](https://img.shields.io/badge/tests-42%20passed-brightgreen.svg)](https://github.com/cokkyturnip/csmt-nodejs/tree/main/tests)
[![Node.js Version](https://img.shields.io/badge/node-≥%2020.0.0-blue.svg)](https://github.com/cokkyturnip/csmt-nodejs/blob/main/package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/cokkyturnip/csmt-nodejs/blob/main/LICENSE)

> **Navigasi Bahasa / Language Navigation:**  
> 🇮🇩 [Bahasa Indonesia](#-bahasa-indonesia) | 🇬🇧 [English](#-english)  
> 🐍 **Python Version:** Versi asli Python tersedia di [github.com/cokkyturnip/creatio-simple-migration-toolkit](https://github.com/cokkyturnip/creatio-simple-migration-toolkit)

---

## 🇮🇩 Bahasa Indonesia

Toolkit CLI dan library Node.js / TypeScript berkinerja tinggi untuk memindahkan data *spreadsheet* (CSV / XLSX) ke Creatio dan sebaliknya melalui antarmuka resmi OData 4.

```text
┌────────────────────────┐                               ┌────────────────────────┐
│   Spreadsheet Lokal    │      ⚡ Impor (Upsert)        │    Creatio Platform    │
│   • CSV (Auto-Delim)   │ ────────────────────────────► │   • OData 4 Service    │
│   • Excel XLSX / XLSM  │ ◄──────────────────────────── │   • 1.800+ Collections │
└────────────────────────┘      📤 Ekspor (+ Lookups)    └────────────────────────┘
            ▲                                                        │
            │           🛡️ Jurnal Resume & Audit Per Baris           │
            └────────────────────────────────────────────────────────┘
```

- ⚡ **Impor Cepat & Aman**: Memuat CSV/Excel ke entitas Creatio (`create`, `update`, `upsert`) dengan validasi skema di awal, auto-batching 100 baris, dan proteksi anti-duplikasi.
- 📤 **Ekspor Kaya Konteks**: Menarik data OData ke CSV/Excel dengan filter kustom dan otomatis menerjemahkan GUID relasi *lookup* menjadi teks nama yang mudah dibaca.
- 🔄 **Resume Bebas Pusing**: Jika jaringan terputus di tengah jalan, lanjutkan secara instan tanpa mengulang baris yang telah sukses berkat pencatatan jurnal per baris fisik.
- 🛡️ **Zero-Trust & Full Audit**: Berjalan 100% di perimeter lokal klien — vendor tidak pernah menyentuh data mentah, dan setiap baris tercatat status serta kode HTTP-nya.

| Informasi | Spesifikasi |
|---|---|
| **Versi** | 1.0.0 |
| **Kebutuhan Runtime** | Node.js ≥ 20.0.0 (Modern ESM, TypeScript 5.x) |
| **Dependensi Inti** | `commander`, `csv-parse`, `csv-stringify`, `exceljs`, `fast-xml-parser` |
| **Status Pengujian** | 42 unit & integration tests lulus (0 fail, 0 hang) di 3 zona waktu |
| **Versi Python** | Versi asli Python tersedia di [creatio-simple-migration-toolkit](https://github.com/cokkyturnip/creatio-simple-migration-toolkit) |
| **Lisensi** | MIT |

---

### Mengapa CSMT: Menyelesaikan Masalah Import Bawaan

Banyak proyek Creatio mengandalkan fitur impor berkas bawaan di antarmuka web untuk *bulk load*. Pola umum yang sering terjadi: klien mengekspor data mentah ke berkas, lalu menyerahkan berkas tersebut ke pihak ketiga (vendor atau konsultan) untuk diunggah.

Pola ini memicu dua masalah tata kelola data:
1. **Risiko Kebocoran Data Pribadi**: Sekali berkas diserahkan ke pihak luar, hak akses tidak lagi dapat diaudit atau dicabut. Salinan berkas rawan tersebar melalui email atau media penyimpanan fisik.
2. **Kekhawatiran Egress API yang Berlebihan**: Sering kali terdapat kekhawatiran bahwa integrasi API memakan kuota bandwidth yang masif. Padahal, 100.000 baris × ±400 byte hanya berukuran ~40 MB. Biaya sebenarnya ada pada kegagalan transaksi yang harus diulang dari awal.

Selain tata kelola, fitur impor web bawaan memiliki keterbatasan teknis:
- Tidak ada validasi pra-unggah (data rusak baru terdeteksi di tengah jalan).
- Tidak ada jaminan idempotensi (unggah ulang berisiko menimbulkan data duplikat).
- Tidak dapat melanjutkan (*resume*) proses saat koneksi jaringan terputus.
- Tidak ada berkas audit mendalam per baris.

**Pendekatan CSMT:**
CSMT dijalankan **di dalam perimeter keamanan klien** (laptop internal atau VM privat) dan berbicara langsung ke Creatio melalui OAuth 2.0. Vendor hanya perlu menyerahkan berkas `mapping.json` dan kode biner toolkit — **tanpa pernah memegang data aktual klien**. Akses API dapat dicabut sewaktu-waktu dengan me-rotate *client secret*.

---

### Fitur Utama & Jaminan Teknis

1. **Aman Diulang Tanpa Duplikat (`--mode upsert`)**: Mencocokkan rekaman berdasarkan kunci primer/unik (mendukung *multi-key* dan relasi *lookup*).
2. **Resume Berbasis Jurnal Fisik**: Mencatat kemajuan per baris fisik berkas ke dalam jurnal JSONL beserta verifikasi kunci.
3. **Pengelompokan Batch Sesuai Batasan Creatio**: Membatasi `$batch` tepat maksimum 100 sub-request sesuai batasan resmi Creatio (`Prefer: continue-on-error`).
4. **Proteksi Kegagalan Jaringan (No Blind POST Retry)**: Operasi POST / create tidak pernah dikirim ulang secara membabi-buta saat terjadi galat transport atau 5xx/timeout.
5. **Lookup Caching & Negative Caching**: Caching per-run untuk lookup ID dan negative caching untuk record lookup yang tidak ditemukan.
6. **Streaming Paging O(1) Memory**: Menggunakan generator async dan ExcelJS streaming workbook writer untuk efisiensi memori datar.
7. **Deteksi Otomatis & Fleksibilitas Format**: Mendukung CSV (UTF-8, UTF-8-BOM, CP1252/Latin-1) dan spreadsheet Microsoft Excel `.xlsx` / `.xlsm`.
8. **Jalur Audit Lengkap**: Laporan akhir CSV, ringkasan JSON, dan jurnal JSONL dengan rincian per baris.

---

### Instalasi & Pemakaian

#### Opsi 1: Tanpa Instalasi (Rekomendasi via `npx`)
Anda dapat langsung mengeksekusi toolkit ini tanpa perlu mengunduh repositori:
```bash
npx csmt-nodejs wizard
```

#### Opsi 2: Pasang Global (CLI Standar)
Pasang secara global untuk mendapatkan perintah `csmt` langsung di terminal Anda:
```bash
npm install -g csmt-nodejs
csmt --help
```

#### Opsi 3: Pasang sebagai Library Proyek
Gunakan modul migration toolkit langsung di dalam aplikasi TypeScript / JavaScript Anda:
```bash
npm install csmt-nodejs
```

#### Opsi 4: Kloning Repositori (Bagi Developer / Kontributor)
```bash
git clone https://github.com/cokkyturnip/csmt-nodejs.git
cd csmt-nodejs
npm install
npm run build
npm test
```

---

### Panduan Mulai Cepat (Quickstart)

```bash
# 1. Konfigurasi interaktif (menulis file .env dengan izin 0600)
npx csmt-nodejs wizard

# 2. Uji koneksi, autentikasi, dan hak akses entitas
npx csmt-nodejs check --entity Contact

# 3. Inspeksi skema entitas Creatio dari metadata OData
npx csmt-nodejs schema --entity Contact

# 4. Generate kerangka file mapping awal dari header CSV
npx csmt-nodejs init-mapping --csv data.csv --entity Contact --key Email --out mapping.json

# 5. Uji simulasi (Dry Run) — memvalidasi pemetaan tanpa menulis ke Creatio
npx csmt-nodejs import --csv data.csv --mapping mapping.json --dry-run --validate-fields

# 6. Eksekusi impor aktual (mode upsert dengan pengelompokan batch 50 baris)
npx csmt-nodejs import --csv data.csv --mapping mapping.json --mode upsert --batch-size 50

# 7. Jika koneksi terputus di tengah jalan, lanjutkan secara aman:
npx csmt-nodejs import --csv data.csv --mapping mapping.json --mode upsert --resume
```

#### Contoh Ekspor Data

```bash
# Ekspor rekaman ke CSV dengan ekspansi GUID lookup menjadi nama teks (default BOM UTF-8)
npx csmt-nodejs export --entity Contact --out contacts.csv \
    --select Name,Email,CountryId --expand-lookups CountryId=Country.Name

# Ekspor rekaman ke Excel XLSX dengan filter tanggal dan pengurutan
npx csmt-nodejs export --entity Contact --out contacts.xlsx \
    --filter "CreatedOn ge 2026-01-01" --orderby "CreatedOn desc"
```

---

### Referensi Perintah CLI

| Perintah | Deskripsi |
|---|---|
| `wizard` | Asisten konfigurasi interaktif untuk menghasilkan `.env` (URL, autentikasi, kredensial). |
| `check` | Memverifikasi ketersediaan endpoint OData, validitas token/kredensial, dan izin entitas. |
| `schema` | Menampilkan seluruh field dan tipe data EDM dari entitas berdasarkan `$metadata`. |
| `init-mapping` | Membaca header berkas CSV/XLSX dan menghasilkan kerangka `mapping.json`. |
| `import` | Memproses impor data ke Creatio (`create`, `update`, `upsert`, batch, resume, audit). |
| `export` | Mengunduh rekaman dari Creatio ke format CSV atau XLSX. |

**Kode Keluar (Exit Codes):**
- `0`: Sukses penuh (seluruh baris berhasil diproses).
- `1`: Selesai dengan catatan (terdapat baris yang gagal atau berstatus `unknown`).
- `2`: Kesalahan konfigurasi, argumen CLI tidak valid, atau koneksi ditolak.
- `130`: Proses dibatalkan oleh pengguna via interupsi terminal (`Ctrl+C`).

---
---

## 🇬🇧 English

High-performance Node.js / TypeScript CLI toolkit and library to migrate spreadsheet (CSV / XLSX) data to and from Creatio through the official OData 4 interface.

```text
┌────────────────────────┐                               ┌────────────────────────┐
│   Local Spreadsheets   │      ⚡ Ingest (Upsert)       │    Creatio Platform    │
│   • CSV (Auto-Detect)  │ ────────────────────────────► │   • OData 4 Service    │
│   • Excel XLSX / XLSM  │ ◄──────────────────────────── │   • 1,800+ Collections │
└────────────────────────┘      📤 Extract (+ Lookups)   └────────────────────────┘
            ▲                                                        │
            │         🛡️ Zero-Data-Leak Resume & Audit Trails        │
            └────────────────────────────────────────────────────────┘
```

- ⚡ **High-Speed Idempotent Import**: Ingests CSV/Excel into Creatio entities (`create`, `update`, `upsert`) with pre-flight type checking, 100-record batching, and zero duplicate creation.
- 📤 **Context-Aware Export**: Extracts OData records to CSV/Excel with dynamic filters and automatic conversion of raw lookup GUIDs into readable text captions.
- 🔄 **Fault-Tolerant Resume**: Recovers instantly from network interruptions without duplicating or skipping records via physical row-level journaling.
- 🛡️ **Zero-Trust Client Perimeter**: Runs 100% locally — OAuth 2.0 credentials stay secure, business data never leaves your environment, and every row produces an audit trail.

| Detail | Specification |
|---|---|
| **Version** | 1.0.0 |
| **Runtime Requirements** | Node.js ≥ 20.0.0 (Modern ESM, TypeScript 5.x) |
| **Core Dependencies** | `commander`, `csv-parse`, `csv-stringify`, `exceljs`, `fast-xml-parser` |
| **Test Verification** | 42 automated unit & integration tests passing (0 failures, 0 hangs) across 3 timezones |
| **Python Version** | Original Python implementation available at [creatio-simple-migration-toolkit](https://github.com/cokkyturnip/creatio-simple-migration-toolkit) |
| **License** | MIT |

---

### Why CSMT: Solving the Built-in Import Bottleneck

Many Creatio implementations rely on the web interface's built-in file import tool for bulk migration. In enterprise settings, this frequently leads to an unsafe operational pattern: the client extracts sensitive operational data to a spreadsheet, which is then handed off to external implementation partners or contractors.

This workflow presents critical governance and reliability challenges:
1. **PII and Data Exposure**: Once a spreadsheet leaves client infrastructure, access controls, audit logs, and instant revocation are lost. Copies easily proliferate across untracked emails and external drives.
2. **Exaggerated Egress Concerns**: While direct API pipelines are sometimes feared for consuming bandwidth, 100,000 rows × ±400 bytes is only ~40 MB. The genuine operational cost stems from failed batches requiring complete restarts.

Furthermore, built-in browser imports lack strict transactional guarantees:
- No pre-upload schema validation (corrupted formats fail mid-run).
- No guaranteed idempotency (accidental re-runs introduce duplicate records).
- No fault-tolerant resume mechanism when network interruptions occur.
- No granular, row-by-row audit reporting.

**The CSMT Architecture:**
CSMT executes **entirely inside the client's trusted perimeter** (a secure workstation, private VM, or self-hosted CI runner) communicating directly with Creatio over authenticated OAuth 2.0 endpoints. External vendors supply only the configuration (`mapping.json`) and the toolkit binary — **never the actual business data**. API access can be terminated immediately by rotating the client secret.

---

### Installation & Build

```bash
git clone https://github.com/cokkyturnip/csmt-nodejs.git
cd creatio-csv-import-nodejs

# Install dependencies
npm install

# Compile TypeScript to JavaScript (dist/)
npm run build

# Run all 42 automated tests
npm test
```

---

### Quickstart Guide

```bash
# 1. Interactive configuration wizard (creates .env with 0600 file permissions)
npx csmt-nodejs wizard

# 2. Check connection, credentials, and entity access permissions
npx csmt-nodejs check --entity Contact

# 3. Inspect target entity EDM schema directly from OData $metadata
npx csmt-nodejs schema --entity Contact

# 4. Generate an initial mapping template from source file headers
npx csmt-nodejs init-mapping --csv data.csv --entity Contact --key Email --out mapping.json

# 5. Dry-run simulation — validates mapping and data types without writing to Creatio
npx csmt-nodejs import --csv data.csv --mapping mapping.json --dry-run --validate-fields

# 6. Execute actual import in upsert mode with batch chunks of 50 records
npx csmt-nodejs import --csv data.csv --mapping mapping.json --mode upsert --batch-size 50

# 7. If interrupted, resume seamlessly without duplicating processed rows
npx csmt-nodejs import --csv data.csv --mapping mapping.json --mode upsert --resume
```

#### Export Examples

```bash
# Export records to CSV with UTF-8 BOM, resolving CountryId lookup GUIDs to Country names
npx csmt-nodejs export --entity Contact --out contacts.csv \
    --select Name,Email,CountryId --expand-lookups CountryId=Country.Name

# Export records to Excel XLSX with custom OData filters and ordering
npx csmt-nodejs export --entity Contact --out contacts.xlsx \
    --filter "CreatedOn ge 2026-01-01" --orderby "CreatedOn desc"
```

---

### CLI Command Reference

| Command | Purpose |
|---|---|
| `wizard` | Interactive setup to configure credentials and generate `.env`. |
| `check` | Verifies OData endpoint availability, authentication, and entity read access. |
| `schema` | Inspects and lists all available entity attributes and EDM data types. |
| `init-mapping` | Scaffolds a starter `mapping.json` from spreadsheet headers. |
| `import` | Executes migration pipeline (`create`/`update`/`upsert`, batch, resume, audit). |
| `export` | Extracts Creatio records to CSV or Excel with lookup resolution. |

**Process Exit Codes:**
- `0`: Complete success (all records processed without failure).
- `1`: Completed with errors (one or more records failed or ended with `unknown` status).
- `2`: Configuration error, invalid CLI flags, or network connection failure.
- `130`: Interrupted by user signal (`Ctrl+C`).
