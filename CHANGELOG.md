# Changelog

Semua perubahan penting pada proyek ini dicatat di berkas ini.

Format mengikuti [Keep a Changelog](https://keepachangelog.com/id-ID/1.1.0/), dan penomoran versi mengikuti [Semantic Versioning](https://semver.org/lang/id/) (`MAJOR.MINOR.PATCH`).

> Tanggal rilis di bawah memakai tanggal tag git (waktu lokal, UTC+7). Timestamp publikasi npm memakai UTC, sehingga dapat tercatat satu hari lebih awal — misalnya `1.1.0` terbit `2026-11-05T18:53Z` di registry.

## [Unreleased]

### Diubah

- README: menambahkan bagian perintah `template` (Indonesia dan English), memperbarui baris referensi perintah, menyesuaikan versi ke 1.1.0 dan jumlah tes ke 57.

## [1.1.0] - 2026-11-06

### Ditambahkan

- Perintah `template`: menghasilkan template impor CSV atau XLSX langsung dari `$metadata`, dengan opsi `--with-mapping` untuk sekaligus menulis `mapping.json`, `--sample` untuk satu baris contoh, `--key` untuk kolom kunci, `--include-system` untuk menyertakan kolom sistem, `--lookup-key` untuk memilih field pencocokan lookup, serta `--delimiter` dan `--no-bom` untuk CSV.
- Kolom lookup memakai nama navigasi tanpa akhiran `Id` (`Owner`, `Account`, `Type`) dan diisi label/nama rekaman; mapping yang dihasilkan menerjemahkannya ke properti OData asli melalui `lookup.key` (default `Name`).
- Output XLSX berisi dua sheet: sheet data (header + baris contoh opsional) dan sheet `schema` (`header`, `target`, `edm_type`, `nullable`, `max_length`, `lookup_entity`).
- `parseCsdlFieldDetails()` dan `ODataClient.entityFieldDetails()`: membaca `Nullable`, `MaxLength`, `Key`, dan `NavigationProperty` dari metadata, sehingga lookup dapat dikenali dari metadata tanpa konfigurasi manual.
- 15 tes baru: 14 tes template dan 1 tes regresi versi (total 57).

### Diubah

- Format keluaran `template` ditentukan dari ekstensi `--out` (`.csv` atau `.xlsx`); tidak ada flag `--format` terpisah.
- `parseCsdlEntityFields()` kini diturunkan dari `parseCsdlFieldDetails()`, dengan API dan bentuk hasil yang tetap sama.

### Diperbaiki

- `--version` selalu melaporkan `1.0.0` karena nomor versi ditulis mati di kode. Sekarang dibaca dari `package.json` saat runtime, sehingga selalu sesuai versi paket yang terpasang.

## [1.0.1] - 2026-11-05

### Diperbaiki

- Hint akhir wizard mencetak `npx csmt check`, yang selalu gagal karena tidak ada paket bernama `csmt` di registry. Sekarang mencetak `npx csmt-nodejs check --env-file <path>`.
- `schema` (dan turunannya) gagal dengan pesan `An error has occurred.` pada Creatio .NET Framework. Penyebabnya `$metadata` diminta dengan `Accept: application/json`, padahal platform tersebut tidak mendukung JSON metadata (`The JSON metadata is not supported at this platform`). Permintaan metadata kini memakai `Accept: application/xml`. Perbaikan ini juga menyembuhkan `import --validate-fields` dan `init-mapping` yang membaca metadata.

## [1.0.0] - 2026-11-03

### Ditambahkan

- Rilis publik pertama `csmt-nodejs` dengan perintah `wizard`, `check`, `schema`, `init-mapping`, `import`, dan `export`.
- Impor CSV/XLSX ke Creatio melalui OData 4 dengan mode `create`, `update`, dan `upsert`, termasuk dukungan multi-key.
- Jurnal resume per baris fisik (JSONL) beserta verifikasi kunci, sehingga impor dapat dilanjutkan tanpa mengulang baris yang sudah sukses.
- Pengelompokan `$batch` maksimum 100 sub-request sesuai batasan Creatio, dengan `Prefer: continue-on-error`.
- Proteksi retry: POST/create tidak pernah dikirim ulang secara buta pada galat transport maupun 5xx/timeout.
- Caching lookup per-run dan negative caching untuk lookup yang tidak ditemukan.
- Streaming paging dengan konsumsi memori datar, termasuk ExcelJS streaming workbook writer untuk ekspor.
- Ekspor ke CSV/XLSX dengan filter, `--select`, `--orderby`, dan ekspansi lookup (`--expand-lookups`) menjadi teks nama.
- Deteksi otomatis format: CSV (UTF-8, UTF-8-BOM, CP1252/Latin-1) dan Excel `.xlsx`/`.xlsm`, termasuk pemilihan sheet dan baris header.
- Jalur audit: laporan akhir CSV, ringkasan JSON, dan jurnal JSONL per baris.
- Autentikasi OAuth 2.0 client credentials, `forms`, dan `basic`, plus perintah `wizard` yang menulis `.env` dengan izin `0600`.

## [0.0.0-stage] - 2026-11-03

### Ditambahkan

- Publikasi bertahap pertama untuk menguji pipeline rilis npm. Bukan rilis fungsional; gunakan `1.0.0` atau lebih baru.

[Unreleased]: https://github.com/cokkyturnip/csmt-nodejs/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/cokkyturnip/csmt-nodejs/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/cokkyturnip/csmt-nodejs/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/cokkyturnip/csmt-nodejs/releases/tag/v1.0.0
[0.0.0-stage]: https://www.npmjs.com/package/csmt-nodejs/v/0.0.0-stage
